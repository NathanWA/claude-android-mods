// Parses a Gradle run's console output into the errors an Android build
// reports: Kotlin, javac/kapt, KSP, Hilt/Dagger, Room, AAPT, R8, the
// manifest merger, file:line lint tools, and Gradle's own failure blocks.

import type { BuildError, BuildErrorKind } from '../types'

import { isTestTask, taskModuleDir } from './command'

export type ParsedOutput = {
  outcome: 'failed' | 'passed' | 'unknown'
  /** `14s`, `1m 3s`, from the BUILD line. */
  duration?: string
  /** `45 actionable tasks: 3 executed, 42 up-to-date`. */
  actionable?: string
  failedTasks: string[]
  errors: BuildError[]
  /** Each `* What went wrong:` block, its lines trimmed. */
  wentWrong: string[][]
  warnings: number
  /** The `missing_rules.txt` R8 wrote, when it did. */
  missingRules?: string
  /** Module directories a test report named (absolute). */
  testReportDirs: string[]
  /** Module directories (project-relative, `''` the root) whose test task ran. */
  testModuleDirs: string[]
  hasFailingTests: boolean
  /** Lines that are neither progress nor bookkeeping, for a passing digest. */
  other: string[]
  lineCount: number
}

const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]/g
const PATH = '((?:[A-Za-z]:)?[^:\\s][^:]*?)'

const KOTLIN = new RegExp(`^e: (?:file://)?${PATH}\\.(kts?):(\\d+):(\\d+):? (.+)$`)
const KOTLIN_OLD = new RegExp(`^e: (?:file://)?${PATH}\\.(kts?): \\((\\d+), (\\d+)\\): (.+)$`)
const KSP = new RegExp(`^e: \\[ksp\\] (?:(?:file://)?${PATH}\\.(kt|java):(\\d+): )?(.+)$`)
const JAVAC = new RegExp(`^(?:e: )?(?:file://)?${PATH}\\.java:(\\d+): error: (.+)$`)
const COMPILER_BARE = /^e: (?!\[ksp\])(.+)$/
const AAPT = new RegExp(`^(?:ERROR:\\s*)?${PATH}\\.(xml|png|webp|jpg):(?:(\\d+)(?::(\\d+)(?:-\\d+)?)?:)? AAPT: (?:error: )?(.+)$`)
const AAPT_BARE = /^(?:ERROR:\s*)?AAPT: (?:error: )?(.+)$/
const DUPLICATE_RESOURCE = /^(?:ERROR:\s*)?\[([^\]]+)\] (\S+?\.xml)\s.*Error: Duplicate resources$/
const R8_MISSING = /^(?:ERROR:\s*)?(?:R8:\s*)?Missing class (\S+?)(?: \(referenced from: (.+?)\))?\.?$/
const R8_RULES = /generated in (\S+missing_rules\.txt)/
const R8_ERROR = /^ERROR:\s*R8: (.+)$/
const MANIFEST = new RegExp(`^${PATH}AndroidManifest\\.xml:(\\d+):(\\d+)(?:-[\\d:]+)? Error:\\s*(.*)$`)
const LINT_LINE = /^(\/[^:\s][^:]*?\.(?:kt|kts|java|xml|gradle|toml)):(\d+)(?::(\d+))?: (?:(?:Error|error): )?(.+)$/
const TASK_LINE = /^> Task (\S+)(?: (FAILED|UP-TO-DATE|NO-SOURCE|SKIPPED|FROM-CACHE))?$/
const EXECUTION_FAILED = /^Execution failed for task '([^']+)'/
const BUILD_LINE = /^BUILD (FAILED|SUCCESSFUL) in (.+)$/
const ACTIONABLE = /^\d+ actionable tasks?: .+$/
const REPORT = /See the report at: (file:\/\/\S+)/
const WHERE = /^(?:Build file|Script|Settings file) '(.+)' line: (\d+)$/
const BLOCK_END = /^(\* (Try|Exception is|Get more help|Where|Query)|BUILD (FAILED|SUCCESSFUL)|={5,}|-{5,}|\d+: Task failed|FAILURE:)/

const ROOM =
  /There is a problem with the query|Cannot figure out how to (save|read)|Room cannot|Entities and POJOs|Not sure how to convert a Cursor|Schema export directory|no such (table|column)|Cannot find (getter|setter) for field|androidx\.room|@(Entity|Dao|Database|Query)\b/i
const DAGGER = /\[(Dagger|Hilt)[\]/]|@HiltAndroidApp|@AndroidEntryPoint|@InstallIn|dagger\.hilt/i

const NOISE = [
  /^> (Task|Configure|Transform) /,
  /^\s*$/,
  /^(Starting a Gradle Daemon|Reusing configuration cache|Configuration cache entry|Calculating task graph|Daemon will be stopped|Download(ing)? |Deprecated Gradle features|You can use '--warning-mode|For more on this|See https:\/\/docs\.gradle\.org|Note: )/,
  /<[-=]+> \d+%/,
  /^\s*\d+%\s/,
]

export function cleanLines(raw: string): string[] {
  return raw.replace(ANSI, '').replace(/\r\n?/g, '\n').split('\n')
}

export function parseOutput(raw: string): ParsedOutput {
  const lines = cleanLines(raw)
  const parsed: ParsedOutput = {
    outcome: 'unknown',
    failedTasks: [],
    errors: [],
    wentWrong: [],
    warnings: 0,
    testReportDirs: [],
    testModuleDirs: [],
    hasFailingTests: false,
    other: [],
    lineCount: lines.length,
  }
  const add = (error: BuildError) => {
    const isSeen = parsed.errors.some(
      one => one.file === error.file && one.line === error.line && one.message === error.message,
    )
    if (!isSeen) parsed.errors.push(error)
  }
  const addTask = (list: string[], value: string) => {
    if (!list.includes(value)) list.push(value)
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? ''
    const detail = () => indentedAfter(lines, i)
    let m: RegExpExecArray | null

    if ((m = BUILD_LINE.exec(line))) {
      parsed.outcome = m[1] === 'FAILED' ? 'failed' : 'passed'
      parsed.duration = m[2]
      continue
    }
    if (ACTIONABLE.test(line)) {
      parsed.actionable = line
      continue
    }
    if ((m = TASK_LINE.exec(line))) {
      const task = m[1] ?? ''
      if (m[2] === 'FAILED') addTask(parsed.failedTasks, task)
      if (isTestTask(task) && m[2] !== 'UP-TO-DATE' && m[2] !== 'NO-SOURCE' && m[2] !== 'SKIPPED') {
        addTask(parsed.testModuleDirs, taskModuleDir(task) ?? '')
        if (m[2] === 'FAILED') parsed.hasFailingTests = true
      }
      continue
    }
    if ((m = EXECUTION_FAILED.exec(line))) addTask(parsed.failedTasks, m[1] ?? '')
    if ((m = REPORT.exec(line))) {
      const path = safeDecode(m[1] ?? '').replace(/^file:\/\//, '')
      const at = path.indexOf('/build/reports/')
      if (at !== -1) addTask(parsed.testReportDirs, path.slice(0, at))
    }
    if (/There were failing tests|tests completed, \d+ failed/.test(line)) parsed.hasFailingTests = true
    if (line.startsWith('w: ') || /^warning: /.test(line)) {
      parsed.warnings++
      continue
    }

    if (line === '* What went wrong:') {
      const block: string[] = []
      for (let j = i + 1; j < lines.length && block.length < 20; j++) {
        const next = lines[j] ?? ''
        if (BLOCK_END.test(next)) break
        block.push(next.trimEnd())
      }
      while (block.length > 0 && (block[block.length - 1] ?? '').trim() === '') block.pop()
      while (block.length > 0 && (block[0] ?? '').trim() === '') block.shift()
      if (block.length > 0) parsed.wentWrong.push(block)
      continue
    }
    if ((m = WHERE.exec(line))) {
      const message = firstWentWrongAfter(lines, i) ?? 'Build script error'
      add({ kind: 'gradle', file: m[1], line: Number(m[2]), message })
      continue
    }

    if ((m = KSP.exec(line))) {
      const message = m[4] ?? ''
      const file = m[1] === undefined ? undefined : `${m[1]}.${m[2]}`
      add(withDetail({ kind: kindOf(message, 'ksp'), file, line: num(m[3]), message }, detail()))
      continue
    }
    if ((m = KOTLIN.exec(line)) || (m = KOTLIN_OLD.exec(line))) {
      const message = m[5] ?? ''
      add(
        withDetail(
          { kind: kindOf(message, 'kotlin'), file: `${m[1]}.${m[2]}`, line: num(m[3]), column: num(m[4]), message },
          detail(),
        ),
      )
      continue
    }
    if ((m = JAVAC.exec(line))) {
      const message = m[3] ?? ''
      add(withDetail({ kind: kindOf(message, 'java'), file: `${m[1]}.java`, line: num(m[2]), message }, detail()))
      continue
    }
    if ((m = MANIFEST.exec(line))) {
      const more = detail()
      const message = m[4] || more[0] || 'Manifest merger error'
      add(withDetail({ kind: 'manifest', file: `${m[1]}AndroidManifest.xml`, line: num(m[2]), column: num(m[3]), message }, m[4] ? more : more.slice(1)))
      continue
    }
    if ((m = AAPT.exec(line))) {
      add({ kind: 'aapt', file: `${m[1]}.${m[2]}`, line: num(m[3]), column: num(m[4]), message: m[5] ?? '' })
      continue
    }
    if ((m = DUPLICATE_RESOURCE.exec(line))) {
      add({ kind: 'aapt', file: m[2], message: `Duplicate resource ${m[1]}` })
      continue
    }
    if ((m = AAPT_BARE.exec(line))) {
      add({ kind: 'aapt', message: m[1] ?? '' })
      continue
    }
    if ((m = R8_RULES.exec(line))) parsed.missingRules = m[1]
    if ((m = R8_MISSING.exec(line))) {
      add({ kind: 'r8', message: `Missing class ${m[1]}${m[2] ? ` (referenced from ${m[2]})` : ''}` })
      continue
    }
    if ((m = R8_ERROR.exec(line))) {
      add({ kind: 'r8', message: m[1] ?? '' })
      continue
    }
    if ((m = COMPILER_BARE.exec(line))) {
      const message = m[1] ?? ''
      add(withDetail({ kind: kindOf(message, 'kotlin'), message }, detail()))
      continue
    }
    if ((m = LINT_LINE.exec(line))) {
      add({ kind: 'lint', file: m[1], line: num(m[2]), column: num(m[3]), message: m[4] ?? '' })
      continue
    }

    if (!NOISE.some(noise => noise.test(line))) parsed.other.push(line)
  }

  if (parsed.outcome === 'unknown' && parsed.wentWrong.length > 0) parsed.outcome = 'failed'
  return parsed
}

/** The kind a message's own words say, over the tool that printed it. */
export function kindOf(message: string, fallback: BuildErrorKind): BuildErrorKind {
  if (DAGGER.test(message)) return 'dagger'
  if (ROOM.test(message)) return 'room'
  return fallback
}

/** `[Dagger/MissingBinding] com.acme.Repo cannot be provided ...` -> `com.acme.Repo`. */
export function missingBinding(message: string): string | undefined {
  return /\[Dagger\/MissingBinding\]\s+(\S+?)\s+cannot be provided/.exec(message)?.[1]
}

/** The failing task a run names first: its FAILED line, else its failure block. */
export function failingTask(parsed: ParsedOutput): string {
  return parsed.failedTasks[0] ?? '(no task named)'
}

function withDetail(error: BuildError, detail: string[]): BuildError {
  return detail.length > 0 ? { ...error, detail } : error
}

/** The indented lines right after line `i`: a Dagger trace, a long Kotlin message. */
function indentedAfter(lines: string[], i: number): string[] {
  const out: string[] = []
  for (let j = i + 1; j < lines.length && out.length < 15; j++) {
    const next = lines[j] ?? ''
    if (!/^\s+\S/.test(next)) break
    out.push(next.trim())
  }
  return out
}

function firstWentWrongAfter(lines: string[], i: number): string | undefined {
  for (let j = i + 1; j < lines.length && j < i + 8; j++) {
    if (lines[j] === '* What went wrong:') {
      return (lines[j + 1] ?? '').trim() || undefined
    }
  }
  return undefined
}

function num(text: string | undefined): number | undefined {
  return text === undefined || text === '' ? undefined : Number(text)
}

function safeDecode(text: string): string {
  try {
    return decodeURI(text)
  } catch {
    return text
  }
}
