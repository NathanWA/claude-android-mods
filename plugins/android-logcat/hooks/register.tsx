import { atom, read, update } from 'claude-code'
import type { ApiContentBlock, Register, ThemeKey } from 'claude-code'

import type { LogLevel, LogLine, LogcatFilter, LogcatView } from '../types'
import {
  LEVELS,
  applicationIdIn,
  applyFilter,
  boundLogcat,
  countOf,
  formatLine,
  grep,
  isLogcatCommand,
  packageIn,
  parseLines,
  redact,
  restartsApp,
  summarize,
} from './logcat'

const PLUGIN = 'android-logcat'
const PANE = 'android-logcat'
const GREP_TOOL = 'logcat_grep'
const RING = 2000
const VISIBLE = 80

const EMPTY_VIEW: LogcatView = { lines: [], total: 0, matched: 0, source: 'observe', redactions: 0 }

const view = atom({ plugin: 'android-logcat', key: 'view' } as const, EMPTY_VIEW)
const filter = atom({ plugin: 'android-logcat', key: 'filter' } as const, { level: 'V', text: '' } as LogcatFilter)
const adbCalls = atom({ plugin: 'android-logcat', key: 'adbCalls' } as const, [] as string[])

// The ring lives here, not in $.state: only the visible window is mirrored.
// A reload empties it, as it also ends the live child.
const ring: LogLine[] = []
let pkg: string | undefined
let pid: number | undefined
let redactions = 0
let currentFilter: LogcatFilter = { level: 'V', text: '' }
let canSpawn = false
let mirrorPending = false

// The one owner of the live `adb logcat` child.
let liveGeneration = 0
let live: { pid: number; stop: () => void } | undefined
let liveCarry = ''
// Set by session.start where $.process works: (re)starts the live child.
let startLive: ((target: number) => void) | undefined

const PRIMARY_GROUPS = [
  'app/build.gradle.kts',
  'app/build.gradle',
  'androidApp/build.gradle.kts',
  'composeApp/build.gradle.kts',
]

function ingest(lines: readonly LogLine[]) {
  const scoped = pid === undefined ? lines : lines.filter(l => l.pid === pid)
  ring.push(...scoped)
  if (ring.length > RING) ring.splice(0, ring.length - RING)
}

/** The visible window of the ring, filtered: all that is mirrored to $.state. */
function viewNow(): LogcatView {
  const matched = applyFilter(ring, currentFilter)
  return {
    lines: matched.slice(-VISIBLE),
    total: ring.length,
    matched: matched.length,
    source: live ? 'spawn' : 'observe',
    redactions,
    ...(pkg !== undefined && { pkg }),
    ...(pid !== undefined && { pid }),
  }
}

const parsePid = (ran: { exitCode: number | null; stdout: string } | undefined) => {
  const n = Number(ran?.stdout.trim())
  return ran?.exitCode === 0 && Number.isInteger(n) && n > 0 ? n : undefined
}

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
  ingest(parseLines(scrubbed.text))
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
  "Search android-logcat's buffer of the app's logcat lines (pid-scoped when the app package is known, secrets already redacted).",
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
        if (pkg !== undefined) {
          const found = parsePid(
            await $.process.run(['adb', 'shell', 'pidof', '-s', pkg], { timeoutMs: 5000 }).catch(() => undefined),
          )
          if (found !== undefined) {
            pid = found
            launch(found)
          }
        }
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
    if (named !== undefined && named !== pkg) {
      pkg = named
      pid = undefined
    }
    if (restartsApp(e.command)) {
      // The app is (re)starting: its pid is stale. Re-resolve once it is up.
      pid = undefined
      const target = pkg
      if (canSpawn && target !== undefined) {
        $.clock.after(2000, () => {
          void $.process
            .run(['adb', 'shell', 'pidof', '-s', target], { timeoutMs: 5000 })
            .then(ran => {
              const found = parsePid(ran)
              if (found === undefined || target !== pkg) return
              pid = found
              startLive?.(found)
              return update($, view, viewNow)
            })
            .catch(() => undefined)
        })
      }
    }

    const isLogcat = isLogcatCommand(e.command)
    let command = e.command
    let added: string[] = []
    if (isLogcat && e.run_in_background !== true) {
      if (pid === undefined && canSpawn && pkg !== undefined) {
        pid = parsePid(
          await $.process.run(['adb', 'shell', 'pidof', '-s', pkg], { timeoutMs: 5000 }).catch(() => undefined),
        )
      }
      const bounded = boundLogcat(e.command, pid === undefined ? {} : { pid })
      command = bounded.command
      added = bounded.added
    }

    await update($, adbCalls, ids => [...ids, e.tool_use_id].slice(-200))
    const ran = await next(command === e.command ? e : { ...e, command })
    if (ran.deny !== undefined) return ran

    if (ran.isError === true) {
      const scrubbed = redact(ran.text ?? '')
      return countOf(scrubbed.counts) === 0 ? ran : { deny: scrubbed.text }
    }

    const record = ran.result
    if (/\bpidof\b/.test(e.command) && /^\d+$/.test(record.stdout.trim())) {
      pid = Number(record.stdout.trim())
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
    if (isLogcat) {
      ingest(parseLines(out.text))
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
    const level = asLevel(e.level)
    const tag = typeof e.tag === 'string' && e.tag !== '' ? e.tag : undefined
    const limit = Math.min(500, Math.max(1, typeof e.limit === 'number' ? Math.floor(e.limit) : 100))
    const hits = grep(ring, {
      ...(tag !== undefined && { tag }),
      ...(level !== undefined && { level }),
      ...(regex !== undefined && { regex }),
    })
    const shown = hits.slice(-limit)
    const scope = pid !== undefined ? `pid ${pid}${pkg ? ` (${pkg})` : ''}` : 'all pids'
    const head = `${hits.length} of ${ring.length} buffered lines match (${scope})${
      hits.length > shown.length ? `; the last ${shown.length} shown` : ''
    }.`

    return { result: [head, ...shown.map(formatLine)].join('\n') }
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
      v.pid !== undefined ? `pid ${v.pid}` : 'all pids',
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
