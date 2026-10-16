// Pure helpers: adb argv and device-shell scripts, and parsers for what the
// device prints. dumpsys/settings output differs by API level, so every
// parser reads defensively and answers null for what it cannot tell.

import type { Device, DeviceState, Job } from '../types'

export const SAFE_WORD = /^[\w@%+=:,./-]+$/

export function shellQuote(argv: readonly string[]): string {
  return argv
    .map(arg => (SAFE_WORD.test(arg) ? arg : `'${arg.replaceAll("'", `'\\''`)}'`))
    .join(' ')
}

export const PACKAGE = /^[A-Za-z][\w]*(\.[A-Za-z_][\w]*)+$/

// --- devices --------------------------------------------------------------

export function parseDevices(stdout: string): Device[] {
  const devices: Device[] = []
  for (const raw of stdout.split('\n')) {
    const line = raw.trim()
    if (line === '' || line.startsWith('List of devices') || line.startsWith('*')) continue
    const [serial, state] = line.split(/\s+/)
    if (serial === undefined || state === undefined) continue
    const model = /\bmodel:(\S+)/.exec(line)?.[1] ?? null
    devices.push({ serial, state, model })
  }
  return devices
}

export type Target = { serial: string } | { error: string }

export function pickTarget(
  devices: readonly Device[],
  envSerial: string | undefined,
  chosen: string | null,
): Target {
  if (envSerial) return { serial: envSerial }
  const ready = devices.filter(d => d.state === 'device')
  if (chosen !== null && ready.some(d => d.serial === chosen)) return { serial: chosen }
  if (ready.length === 1) return { serial: ready[0]!.serial }
  if (ready.length === 0) {
    const other = devices.map(d => `${d.serial} (${d.state})`).join(', ')
    return {
      error: other
        ? `No device is ready: ${other}.`
        : 'No device is connected (adb devices lists none).',
    }
  }
  const list = ready.map(d => d.serial + (d.model ? ` ${d.model}` : '')).join(', ')
  return {
    error: `${ready.length} devices are connected (${list}). Pick one in /device, pass serial, or set ANDROID_SERIAL.`,
  }
}

// --- device state ---------------------------------------------------------

export function stateScript(pkg: string | null): string {
  const parts = [
    'echo @@model; getprop ro.product.model',
    'echo @@api; getprop ro.build.version.sdk',
    'echo @@night; cmd uimode night',
    'echo @@font; settings get system font_scale',
    'echo @@density; wm density',
    'echo @@rtl; settings get global debug.force_rtl',
    'echo @@layout; getprop debug.layout',
    'echo @@anim; settings get global animator_duration_scale',
    'echo @@deep; dumpsys deviceidle get deep',
    'echo @@light; dumpsys deviceidle get light',
  ]
  if (pkg !== null && PACKAGE.test(pkg)) parts.push(`echo @@bucket; am get-standby-bucket ${pkg}`)
  return parts.join('; ')
}

export function splitSections(stdout: string): Map<string, string> {
  const sections = new Map<string, string>()
  let current = ''
  let lines: string[] = []
  const flush = () => {
    if (current) sections.set(current, lines.join('\n').trim())
  }
  for (const line of stdout.replaceAll('\r', '').split('\n')) {
    const marker = /^@@(\w+)$/.exec(line.trim())
    if (marker) {
      flush()
      current = marker[1]!
      lines = []
    } else {
      lines.push(line)
    }
  }
  flush()
  return sections
}

const BUCKETS: Record<string, string> = {
  '5': 'exempted',
  '10': 'active',
  '20': 'working_set',
  '30': 'frequent',
  '40': 'rare',
  '45': 'restricted',
  '50': 'never',
}

export const BUCKET_NAMES = ['active', 'working_set', 'frequent', 'rare', 'restricted'] as const

function isUnset(text: string | undefined): boolean {
  return text === undefined || text === '' || text === 'null'
}

function looksLikeError(text: string): boolean {
  return /unknown|not found|error|exception|usage:|permission denial/i.test(text)
}

function firstWord(text: string | undefined): string | null {
  if (text === undefined || text === '' || looksLikeError(text)) return null
  return text.split(/\s+/)[0] ?? null
}

export function parseState(serial: string, stdout: string, readAt: number): DeviceState {
  const s = splitSections(stdout)
  const night = s.get('night') ?? ''
  const font = s.get('font')
  const density = s.get('density') ?? ''
  const physical = /Physical density:\s*(\d+)/i.exec(density)?.[1]
  const override = /Override density:\s*(\d+)/i.exec(density)?.[1]
  const rtl = s.get('rtl')
  const layout = s.get('layout')
  const anim = s.get('anim')
  const bucketRaw = s.get('bucket')
  const api = Number.parseInt(s.get('api') ?? '', 10)
  const fontScale = isUnset(font) ? 1 : Number.parseFloat(font!)
  const animScale = isUnset(anim) ? 1 : Number.parseFloat(anim!)
  let bucket: string | null = null
  if (bucketRaw !== undefined && bucketRaw !== '' && !looksLikeError(bucketRaw)) {
    const word = bucketRaw.split(/\s+/)[0]!
    bucket = BUCKETS[word] ?? word.toLowerCase()
  }

  return {
    serial,
    model: s.get('model') || null,
    api: Number.isFinite(api) ? api : null,
    isDark: /night mode:\s*yes/i.test(night) ? true : /night mode:\s*no/i.test(night) ? false : null,
    fontScale: Number.isFinite(fontScale) ? fontScale : null,
    density: override ? Number(override) : physical ? Number(physical) : null,
    physicalDensity: physical ? Number(physical) : null,
    isRtl: rtl === undefined ? null : rtl.trim() === '1',
    hasLayoutBounds: layout === undefined ? null : layout.trim() === 'true',
    hasAnimations: Number.isFinite(animScale) ? animScale !== 0 : null,
    deepIdle: firstWord(s.get('deep')),
    lightIdle: firstWord(s.get('light')),
    bucket,
    readAt,
  }
}

// --- changes --------------------------------------------------------------

export type DeviceChanges = {
  dark?: boolean
  fontScale?: number
  density?: number | 'reset'
  rtl?: boolean
  layoutBounds?: boolean
  animations?: boolean
}

export function readChanges(input: Record<string, unknown>): DeviceChanges | { error: string } {
  const changes: DeviceChanges = {}
  const bool = (key: string): boolean | undefined | 'bad' => {
    const v = input[key]
    if (v === undefined || v === null) return undefined
    return typeof v === 'boolean' ? v : 'bad'
  }
  for (const key of ['dark', 'rtl', 'layoutBounds', 'animations'] as const) {
    const v = bool(key)
    if (v === 'bad') return { error: `${key} must be true or false.` }
    if (v !== undefined) changes[key] = v
  }
  const font = input.fontScale
  if (font !== undefined && font !== null) {
    if (typeof font !== 'number' || !(font >= 0.5 && font <= 3)) {
      return { error: 'fontScale must be a number from 0.5 to 3.' }
    }
    changes.fontScale = font
  }
  const density = input.density
  if (density !== undefined && density !== null) {
    if (density === 'reset') changes.density = 'reset'
    else if (typeof density === 'number' && Number.isInteger(density) && density >= 72 && density <= 1000) {
      changes.density = density
    } else return { error: 'density must be an integer dpi from 72 to 1000, or "reset".' }
  }
  if (Object.keys(changes).length === 0) {
    return { error: 'Name at least one of dark, fontScale, density, rtl, layoutBounds, animations.' }
  }
  return changes
}

export function changeScript(changes: DeviceChanges, restartPkg: string | null): string {
  const cmds: string[] = []
  if (changes.dark !== undefined) cmds.push(`cmd uimode night ${changes.dark ? 'yes' : 'no'}`)
  if (changes.fontScale !== undefined) cmds.push(`settings put system font_scale ${changes.fontScale}`)
  if (changes.density !== undefined) {
    cmds.push(changes.density === 'reset' ? 'wm density reset' : `wm density ${changes.density}`)
  }
  if (changes.rtl !== undefined) {
    const v = changes.rtl ? 1 : 0
    cmds.push(`settings put global debug.force_rtl ${v}`, `setprop debug.force_rtl ${v} 2>/dev/null`)
  }
  if (changes.layoutBounds !== undefined) {
    cmds.push(
      `setprop debug.layout ${changes.layoutBounds ? 'true' : 'false'}`,
      'service call activity 1599295570 >/dev/null 2>&1',
    )
  }
  if (changes.animations !== undefined) {
    const v = changes.animations ? 1 : 0
    for (const key of ['window_animation_scale', 'transition_animation_scale', 'animator_duration_scale']) {
      cmds.push(`settings put global ${key} ${v}`)
    }
  }
  if (restartPkg !== null && PACKAGE.test(restartPkg)) {
    cmds.push(
      `am force-stop ${restartPkg}`,
      `monkey -p ${restartPkg} -c android.intent.category.LAUNCHER 1 >/dev/null 2>&1`,
    )
  }
  return cmds.join('; ')
}

export const DEFAULTS: DeviceChanges = {
  dark: false,
  fontScale: 1,
  density: 'reset',
  rtl: false,
  layoutBounds: false,
  animations: true,
}

export function dozeScript(state: 'idle' | 'off' | undefined, bucket: string | undefined, pkg: string | null): string {
  const cmds: string[] = []
  if (state === 'idle') {
    cmds.push('dumpsys deviceidle enable', 'dumpsys battery unplug', 'dumpsys deviceidle force-idle')
  }
  if (state === 'off') cmds.push('dumpsys deviceidle unforce', 'dumpsys battery reset')
  if (bucket !== undefined && pkg !== null) cmds.push(`am set-standby-bucket ${pkg} ${bucket}`)
  return cmds.join('; ')
}

// --- cycles the band steps through ----------------------------------------

export const FONT_STEPS = [1, 1.15, 1.3, 2] as const

export function nextFontScale(current: number | null): number {
  const now = current ?? 1
  return FONT_STEPS.find(step => step > now + 0.001) ?? 1
}

export function nextDensity(state: DeviceState): number | 'reset' {
  const physical = state.physicalDensity ?? state.density
  if (physical === null) return 'reset'
  const steps = [Math.round(physical * 1.15), Math.round(physical * 1.3), Math.round(physical * 0.85)]
  const now = state.density ?? physical
  if (now === physical) return steps[0]!
  const at = steps.indexOf(now)
  return at === -1 || at === steps.length - 1 ? 'reset' : steps[at + 1]!
}

// --- jobs -----------------------------------------------------------------

const JOB_LINE = /JOB #[^\s:]*\/(-?\d+):\s+\S+\s+([\w.]+)\/(\S+)/

export function parseJobs(stdout: string, pkg: string | null): Job[] {
  const jobs = new Map<number, Job>()
  let current: Job | null = null
  for (const raw of stdout.replaceAll('\r', '').split('\n')) {
    const job = JOB_LINE.exec(raw)
    if (job) {
      const id = Number(job[1])
      const owner = job[2]!
      if (pkg !== null && owner !== pkg) {
        current = null
        continue
      }
      current = jobs.get(id) ?? {
        id,
        component: `${owner}/${job[3]}`,
        workSpecId: null,
        required: null,
        unsatisfied: null,
      }
      jobs.set(id, current)
      continue
    }
    if (current === null) continue
    if (raw.trim() !== '' && !/^\s/.test(raw)) {
      current = null
      continue
    }
    const required = /Required constraints:\s*(.*)$/.exec(raw)?.[1]
    if (required !== undefined && current.required === null) current.required = required.trim() || null
    const unsatisfied = /Unsatisfied constraints:\s*(.*)$/.exec(raw)?.[1]
    if (unsatisfied !== undefined && current.unsatisfied === null) {
      current.unsatisfied = unsatisfied.trim() || null
    }
    const spec = /EXTRA_WORK_SPEC_ID=([\w-]+)/.exec(raw)?.[1]
    if (spec !== undefined && current.workSpecId === null) current.workSpecId = spec
  }
  return [...jobs.values()]
}

// --- the jobscheduler command fixer ----------------------------------------

export type FixContext = {
  pkg: string | null
  jobs: readonly Job[]
  serialToInsert: string | null
}

export type Fix = { command: string; notes: string[] } | { deny: string }

const RUN = /\bcmd\s+jobscheduler\s+run\b/g
const SEGMENT_END = /[;&|'"\n)`]/

export function fixJobschedulerCommand(command: string, ctx: FixContext): Fix {
  const notes: string[] = []
  let out = ''
  let from = 0
  for (const match of command.matchAll(RUN)) {
    const start = match.index
    const afterRun = start + match[0].length
    const rest = command.slice(afterRun)
    const end = rest.search(SEGMENT_END)
    const tail = end === -1 ? rest : rest.slice(0, end)
    const trailing = /\s*$/.exec(tail)?.[0] ?? ''
    const tokens = tail.trim().split(/\s+/).filter(Boolean)

    let isForced = false
    let isSatisfied = false
    const flags: string[] = []
    const positional: string[] = []
    let isUnknown = false
    for (let i = 0; i < tokens.length; i++) {
      const t = tokens[i]!
      if (t === '-f' || t === '--force') isForced = true
      else if (t === '-s' || t === '--satisfied') isSatisfied = true
      else if (['-u', '--user', '-n', '--namespace'].includes(t) && tokens[i + 1] !== undefined) {
        flags.push(t, tokens[++i]!)
      } else if (t.startsWith('-') && !/^-\d+$/.test(t)) flags.push(t)
      else positional.push(t)
    }
    let pkg: string | null = null
    let id: string | null = null
    for (const p of positional) {
      if (/^-?\d+$/.test(p) && id === null) id = p
      else if (PACKAGE.test(p) && pkg === null) pkg = p
      else isUnknown = true
    }
    if (isUnknown) continue

    const segmentNotes: string[] = []
    if (positional.length === 2 && positional[0] === id) segmentNotes.push('put the package before the job id')
    if (!isForced && !isSatisfied) {
      isForced = true
      segmentNotes.push('added -f so the job runs even with unmet constraints')
    }
    if (pkg === null) {
      if (ctx.pkg === null) {
        return {
          deny:
            'android-device-console: `cmd jobscheduler run` needs the package before the job id ' +
            '(`cmd jobscheduler run -f <package> <job-id>`), and no application id is known. ' +
            'Add the package, or call mcp__android-device-console__run_worker.',
        }
      }
      pkg = ctx.pkg
      segmentNotes.push(`added the package ${pkg}`)
    }
    if (id === null) {
      const known = ctx.jobs.filter(job => job.component.startsWith(`${pkg}/`))
      if (known.length === 1) {
        id = String(known[0]!.id)
        segmentNotes.push(`added job id ${id}, the only job scheduled for ${pkg}`)
      } else {
        const list = known
          .map(job => `${job.id}${job.workSpecId ? ` (WorkSpec ${job.workSpecId})` : ''}`)
          .join(', ')
        return {
          deny:
            `android-device-console: \`cmd jobscheduler run\` needs a job id after ${pkg}. ` +
            (known.length > 1
              ? `Scheduled jobs for ${pkg}: ${list}. Pick one.`
              : `No scheduled job for ${pkg} is known; list them with \`adb shell dumpsys jobscheduler ${pkg}\`.`) +
            ' Or call mcp__android-device-console__run_worker.',
        }
      }
    }
    if (segmentNotes.length === 0) continue

    const rebuilt = ['cmd jobscheduler run', isForced ? '-f' : '', isSatisfied ? '-s' : '', ...flags, pkg, id]
      .filter(Boolean)
      .join(' ')
    out += command.slice(from, start) + rebuilt + trailing
    from = afterRun + tail.length
    notes.push(...segmentNotes)
  }
  let fixed = out + command.slice(from)

  if (ctx.serialToInsert !== null && notes.length > 0 && !/\badb\s+-[sdet]\b/.test(fixed)) {
    const before = fixed
    fixed = fixed.replace(/\badb(\s+)shell\b/g, `adb -s ${ctx.serialToInsert}$1shell`)
    if (fixed !== before) notes.push(`targeted ${ctx.serialToInsert} with -s`)
  }
  return { command: fixed, notes }
}

// --- the system-prompt section --------------------------------------------

function onOff(value: boolean | null, unknown = 'unknown'): string {
  return value === null ? unknown : value ? 'on' : 'off'
}

export function describeDevice(state: DeviceState, pkg: string | null): string {
  const name = [state.serial, state.model, state.api !== null ? `API ${state.api}` : null]
    .filter(Boolean)
    .join(', ')
  const density =
    state.density === null
      ? 'unknown'
      : state.physicalDensity !== null && state.density !== state.physicalDensity
        ? `${state.density} dpi (overridden; physical ${state.physicalDensity})`
        : `${state.density} dpi (default)`
  const ui = [
    `dark mode ${onOff(state.isDark, 'auto/unknown')}`,
    `font scale ${state.fontScale ?? 'unknown'}${state.fontScale !== null && state.fontScale !== 1 ? ' (not default)' : ''}`,
    `density ${density}`,
    `forced RTL ${onOff(state.isRtl)}`,
    `layout bounds ${onOff(state.hasLayoutBounds)}`,
    `animations ${onOff(state.hasAnimations)}`,
  ].join(', ')
  const bg = [
    state.deepIdle !== null ? `Doze deep ${state.deepIdle}` : null,
    state.lightIdle !== null ? `light ${state.lightIdle}` : null,
    pkg !== null && state.bucket !== null ? `${pkg} standby bucket ${state.bucket}` : null,
  ]
    .filter(Boolean)
    .join(', ')
  return [
    `# Attached Android device (android-device-console)`,
    `Target: ${name}.`,
    `UI state now: ${ui}.`,
    bg ? `Background state: ${bg}.` : '',
    'Account for these when you judge a screenshot or UI behaviour on this device. ' +
      'Change them with mcp__android-device-console__set_device_state and set_doze; ' +
      'force-run a WorkManager job with run_worker.',
  ]
    .filter(Boolean)
    .join('\n')
}
