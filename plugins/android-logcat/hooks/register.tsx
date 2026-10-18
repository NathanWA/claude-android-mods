import { atom, read, update } from 'claude-code'
import type { ApiContentBlock, Register, ThemeKey } from 'claude-code'

import type { LogLevel, LogLine, LogcatFilter, LogcatView } from '../types'
import {
  AppPids,
  LEVELS,
  appEvent,
  applicationIdIn,
  applyFilter,
  boundLogcat,
  countOf,
  formatLine,
  grep,
  isLogcatCommand,
  lineKey,
  packageIn,
  pidInPidof,
  pidInPs,
  parseLines,
  redact,
  restartsApp,
  stampMs,
  summarize,
} from './logcat'

const PLUGIN = 'android-logcat'
const PANE = 'android-logcat'
const GREP_TOOL = 'logcat_grep'
const RING = 2000
const VISIBLE = 80

const EMPTY_VIEW: LogcatView = {
  lines: [],
  total: 0,
  matched: 0,
  earlierPids: [],
  isPidStale: false,
  source: 'observe',
  redactions: 0,
}
/** How long a pid learned from the model's own adb output is trusted for `--pid`. */
const FRESH_MS = 30_000

const view = atom({ plugin: 'android-logcat', key: 'view' } as const, EMPTY_VIEW)
const filter = atom({ plugin: 'android-logcat', key: 'filter' } as const, { level: 'V', text: '' } as LogcatFilter)
const adbCalls = atom({ plugin: 'android-logcat', key: 'adbCalls' } as const, [] as string[])

// The ring lives here, not in $.state: only the visible window is mirrored.
// A reload empties it, as it also ends the live child. It keeps every pid's
// lines: which are the app's is decided when reading, by the pid history, so a
// restart never strands the new process's lines.
const ring: LogLine[] = []
const ringKeys = new Set<string>()
const app = new AppPids()
let pkg: string | undefined
let redactions = 0
let currentFilter: LogcatFilter = { level: 'V', text: '' }
let canSpawn = false
let mirrorPending = false

// The one owner of the live logcat child.
let liveGeneration = 0
let live: { pid: number; stop: () => void } | undefined
let liveCarry = ''
// Set by session.start where $.process works: (re)start the live child, and
// ask the device for the app's pid now.
let startLive: ((target: number) => void) | undefined
let verifyPid: (() => Promise<void>) | undefined

const PRIMARY_GROUPS = [
  'app/build.gradle.kts',
  'app/build.gradle',
  'androidApp/build.gradle.kts',
  'composeApp/build.gradle.kts',
]

const lastTimeOf = (target: number | undefined) => {
  if (target === undefined) return undefined
  for (let i = ring.length - 1; i >= 0; i--) if (ring[i]?.pid === target) return ring[i]?.time
  return undefined
}

function setPackage(name: string) {
  if (name === pkg) return
  pkg = name
  app.reset()
}

/** The app's pid is `next` now; answers whether it changed. */
const adoptPid = (next: number) => app.adopt(next, Date.now(), lastTimeOf(app.current))

/**
 * Adds lines the ring has not seen, oldest first, and follows ActivityManager's
 * word on the app's process starting and dying. Answers whether the pid changed.
 */
function ingest(lines: readonly LogLine[]): boolean {
  const before = app.current
  for (const line of lines) {
    const key = lineKey(line)
    if (ringKeys.has(key)) continue
    ringKeys.add(key)
    ring.push(line)
    const event = pkg === undefined ? undefined : appEvent(line, pkg)
    if (event?.kind === 'start') {
      // A start older than what the current pid has logged is history, not news.
      const latest = lastTimeOf(app.current)
      if (latest === undefined || line.time === '' || line.time >= latest) adoptPid(event.pid)
    } else if (event?.kind === 'death' && event.pid === app.current) {
      app.retire(line.time)
    }
  }
  if (ring.length > RING) {
    for (const gone of ring.splice(0, ring.length - RING)) ringKeys.delete(lineKey(gone))
  }

  return app.current !== before
}

const appLines = () => ring.filter(l => app.owns(l))

/** The app restarted and its new pid is not known yet. */
const isPidStale = () => app.known.length > 0 && (app.current === undefined || app.verifiedAt === 0)

/** The pid to scope a logcat call to: only one confirmed lately. */
const freshPid = () =>
  app.current !== undefined && Date.now() - app.verifiedAt < FRESH_MS ? app.current : undefined

/** The visible window of the app's lines, filtered: all that is mirrored to $.state. */
function viewNow(): LogcatView {
  const matched = applyFilter(appLines(), currentFilter)
  return {
    lines: matched.slice(-VISIBLE),
    total: ring.length,
    matched: matched.length,
    earlierPids: app.earlier,
    isPidStale: isPidStale(),
    source: live ? 'spawn' : 'observe',
    redactions,
    ...(pkg !== undefined && { pkg }),
    ...(app.current !== undefined && { pid: app.current }),
  }
}

const parsePid = (ran: { exitCode: number | null; stdout: string } | undefined) =>
  ran?.exitCode === 0 ? pidInPidof(ran.stdout) : undefined

function stopLive() {
  liveGeneration++
  live?.stop()
  live = undefined
}

/** Feeds one piece of the live child's output; answers whether lines landed. */
function feed(text: string): boolean {
  const all = liveCarry + text
  const cut = all.lastIndexOf('\n')
  if (cut < 0) {
    liveCarry = all
    return false
  }
  liveCarry = all.slice(cut + 1)
  const scrubbed = redact(all.slice(0, cut))
  redactions += countOf(scrubbed.counts)
  if (ingest(parseLines(scrubbed.text)) && app.current !== undefined) startLive?.(app.current)
  return true
}

/** A tool_result block with its text redacted; the same block when nothing matched. */
function redactBlock<B extends ApiContentBlock>(block: B): B {
  if (block.type !== 'tool_result') return block
  const content = block.content
  if (typeof content === 'string') {
    const scrubbed = redact(content)
    return countOf(scrubbed.counts) === 0 ? block : { ...block, content: scrubbed.text }
  }
  if (!Array.isArray(content)) return block
  let changed = false
  const inner = content.map(part => {
    if (part.type !== 'text') return part
    const scrubbed = redact(part.text)
    if (countOf(scrubbed.counts) === 0) return part
    changed = true
    return { ...part, text: scrubbed.text }
  })
  return changed ? { ...block, content: inner } : block
}

const GREP_DESCRIPTION = [
  "Search android-logcat's buffer of the app's logcat lines (secrets already redacted). By default it searches the app's pids this session, the current one and any earlier ones from restarts; scope \"all\" searches every pid.",
  'Prefer this over running adb logcat again. Filters combine: tag (substring), level (minimum: V D I W E F), regex (case-insensitive, over tag and message).',
  'The buffer fills from adb logcat calls you run and, where available, a live adb logcat child.',
].join(' ')

const levelColor = (level: LogLevel): ThemeKey | undefined =>
  level === 'E' || level === 'F' ? 'error' : level === 'W' ? 'warning' : undefined

const asLevel = (value: unknown): LogLevel | undefined =>
  typeof value === 'string' && (LEVELS as readonly string[]).includes(value.toUpperCase())
    ? (value.toUpperCase() as LogLevel)
    : undefined

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.tool.register({
      name: GREP_TOOL,
      description: GREP_DESCRIPTION,
      isDeferred: false,
      inputSchema: {
        type: 'object',
        properties: {
          tag: { type: 'string', description: 'Tag substring, e.g. "OkHttp" or "AndroidRuntime".' },
          level: { type: 'string', enum: [...LEVELS], description: 'Minimum level.' },
          regex: { type: 'string', description: 'Case-insensitive regex over tag and message.' },
          limit: { type: 'number', description: 'Most recent matches to return (default 100, max 500).' },
          scope: {
            type: 'string',
            enum: ['app', 'all'],
            description: 'app (default): the app\'s pids this session. all: every pid in the buffer.',
          },
        },
      },
    })
    await $.command.register({
      name: 'logcat',
      description: "Show android-logcat's pid-scoped logcat buffer in a pane",
    })
    const started = await next(e)

    // The one owner of the live child: this hook's closure. A reload kills the
    // child with the module, and session.start fires again to start a new one.
    const mirrorSoon = () => {
      if (mirrorPending) return
      mirrorPending = true
      $.clock.after(300, () => {
        mirrorPending = false
        void update($, view, viewNow).catch(() => undefined)
      })
    }
    const launch = (target: number) => {
      if (live?.pid === target) return
      stopLive()
      const generation = liveGeneration
      liveCarry = ''
      const stream = $.process.spawn({
        argv: ['adb', 'logcat', '-v', 'threadtime', '-T', '1', `--pid=${target}`],
      })
      live = { pid: target, stop: () => void stream.return(undefined as never).catch(() => undefined) }
      void (async () => {
        try {
          for await (const piece of stream) {
            if (generation !== liveGeneration) break
            if (feed(piece.text)) mirrorSoon()
          }
        } catch {
          // adb went away or the device dropped: observe the model's calls instead.
        } finally {
          if (generation === liveGeneration) {
            live = undefined
            mirrorSoon()
          }
        }
      })()
    }

    void (async () => {
      currentFilter = await read($, filter)
      if (pkg === undefined) {
        const root = await $.session.root().catch(() => undefined)
        for (const file of root === undefined ? [] : PRIMARY_GROUPS) {
          const text = await $.fs.read(`${root}/${file}`).catch(() => undefined)
          const id = typeof text === 'string' ? applicationIdIn(text) : undefined
          if (id !== undefined) {
            pkg = id
            break
          }
        }
      }
      // $.process is documented CLI-only: probe it, and degrade to observing.
      const probe = await $.process.run(['adb', 'version'], { timeoutMs: 5000 }).catch(() => undefined)
      canSpawn = probe?.exitCode === 0
      if (canSpawn) {
        startLive = launch
        // Ask the device which pid is the app's now. A restart from anywhere
        // (another tool, the terminal, a crash) shows up here: the child follows.
        verifyPid = async () => {
          const target = pkg
          if (target === undefined) return
          const ran = await $.process
            .run(['adb', 'shell', 'pidof', '-s', target], { timeoutMs: 5000 })
            .catch(() => undefined)
          if (ran === undefined || target !== pkg) return
          const found = parsePid(ran)
          if (found !== undefined) {
            adoptPid(found)
            launch(found)
          } else if (ran.exitCode === 1 && ran.stderr.trim() === '') {
            // pidof found no such process: the app is not running.
            app.retire(lastTimeOf(app.current))
            stopLive()
          }
          mirrorSoon()
        }
        await verifyPid()
        $.clock.every(5000, () => void verifyPid?.().catch(() => undefined))
      }
      await update($, view, viewNow)
    })().catch(() => undefined)

    return started
  })

  // Bound the model's own logcat calls, then redact what any adb call returns.
  on('tool.call', { tool: 'Bash', command: /\badb\b/ }, async ($, e, next) => {
    // build-output-distiller owns Gradle commands.
    if (/gradlew/.test(e.command)) return next(e)

    const named = packageIn(e.command)
    if (named !== undefined) setPackage(named)
    if (restartsApp(e.command)) {
      // The app is (re)starting: its pid is no longer trusted until confirmed.
      app.distrust()
      if (verifyPid !== undefined) {
        $.clock.after(2000, () => void verifyPid?.().catch(() => undefined))
        $.clock.after(6000, () => void verifyPid?.().catch(() => undefined))
      }
    }

    const isLogcat = isLogcatCommand(e.command)
    let command = e.command
    let added: string[] = []
    if (isLogcat && e.run_in_background !== true) {
      await verifyPid?.().catch(() => undefined)
      // Only a pid confirmed lately scopes the call; else the call is left
      // unscoped, which also brings in ActivityManager's word on restarts.
      const target = freshPid()
      const bounded = boundLogcat(e.command, target === undefined ? {} : { pid: target })
      command = bounded.command
      added = bounded.added
    }

    await update($, adbCalls, ids => [...ids, e.tool_use_id].slice(-200))
    const ran = await next(command === e.command ? e : { ...e, command })
    if (ran.deny !== undefined) return ran

    const asksPidof = pkg !== undefined && new RegExp(`\\bpidof\\s+(?:-s\\s+)?${pkg.replace(/\./g, '\\.')}\\b`).test(e.command)

    if (ran.isError === true) {
      // `pidof <app>` exits 1 with no output when the app is not running.
      if (asksPidof && (ran.text ?? '').trim().replace(/^Exit code 1$/, '') === '') {
        app.retire(lastTimeOf(app.current))
        await update($, view, viewNow)
      }
      const scrubbed = redact(ran.text ?? '')
      return countOf(scrubbed.counts) === 0 ? ran : { deny: scrubbed.text }
    }

    const record = ran.result
    // The model asked the device for the app's pid: take its answer.
    const told =
      (asksPidof ? pidInPidof(record.stdout) : undefined) ??
      (pkg !== undefined && /\bps\b/.test(e.command) ? pidInPs(record.stdout, pkg) : undefined)
    if (told !== undefined) {
      adoptPid(told)
      startLive?.(told)
    }

    const out = redact(record.stdout)
    const err = redact(record.stderr)
    const counts: Record<string, number> = { ...out.counts }
    for (const [kind, n] of Object.entries(err.counts)) counts[kind] = (counts[kind] ?? 0) + n

    // A large output is also on disk, where the model can Read it: scrub that too.
    if (record.persistedOutputPath !== undefined) {
      const path = record.persistedOutputPath
      const ok = await $.fs
        .read(path)
        .then(async raw => {
          const disk = redact(raw)
          for (const [kind, n] of Object.entries(disk.counts)) counts[kind] = Math.max(counts[kind] ?? 0, n)
          if (countOf(disk.counts) > 0) await $.fs.write(path, disk.text)
          return true
        })
        .catch(() => false)
      if (!ok) {
        return {
          deny: `${PLUGIN}: this adb output was too large to redact, so it was withheld. Re-run with a filter (grep, -t N, --pid).`,
        }
      }
    }

    const found = countOf(counts)
    redactions += found
    if (isLogcat || told !== undefined) {
      if (ingest(parseLines(out.text)) && app.current !== undefined) startLive?.(app.current)
      await update($, view, viewNow)
    }
    if (found > 0) $.ui.toast(`${PLUGIN}: redacted ${summarize(counts)} from adb output`)

    if (found === 0 && added.length === 0) return ran

    const notes: string[] = []
    if (added.length > 0) {
      notes.push(
        `${PLUGIN} added \`${added.join('`, `')}\` to this logcat call so it could not stream forever. Leave it bounded; search what was captured with mcp__${PLUGIN}__${GREP_TOOL}.`,
      )
    }
    if (found > 0) {
      notes.push(
        `${PLUGIN} redacted ${summarize(counts)} from this adb output. A placeholder such as <EMAIL#1> stands for the same value wherever it appears.`,
      )
    }

    // A fresh result: no `ref` and no `text`, so core builds the model's copy
    // and the transcript record from the redacted output.
    return {
      result: { ...record, stdout: out.text, stderr: err.text },
      context: [...(ran.context ?? []), ...notes],
    }
  }).catch(($, e, next) =>
    next.called
      ? { deny: `${PLUGIN}: redaction failed, so the adb output was withheld.` }
      : next(e),
  )

  // Safety net: a tool result from a recorded adb call is scrubbed again as it
  // is stored. Redaction is idempotent, so a result already scrubbed passes.
  on('session.append', { door: 'tool-result' }, async ($, e, next) => {
    const ids = await read($, adbCalls)
    const content = e.message.content.map(block =>
      block.type === 'tool_result' && ids.includes(String(block.tool_use_id)) ? redactBlock(block) : block,
    )
    const changed = content.some((block, i) => block !== e.message.content[i])

    return changed ? next({ ...e, message: { ...e.message, content } }) : next(e)
  }).catch(($, e, next) =>
    // Failing closed: with the adb ids unknown, every tool result is scrubbed.
    next({ ...e, message: { ...e.message, content: e.message.content.map(redactBlock) } }),
  )

  on('tool.call', { tool: 'mcp__android-logcat__logcat_grep' }, async ($, e) => {
    const regex = typeof e.regex === 'string' && e.regex !== '' ? e.regex : undefined
    if (regex !== undefined) {
      try {
        new RegExp(regex, 'i')
      } catch (error) {
        return { result: `Invalid regex ${JSON.stringify(regex)}: ${String(error)}` }
      }
    }
    if (ring.length === 0) {
      return {
        result:
          'The logcat buffer is empty. Run `adb logcat -d -t 800` (android-logcat bounds a bare `adb logcat` for you) to fill it, then search again.',
      }
    }
    await verifyPid?.().catch(() => undefined)
    const level = asLevel(e.level)
    const tag = typeof e.tag === 'string' && e.tag !== '' ? e.tag : undefined
    const limit = Math.min(500, Math.max(1, typeof e.limit === 'number' ? Math.floor(e.limit) : 100))
    const query = {
      ...(tag !== undefined && { tag }),
      ...(level !== undefined && { level }),
      ...(regex !== undefined && { regex }),
    }
    const everything = e.scope === 'all' || app.known.length === 0
    const pool = everything ? ring : appLines()
    const hits = grep(pool, query)
    const others = everything ? [] : grep(ring.filter(l => !app.owns(l)), query)
    const shown = hits.slice(-limit)

    const appPids = [
      app.current !== undefined ? `pid ${app.current}` : 'current pid unknown',
      ...(app.earlier.length > 0 ? [`earlier ${app.earlier.join(', ')}`] : []),
    ].join(', ')
    const scope = everything
      ? app.known.length === 0
        ? 'all pids: the app pid is not known yet'
        : 'all pids'
      : `${pkg ?? 'app'}: ${appPids}`
    const head = `${hits.length} of ${pool.length} ${everything ? 'buffered' : 'app'} lines match (${scope})${
      hits.length > shown.length ? `; the last ${shown.length} shown` : ''
    }.`

    // Never let a stale pid read as "the app logged nothing".
    const notes: string[] = []
    if (!everything) {
      const lastApp = stampMs(lastTimeOf(app.current) ?? '')
      const lastAny = stampMs(ring[ring.length - 1]?.time ?? '')
      if (isPidStale()) {
        notes.push(
          `Warning: the app restarted since its pid was last confirmed, and the new pid is not known yet, so the new process's lines are not counted as the app's.`,
        )
      } else if (lastApp !== undefined && lastAny !== undefined && lastAny - lastApp > 60_000 && others.length > 0) {
        notes.push(
          `Warning: pid ${app.current} last logged at ${lastTimeOf(app.current)}, while the device logged until ${
            ring[ring.length - 1]?.time
          }. If the app restarted, that pid is stale.`,
        )
      }
      if (others.length > 0 && (hits.length === 0 || notes.length > 0)) {
        const pids = [...new Set(others.map(l => l.pid))].slice(0, 6)
        notes.push(
          `${others.length} lines from other pids match (pid ${pids.join(', ')}). If the app restarted, run \`adb shell pidof -s ${
            pkg ?? '<package>'
          }\` and android-logcat rescopes to the new pid, or search again with scope "all".`,
        )
      }
    }

    return { result: [head, ...notes, ...shown.map(formatLine)].join('\n') }
  }).catch(() => ({ deny: `${PLUGIN}: the logcat search failed.` }))

  on('command.run', { command: 'logcat' }, async $ => {
    await update($, view, viewNow)
    const placed = await $.ui.open({
      id: PANE,
      title: `logcat · ${pkg ?? 'all apps'}`,
      focus: true,
      closeOnEscape: true,
    })

    return {
      text: placed.isPlaced
        ? `Opened the logcat pane (${ring.length} buffered lines).`
        : `The logcat pane is open but no surface draws it here; ${ring.length} lines are buffered.`,
    }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const v = await read($, view)
    const f = await read($, filter)
    const room = Math.max(3, (e.viewport?.rows ?? 30) - 7)

    const setFilter = async (change: Partial<LogcatFilter>) => {
      currentFilter = { ...currentFilter, ...change }
      await update($, filter, () => currentFilter)
      await update($, view, viewNow)
    }
    const status = [
      v.pkg ?? 'app package unknown',
      v.pid !== undefined
        ? `pid ${v.pid}${v.earlierPids.length > 0 ? ` (earlier ${v.earlierPids.join(', ')})` : ''}`
        : v.earlierPids.length > 0
          ? `app not running (earlier ${v.earlierPids.join(', ')})`
          : 'all pids',
      ...(v.isPidStale ? ['restarted, new pid not known yet'] : []),
      v.source === 'spawn' ? 'live' : 'from adb calls',
      `${v.matched}/${v.total} lines`,
      `${v.redactions} redacted`,
    ].join(' · ')

    const controls =
      e.surface === 'mobile' ? null : (() => {
        const { Input, Select } = $.ui.resolve(e)
        return (
          <Box flexDirection="row" gap={1}>
            <Select
              key="level"
              label="Level"
              value={f.level}
              options={LEVELS.map(l => ({ value: l, label: l }))}
              onSelect={value => void setFilter({ level: asLevel(value) ?? 'V' })}
            />
            <Input
              key="filter"
              label="Filter"
              placeholder="tag or text"
              value={f.text}
              submitLabel="filter"
              onInput={value => void setFilter({ text: value })}
              onSubmit={value => void setFilter({ text: value })}
            />
          </Box>
        )
      })()

    return (
      <Box flexDirection="column">
        <Text dimColor>{status}</Text>
        {controls}
        <Box flexDirection="row" gap={1}>
          <Button
            key="clear"
            hotkey="c"
            label="Clear"
            onPress={() => {
              ring.length = 0
              void update($, view, viewNow)
            }}
          />
          <Button
            key="send"
            hotkey="k"
            label="Send to Claude"
            variant="primary"
            onPress={async () => {
              const shown = (await read($, view)).lines
              if (shown.length === 0) return void $.ui.toast(`${PLUGIN}: nothing to send`)
              await $.session.append({
                message: {
                  type: 'user',
                  content: [
                    {
                      type: 'text',
                      text: `Logcat lines the person sent from the android-logcat pane (${status}):\n${shown
                        .map(formatLine)
                        .join('\n')}`,
                    },
                  ],
                },
              })
              $.ui.toast(`${PLUGIN}: sent ${shown.length} lines; they ride with your next prompt`)
            }}
          />
        </Box>
        {v.lines.length === 0 && (
          <Text dimColor>
            No lines yet. They arrive from adb logcat calls{v.source === 'spawn' ? ' and the live child' : ''}.
          </Text>
        )}
        {v.lines.slice(-room).map((l, i) => {
          const color = levelColor(l.level)
          return (
            <Text
              key={`l${i}`}
              wrap="truncate-end"
              {...(color !== undefined ? { color } : { dimColor: l.level === 'V' || l.level === 'D' })}
            >
              {l.time.slice(6)} {l.level} {l.tag}: {l.msg}
            </Text>
          )
        })}
      </Box>
    )
  })
}
