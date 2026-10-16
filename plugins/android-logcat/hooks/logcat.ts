// Pure helpers: bounding logcat commands, redacting adb output, parsing and
// searching logcat lines. No `$` here, so tests can import them directly.

import type { LogLevel, LogLine, LogcatFilter } from '../types'

export const LEVELS: readonly LogLevel[] = ['V', 'D', 'I', 'W', 'E', 'F']

export const levelRank = (level: LogLevel) => LEVELS.indexOf(level)

// --- Bounding -------------------------------------------------------------

/** `adb [global opts] logcat [args]`, args stopping at a shell separator. */
const LOGCAT_CALL =
  /\badb\b((?:\s+(?:-[adeHU]|-[sStPL]\s+\S+|--\S+))*)\s+logcat\b([^|;&\n)]*)/g

/** Flags that already make logcat return (or not stream) on their own. */
const BOUNDED_FLAG =
  /^(?:-d|-t\S*|--pid(?:=\S*)?|-m\S*|--max-count(?:=\S*)?|-c|--clear|-g|--get-buffer-size|-G\S*|--buffer-size(?:=\S*)?|-S|--statistics|-p|--prune|-P\S*|-L|--last|-h|--help)$/

export type Bounding = {
  command: string
  /** What was added, once per rewritten call; empty when nothing changed. */
  added: string[]
}

export type BoundTarget = { pid?: number }

/**
 * Adds `-d -t 800` (or `-t 200 --pid=<pid>` when the app's pid is known) to
 * every logcat call in `command` that would otherwise stream forever.
 */
export function boundLogcat(command: string, target: BoundTarget = {}): Bounding {
  const added: string[] = []
  const out = command.replace(LOGCAT_CALL, (whole, _globals: string, args: string, offset: number) => {
    const tokens = args.trim().split(/\s+/).filter(Boolean)
    if (tokens.some(token => BOUNDED_FLAG.test(token))) return whole
    const after = command.slice(offset + whole.length)
    if (/^\s*\|\s*head\b/.test(after)) return whole
    const before = command.slice(0, offset)
    if (/\btimeout\s+\S+\s*$/.test(before)) return whole
    const flags = target.pid !== undefined ? `-t 200 --pid=${target.pid}` : '-d -t 800'
    added.push(flags)
    const at = whole.length - args.length
    return `${whole.slice(0, at)} ${flags}${args}`
  })

  return { command: out, added }
}

export const isLogcatCommand = (command: string) => /\badb\b[^|;&\n]*\blogcat\b/.test(command)

// --- Redaction --------------------------------------------------------------

type Rule = { kind: string; pattern: RegExp; keep?: number }

// Each pattern is linear: no nested quantifiers. `keep` is how many leading
// capture groups stay as written (a header name, a key and its `=`).
const RULES: readonly Rule[] = [
  {
    kind: 'SECRET',
    pattern:
      /\b((?:Proxy-)?Authorization|Cookie|Set-Cookie|X-Api-Key|X-Auth-Token|X-Goog-Api-Key)(\s*:\s*)([^\r\n]+)/gi,
    keep: 2,
  },
  { kind: 'TOKEN', pattern: /\b(Bearer\s+)([A-Za-z0-9\-._~+/]{8,}=*)/g, keep: 1 },
  { kind: 'JWT', pattern: /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}/g },
  { kind: 'FCM', pattern: /\b[A-Za-z0-9_-]{11,}:APA91[A-Za-z0-9_-]{60,}/g },
  { kind: 'KEY', pattern: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  {
    kind: 'SECRET',
    pattern:
      /\b([A-Za-z0-9_-]{0,40}(?:token|secret|passw(?:or)?d|api[_-]?key|session[_-]?id))(["']?\s*[:=]\s*["']?)([^\s"'&,;)}\]<>]{4,})/gi,
    keep: 2,
  },
  { kind: 'EMAIL', pattern: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}\b/g },
  { kind: 'PHONE', pattern: /(?<![\w+])\+[1-9]\d{7,14}\b/g },
]

export type Redaction = { text: string; counts: Record<string, number> }

/**
 * Replaces secrets with stable placeholders (`<EMAIL#1>`): the same value
 * gets the same placeholder within one text, so the model can still follow
 * it across lines. Placeholders never match a rule, so scrubbing twice is safe.
 */
export function redact(text: string): Redaction {
  const counts: Record<string, number> = {}
  const seen = new Map<string, string>()
  const placeholder = (kind: string, value: string) => {
    const known = seen.get(`${kind}\0${value}`)
    if (known !== undefined) return known
    const n = (counts[kind] = (counts[kind] ?? 0) + 1)
    const made = `<${kind}#${n}>`
    seen.set(`${kind}\0${value}`, made)
    return made
  }
  let out = text
  for (const rule of RULES) {
    out = out.replace(rule.pattern, (whole: string, ...groups: unknown[]) => {
      const keep = rule.keep ?? 0
      if (keep === 0) return placeholder(rule.kind, whole)
      const parts = groups.slice(0, keep + 1).map(g => (typeof g === 'string' ? g : ''))
      const value = parts[keep] ?? ''
      if (value.startsWith('<')) return whole
      return parts.slice(0, keep).join('') + placeholder(rule.kind, value)
    })
  }

  return { text: out, counts }
}

export const countOf = (counts: Record<string, number>) =>
  Object.values(counts).reduce((a, b) => a + b, 0)

export const summarize = (counts: Record<string, number>) =>
  Object.entries(counts)
    .map(([kind, n]) => `${n} ${kind.toLowerCase()}`)
    .join(', ')

// --- Parsing ----------------------------------------------------------------

const THREADTIME =
  /^(\d\d-\d\d\s+\d\d:\d\d:\d\d\.\d+)\s+(\d+)\s+(\d+)\s+([VDIWEFA])\s+(.*?)\s*: (.*)$/
const BRIEF = /^([VDIWEFA])\/(.+?)\(\s*(\d+)\):\s?(.*)$/

const asLevel = (l: string): LogLevel => (l === 'A' ? 'F' : (l as LogLevel))

export function parseLine(raw: string): LogLine | undefined {
  const line = raw.replace(/\r$/, '')
  const t = THREADTIME.exec(line)
  if (t) {
    return {
      time: t[1] ?? '',
      pid: Number(t[2]),
      tid: Number(t[3]),
      level: asLevel(t[4] ?? 'I'),
      tag: t[5] ?? '',
      msg: t[6] ?? '',
    }
  }
  const b = BRIEF.exec(line)
  if (b) {
    const pid = Number(b[3])
    return { time: '', pid, tid: pid, level: asLevel(b[1] ?? 'I'), tag: b[2] ?? '', msg: b[4] ?? '' }
  }

  return undefined
}

export const parseLines = (text: string) =>
  text.split('\n').flatMap(raw => {
    const line = parseLine(raw)
    return line ? [line] : []
  })

export const formatLine = (l: LogLine) =>
  `${l.time ? `${l.time} ` : ''}${l.pid} ${l.tid} ${l.level} ${l.tag}: ${l.msg}`

// --- Searching --------------------------------------------------------------

export type GrepQuery = { tag?: string; level?: LogLevel; regex?: string; pid?: number }

/** Lines matching every given field: tag (exact or substring), minimum level, regex. */
export function grep(lines: readonly LogLine[], q: GrepQuery): LogLine[] {
  const re = q.regex ? new RegExp(q.regex, 'i') : undefined
  const min = q.level ? levelRank(q.level) : 0
  const tag = q.tag?.toLowerCase()

  return lines.filter(
    l =>
      levelRank(l.level) >= min &&
      (q.pid === undefined || l.pid === q.pid) &&
      (tag === undefined || l.tag.toLowerCase().includes(tag)) &&
      (re === undefined || re.test(l.tag) || re.test(l.msg)),
  )
}

/** The pane's filter over the ring: minimum level, then tag-or-message text. */
export function applyFilter(lines: readonly LogLine[], f: LogcatFilter): LogLine[] {
  const min = levelRank(f.level)
  const text = f.text.trim().toLowerCase()

  return lines.filter(
    l =>
      levelRank(l.level) >= min &&
      (text === '' || l.tag.toLowerCase().includes(text) || l.msg.toLowerCase().includes(text)),
  )
}

// --- Commands the model runs that name the app ------------------------------

/** The package a command names: `am start -n pkg/...`, `monkey -p pkg`, `pidof pkg`, ... */
export function packageIn(command: string): string | undefined {
  const m =
    /\bam\s+start(?:-activity)?\b[^|;&\n]*?\s-n\s+([A-Za-z][\w.]*)\//.exec(command) ??
    /\bmonkey\s+-p\s+([A-Za-z][\w.]*)/.exec(command) ??
    /\bpidof\s+(?:-s\s+)?([A-Za-z][\w.]*\.[\w.]+)/.exec(command)

  return m?.[1]
}

/** Whether the command (re)starts or reinstalls the app, so its pid is stale. */
export const restartsApp = (command: string) =>
  /\b(?:am\s+start(?:-activity)?|am\s+force-stop|monkey\s+-p|adb\b[^|;&\n]*\binstall(?:-multiple)?\b|pm\s+clear)\b/.test(
    command,
  )

/** `applicationId = "x"` / `applicationId "x"` in a Gradle build file. */
export const applicationIdIn = (gradle: string) =>
  /\bapplicationId\s*=?\s*["']([A-Za-z][\w.]*)["']/.exec(gradle)?.[1]
