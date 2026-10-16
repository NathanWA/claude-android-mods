import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, ToolCallResult } from 'claude-code'

import type { BuildError, LastBuild, LastFailure } from '../types'

import { analyzeCommand, runsTests, taskModuleDir, isTestTask } from './command'
import { CLASSIFY_HINTS, buildDigest, fileLines, fixHints, type ModuleTests } from './digest'
import { cleanLines, failingTask, parseOutput, type ParsedOutput } from './parse'
import { join, relativeTo, resolve } from './paths'
import { registerPane } from './pane'
import { collectTests } from './test-results'

/** The longest a foreground Bash call may run; Gradle gets all of it. */
const FOREGROUND_MS = 600_000
/** A passing run this small reads fine as it is. */
const SMALL_LINES = 60
const SMALL_CHARS = 6_000
const LOG = 'build/build-output-distiller/last-run.log'

// Defined where they are used: `claude plugin validate` reads each module's
// state references from that module's own source.
const lastFailure = atom({ plugin: 'build-output-distiller', key: 'lastFailure' } as const, null as LastFailure | null)
const lastBuild = atom({ plugin: 'build-output-distiller', key: 'lastBuild' } as const, null as LastBuild | null)

type RawOutput = { text: string; isError: boolean; exitCode?: number; savedAt?: string }

export const register: Register = on => {
  registerPane(on)

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const command = analyzeCommand(e.command)
    if (command === undefined || command.isPassthrough) return next(e)

    const startedAt = await $.clock.now()
    const ran = await next({
      ...e,
      command: await sameVerdict($, e.command, command.rewritten),
      timeout: FOREGROUND_MS,
      run_in_background: false,
    })
    if (ran.deny !== undefined) return ran

    const raw = await rawOutput($, ran)
    if (raw === undefined) return ran

    const parsed = parseOutput(raw.text)
    const isFailed = raw.isError || parsed.outcome === 'failed'
    const isRecognized = parsed.outcome !== 'unknown' || parsed.errors.length > 0 || parsed.wentWrong.length > 0
    if (!isRecognized) return ran

    const cwd = await $.session.cwd()
    const root = command.workDir === undefined ? cwd : resolve(cwd, command.workDir)
    const rel = (path: string) => relativeTo(cwd, path)

    let tests: ModuleTests[] | undefined
    if (command.tasks.some(runsTests) || parsed.testModuleDirs.length > 0 || parsed.testReportDirs.length > 0) {
      const asked = command.tasks.filter(isTestTask).map(task => taskModuleDir(task))
      tests = await collectTests($, {
        root,
        cwd,
        since: startedAt,
        moduleDirs: [...parsed.testModuleDirs, ...asked.filter((dir): dir is string => dir !== undefined)],
        reportDirs: parsed.testReportDirs,
      })
      // Failing tests with no new XML to read: the console is all there is.
      if (tests.length === 0 && parsed.hasFailingTests && parsed.errors.length === 0) return ran
    }

    const isSmall = parsed.lineCount <= SMALL_LINES && raw.text.length <= SMALL_CHARS
    if (!isFailed && isSmall) return ran

    const errors = [...parsed.errors.map(error => relativeError(error, rel)), ...testErrors(tests ?? [])]
    const logPath = raw.savedAt ?? (await saveLog($, root, raw.text).then(path => path && rel(path)))
    const digest = buildDigest({ parsed, isFailed, exitCode: raw.exitCode, errors, tests, logPath })

    const context: string[] = []
    if (isFailed) {
      const repeated = await noteFailure($, parsed, errors)
      if (repeated !== undefined) context.push(repeated)

      const spots = fileLines(errors)
      context.push(
        spots.length > 0
          ? `build-output-distiller: files to open, in order: ${spots.slice(0, 15).join(', ')}`
          : 'build-output-distiller: the output names no source file; start from "What went wrong".',
      )
      const hints = fixHints(errors, parsed)
      if (hints.length === 0 && errors.length === 0) {
        const guess = await classify($, parsed, raw.text)
        if (guess !== undefined) hints.push(guess)
      }
      if (hints.length > 0) context.push(`build-output-distiller fix hints:\n${hints.map(hint => `- ${hint}`).join('\n')}`)
    } else if ((await read($, lastFailure)) !== null) {
      await update($, lastFailure, () => null)
    }

    await update($, lastBuild, () => ({
      command: e.command,
      headline: digest.split('\n')[0] ?? '',
      isFailed,
      errors: errors.slice(0, 50),
      at: startedAt,
    }))

    // A fresh record: `ran` carries core's `ref`, and core would use that
    // run's own output in place of this one.
    if (ran.isError) {
      return { result: { stdout: digest, stderr: '', interrupted: false }, context }
    }
    const { persistedOutputPath, persistedOutputSize, rawOutputPath, ...record } = ran.result
    return {
      result: { ...record, stdout: digest, stderr: '' },
      ...(context.length > 0 ? { context } : {}),
    }
  }).catch(($, e, next) => next(e))
}

/** The whole console output of the call, or undefined when it is not a
 * finished foreground run (backgrounded, timed out, an image). */
async function rawOutput($: EngineInterface, ran: ToolCallResult<'Bash'>): Promise<RawOutput | undefined> {
  if (ran.deny !== undefined) return undefined
  if (ran.isError) {
    const stored = typeof ran.result === 'string' ? ran.result : ''
    const shown = ran.text ?? ''
    const savedAt = /Full output saved to: (\S+)/.exec(`${shown}\n${stored}`)?.[1]
    const saved = savedAt === undefined ? undefined : await $.fs.read(savedAt).catch(() => undefined)
    const text = typeof saved === 'string' ? saved : stored.length >= shown.length ? stored : shown
    const exitCode = /^Exit code (\d+)/m.exec(`${shown}\n${stored}`)?.[1]
    return { text, isError: true, exitCode: exitCode === undefined ? undefined : Number(exitCode), savedAt: typeof saved === 'string' ? savedAt : undefined }
  }

  const record = ran.result
  if (record.backgroundTaskId !== undefined || record.timedOutAfterMs !== undefined || record.interrupted || record.isImage) {
    return undefined
  }
  if (record.persistedOutputPath !== undefined) {
    const saved = await $.fs.read(record.persistedOutputPath).catch(() => undefined)
    if (typeof saved === 'string') return { text: saved, isError: false, savedAt: record.persistedOutputPath }
  }
  return { text: record.stderr ? `${record.stdout}\n${record.stderr}` : record.stdout, isError: false }
}

/** `rewritten` when the permission rules treat it as they treat `original`
 * (an exact-match rule would not match the appended flag), else `original`.
 * A `$.tool.check` query runs no settings hook, so asking has no side effect. */
async function sameVerdict($: EngineInterface, original: string, rewritten: string): Promise<string> {
  if (rewritten === original) return original
  const verdicts = await Promise.all([
    $.tool.check({ tool: 'Bash', input: { command: original } }),
    $.tool.check({ tool: 'Bash', input: { command: rewritten } }),
  ]).catch(() => undefined)
  return verdicts !== undefined && verdicts[0].decision === verdicts[1].decision ? rewritten : original
}

/** Records this failure; the context line to add when it is the last one again. */
async function noteFailure($: EngineInterface, parsed: ParsedOutput, errors: BuildError[]): Promise<string | undefined> {
  const task = failingTask(parsed)
  const first = errors[0]
  const firstError = first
    ? `${first.file ? `${first.file}: ` : ''}${first.message}`
    : (parsed.wentWrong[0]?.find(line => line.trim() !== '') ?? 'no error line').trim()
  const hash = fnv1a(`${task}\n${first?.kind ?? ''}\n${first?.file ?? ''}\n${first?.message ?? firstError}`)

  const previous = await read($, lastFailure)
  const repeats = previous !== null && previous.hash === hash ? previous.repeats + 1 : 0
  await update($, lastFailure, () => ({ hash, task, firstError, repeats }))
  if (repeats === 0) return undefined

  $.ui.toast(`Same Gradle failure again (${repeats + 1} runs in a row): ${task}`)
  return (
    `build-output-distiller: the last fix did not take. This is the same failure as the previous Gradle run` +
    `${repeats > 1 ? ` (${repeats + 1} runs in a row)` : ''}: ${task}: ${firstError.replace(/\.$/, '')}. ` +
    `Re-read the code at that location and reconsider the cause before editing again.`
  )
}

/** One label from the model, for a failure no pattern explains. */
async function classify($: EngineInterface, parsed: ParsedOutput, text: string): Promise<string | undefined> {
  const evidence = parsed.wentWrong.length > 0 ? parsed.wentWrong.flat().join('\n') : cleanLines(text).slice(-40).join('\n')
  const label = await $.model.classify(evidence.slice(0, 4_000), Object.keys(CLASSIFY_HINTS)).catch(() => undefined)
  return label === undefined ? undefined : CLASSIFY_HINTS[label]
}

/** Writes the whole output under the project's build directory; its path, or
 * undefined when it could not be written. */
async function saveLog($: EngineInterface, root: string, text: string): Promise<string | undefined> {
  const path = join(root, LOG)
  return $.fs.write(path, text).then(
    () => path,
    () => undefined,
  )
}

function relativeError(error: BuildError, rel: (path: string) => string): BuildError {
  return error.file === undefined ? error : { ...error, file: rel(error.file) }
}

function testErrors(tests: ModuleTests[]): BuildError[] {
  return tests.flatMap(module =>
    module.failures.map(failure => ({
      kind: 'test' as const,
      file: failure.path ?? failure.file,
      line: failure.line,
      message: `${failure.className} > ${failure.name}: ${failure.message}`,
      detail: failure.trace.slice(1, 6),
    })),
  )
}

function fnv1a(text: string): string {
  let hash = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(16).padStart(8, '0')
}
