import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, Timer } from 'claude-code'

import type { Device, DeviceState, ExecMode, Job } from '../types'
import {
  BUCKET_NAMES,
  DEFAULTS,
  type DeviceChanges,
  PACKAGE,
  changeScript,
  describeDevice,
  dozeScript,
  fixJobschedulerCommand,
  isJobMissing,
  isRtlLocaleList,
  jobLabel,
  parseAppLocales,
  nextDensity,
  nextFontScale,
  parseDevices,
  parseJobs,
  parseState,
  pickTarget,
  readChanges,
  runJobScript,
  shellQuote,
  stateScript,
  splitSections,
} from './adb'

type $ = EngineInterface

const PLUGIN = 'android-device-console'
const PANE = 'device-console'
const TOOL_SET = 'mcp__android-device-console__set_device_state'
const TOOL_RUN = 'mcp__android-device-console__run_worker'
const TOOL_DOZE = 'mcp__android-device-console__set_doze'

const mode = atom({ plugin: 'android-device-console', key: 'mode' } as const, null)
const adbPath = atom({ plugin: 'android-device-console', key: 'adb' } as const, 'adb')
const probeNote = atom({ plugin: 'android-device-console', key: 'probeNote' } as const, null)
const devices = atom({ plugin: 'android-device-console', key: 'devices' } as const, [])
const chosenSerial = atom({ plugin: 'android-device-console', key: 'chosenSerial' } as const, null)
const device = atom({ plugin: 'android-device-console', key: 'device' } as const, null)
const jobs = atom({ plugin: 'android-device-console', key: 'jobs' } as const, [])
const pkgAtom = atom({ plugin: 'android-device-console', key: 'pkg' } as const, null)
const busy = atom({ plugin: 'android-device-console', key: 'busy' } as const, null)
const lastMessage = atom({ plugin: 'android-device-console', key: 'lastMessage' } as const, null)
const rtlRestore = atom({ plugin: 'android-device-console', key: 'rtlRestore' } as const, null)

type Ran = { ok: boolean; out: string; err: string }
type Ctx = { serial?: string; consent?: string; pkg?: string }

let configuredPkg: string | null = null
let pollMs = 15000
let poller: Timer | null = null
let isPolling = false

// --- host commands: $.process where the host has it, else the Bash tool --

async function probe($: $): Promise<ExecMode> {
  const known = await read($, mode)
  if (known !== null) return known
  const home = await $.env.get('ANDROID_HOME')
  const sdkRoot = await $.env.get('ANDROID_SDK_ROOT')
  const userHome = await $.env.get('HOME')
  const candidates = [
    'adb',
    home && `${home}/platform-tools/adb`,
    sdkRoot && `${sdkRoot}/platform-tools/adb`,
    userHome && `${userHome}/Library/Android/sdk/platform-tools/adb`,
    userHome && `${userHome}/Android/Sdk/platform-tools/adb`,
  ].filter((c): c is string => Boolean(c))
  let reason = ''
  for (const candidate of candidates) {
    try {
      const r = await $.process.run([candidate, 'version'], { timeoutMs: 5000 })
      if (r.exitCode === 0) {
        await update($, adbPath, () => candidate)
        await update($, probeNote, () => null)
        await update($, mode, () => 'process' as const)
        return 'process'
      }
      reason = r.stderr.trim() || `exit ${r.exitCode}`
    } catch (err) {
      reason = err instanceof Error ? err.message : String(err)
    }
  }
  await update($, adbPath, () => 'adb')
  await update($, probeNote, () => `$.process could not run adb here (${reason.slice(0, 160)}); adb runs through the Bash tool.`)
  await update($, mode, () => 'bash' as const)
  return 'bash'
}

async function adb($: $, args: readonly string[], why: string, consent?: string): Promise<Ran> {
  const how = await probe($)
  const argv = [await read($, adbPath), ...args]
  if (how === 'process') {
    try {
      const r = await $.process.run(argv, { timeoutMs: 30000 })
      return { ok: r.exitCode === 0, out: r.stdout, err: r.stderr }
    } catch (err) {
      return { ok: false, out: '', err: err instanceof Error ? err.message : String(err) }
    }
  }
  const ran = await $.tool.call({
    tool: 'Bash',
    command: shellQuote(argv),
    description: why,
    ...(consent ? { consent } : {}),
  })
  if (ran.deny !== undefined) return { ok: false, out: '', err: ran.deny }
  if (ran.isError) return { ok: false, out: '', err: ran.text ?? String(ran.result) }
  return { ok: true, out: ran.result.stdout, err: ran.result.stderr }
}

// --- target device and package -------------------------------------------

async function refreshDevices($: $, consent?: string): Promise<Device[]> {
  const r = await adb($, ['devices', '-l'], 'List connected Android devices', consent)
  const list = r.ok ? parseDevices(r.out) : []
  await update($, devices, () => list)
  return list
}

async function target($: $, ctx: Ctx): Promise<{ serial: string } | { error: string }> {
  if (ctx.serial) return { serial: ctx.serial }
  const env = await $.env.get('ANDROID_SERIAL')
  if (env) return { serial: env }
  let list = await read($, devices)
  if (list.filter(d => d.state === 'device').length === 0) list = await refreshDevices($, ctx.consent)
  return pickTarget(list, undefined, await read($, chosenSerial))
}

async function resolvePkg($: $, explicit?: string): Promise<string | null> {
  if (explicit && PACKAGE.test(explicit)) return explicit
  if (configuredPkg) return configuredPkg
  const cached = await read($, pkgAtom)
  if (cached !== null) return cached
  for (const file of ['app/build.gradle.kts', 'app/build.gradle']) {
    try {
      const text = await $.fs.read(file)
      const id = /applicationId\s*=?\s*["']([\w.]+)["']/.exec(text)?.[1]
      if (id) {
        await update($, pkgAtom, () => id)
        return id
      }
    } catch {
      // not this file
    }
  }
  return null
}

async function shell($: $, ctx: Ctx, script: string, why: string): Promise<{ serial: string; ran: Ran } | { error: string }> {
  const t = await target($, ctx)
  if ('error' in t) return t
  const ran = await adb($, ['-s', t.serial, 'shell', script], why, ctx.consent)
  if (!ran.ok && /not found|offline|unauthorized|no devices/i.test(ran.err)) {
    await update($, devices, () => [])
  }
  return { serial: t.serial, ran }
}

async function storeState($: $, serial: string, stdout: string, pkg: string | null): Promise<DeviceState> {
  const state = parseState(serial, stdout, await $.clock.now())
  await update($, device, () => state)
  if (pkg !== null) await update($, pkgAtom, () => pkg)
  return state
}

// --- actions shared by the tools, the band, the pane and /device ---------

async function withBusy<T>($: $, label: string, work: () => Promise<T>): Promise<T> {
  await update($, busy, () => label)
  try {
    return await work()
  } finally {
    await update($, busy, () => null)
  }
}

async function refreshState($: $, ctx: Ctx): Promise<string> {
  const pkg = await resolvePkg($, ctx.pkg)
  const r = await shell($, ctx, stateScript(pkg), 'Read Android device UI and Doze state')
  if ('error' in r) return r.error
  if (!r.ran.ok) return `Reading device state failed: ${r.ran.err.trim()}`
  const state = await storeState($, r.serial, r.ran.out, pkg)
  return describeDevice(state, pkg)
}

async function setDeviceState($: $, changes: DeviceChanges, ctx: Ctx & { restartApp?: boolean }): Promise<{ text: string } | { error: string }> {
  const pkg = await resolvePkg($, ctx.pkg)
  const options = { restartPkg: ctx.restartApp ? pkg : null, pkg, restoreLocales: await read($, rtlRestore) }
  const script = `echo @@out; ${changeScript(changes, options)}; ${stateScript(pkg)}`
  const r = await shell($, ctx, script, 'Set Android device UI state')
  if ('error' in r) return r
  if (!r.ran.ok) return { error: `adb failed: ${r.ran.err.trim() || r.ran.out.trim()}` }
  const sections = splitSections(r.ran.out)
  if (changes.rtl === true) {
    // Keep the app's own locales to put back, unless they are already an RTL one.
    const before = parseAppLocales(sections.get('rtlprev'))
    if (before !== null && !isRtlLocaleList(before)) await update($, rtlRestore, () => before)
  } else if (changes.rtl === false) {
    await update($, rtlRestore, () => null)
  }
  const state = await storeState($, r.serial, r.ran.out, pkg)
  return { text: `Applied on ${r.serial}.\n${describeDevice(state, pkg)}${rtlNote(changes, sections.get('rtlvia'), ctx.restartApp === true)}` }
}

function rtlNote(changes: DeviceChanges, via: string | undefined, isRestarted: boolean): string {
  if (changes.rtl !== true) return ''
  if (via === 'app-locale') {
    return (
      "\nForced RTL through the app's per-app locale (he, Hebrew): its activities recreate right-to-left at once. " +
      'Text stays in the default language unless the app ships Hebrew strings; system UI stays left-to-right. ' +
      'RTL off, or reset, puts back the locales the app had.'
    )
  }
  return (
    '\nForced RTL through the developer setting debug.force_rtl' +
    (isRestarted ? ' and an app restart' : '') +
    '. On Android 13+ it takes effect only after a configuration change or a reboot; ' +
    'with the app package known, API 33+ uses a per-app RTL locale instead, which applies at once.'
  )
}

async function setDoze($: $, input: { state?: 'idle' | 'off'; bucket?: string }, ctx: Ctx): Promise<{ text: string } | { error: string }> {
  const pkg = await resolvePkg($, ctx.pkg)
  if (input.bucket !== undefined && pkg === null) {
    return { error: 'A standby bucket needs the application id: pass package, or set it in the plugin options.' }
  }
  const script = `echo @@out; ${dozeScript(input.state, input.bucket, pkg)}; ${stateScript(pkg)}`
  const r = await shell($, ctx, script, 'Change Android Doze or app standby state')
  if ('error' in r) return r
  if (!r.ran.ok) return { error: `adb failed: ${r.ran.err.trim() || r.ran.out.trim()}` }
  const state = await storeState($, r.serial, r.ran.out, pkg)
  const out = splitSections(r.ran.out).get('out') ?? ''
  return { text: `${out ? `${out}\n` : ''}${describeDevice(state, pkg)}` }
}

async function refreshJobs($: $, ctx: Ctx): Promise<{ jobs: Job[]; pkg: string } | { error: string }> {
  const pkg = await resolvePkg($, ctx.pkg)
  if (pkg === null) return { error: 'No application id is known: pass package, or set it in the plugin options.' }
  const r = await shell($, ctx, `dumpsys jobscheduler ${pkg}`, `List scheduled jobs for ${pkg}`)
  if ('error' in r) return r
  if (!r.ran.ok) return { error: `dumpsys jobscheduler failed: ${r.ran.err.trim()}` }
  const list = parseJobs(r.ran.out, pkg)
  await update($, jobs, () => list)
  return { jobs: list, pkg }
}

type RunInput = { jobId?: number; workSpecId?: string; namespace?: string }

async function runWorker($: $, input: RunInput, ctx: Ctx): Promise<{ text: string } | { error: string }> {
  const pkg = await resolvePkg($, ctx.pkg)
  if (pkg === null) return { error: 'No application id is known: pass package, or set it in the plugin options.' }
  const named = (list: readonly Job[]) =>
    list.filter(job => job.id === input.jobId && (input.namespace === undefined || job.namespace === input.namespace))

  let job: Job | undefined
  let note = ''
  if (input.jobId === undefined) {
    const listed = await refreshJobs($, { ...ctx, pkg })
    if ('error' in listed) return listed
    const matches = input.workSpecId ? listed.jobs.filter(one => one.workSpecId === input.workSpecId) : listed.jobs
    if (matches.length !== 1) return { error: pickError(pkg, listed.jobs, matches.length, input.workSpecId) }
    job = matches[0]!
  } else {
    job = named(await read($, jobs))[0]
    if (job === undefined) {
      const listed = await refreshJobs($, { ...ctx, pkg })
      if ('error' in listed) return listed
      job = named(listed.jobs)[0]
      if (job === undefined) {
        const stale = replacement(listed.jobs, input.jobId)
        if ('error' in stale) return { error: `${stale.error} ${pickError(pkg, listed.jobs, listed.jobs.length)}` }
        ;({ job, note } = stale)
      }
    }
  }

  let r = await shell($, ctx, runJobScript(pkg, job), `Force-run job ${job.id} of ${pkg}`)
  if ('error' in r) return r
  let out = `${r.ran.out}${r.ran.err}`.trim()
  if (isJobMissing(out)) {
    // WorkManager gives the work a new job id each time it is enqueued.
    const listed = await refreshJobs($, { ...ctx, pkg })
    if ('error' in listed) return listed
    const stale = replacement(listed.jobs, job.id, job)
    if ('error' in stale) return { error: `Job ${jobLabel(job)} did not run: ${out}. ${pickError(pkg, listed.jobs, listed.jobs.length)}` }
    ;({ job, note } = stale)
    r = await shell($, ctx, runJobScript(pkg, job), `Force-run job ${job.id} of ${pkg}`)
    if ('error' in r) return r
    out = `${r.ran.out}${r.ran.err}`.trim()
  }
  if (!r.ran.ok || isJobMissing(out) || /unknown|error|exception/i.test(out)) {
    return { error: `Job ${jobLabel(job)} did not run: ${out}` }
  }
  return {
    text: `Forced job ${jobLabel(job)} of ${pkg} on ${r.serial}: ${out || 'started'}.${note} Read logcat for the Worker's output.`,
  }
}

/** The job that took a gone id's place: the only one left, or the only one like the old. */
function replacement(list: readonly Job[], goneId: number, like?: Job): { job: Job; note: string } | { error: string } {
  const same = like ? list.filter(one => one.namespace === like.namespace && one.component === like.component) : []
  const pick = same.length === 1 ? same[0]! : list.length === 1 ? list[0]! : undefined
  if (pick === undefined) return { error: `Job ${goneId} is no longer scheduled.` }
  return {
    job: pick,
    note: ` Job ${goneId} is no longer scheduled; ran job ${pick.id}, which took its place (WorkManager gives work a new job id on each enqueue).`,
  }
}

function pickError(pkg: string, all: readonly Job[], matched: number, workSpecId?: string): string {
  const list = all.map(jobLabel).join(', ')
  return matched === 0
    ? `No scheduled job for ${pkg}${workSpecId ? ` with WorkSpec ${workSpecId}` : ''}. Jobs: ${list || 'none'}. Enqueue the work first.`
    : `${matched} jobs are scheduled for ${pkg}: ${list}. Pass jobId (and namespace when two share an id) or workSpecId.`
}

async function resetAll($: $, ctx: Ctx): Promise<string> {
  const set = await setDeviceState($, DEFAULTS, ctx)
  if ('error' in set) return set.error
  const doze = await setDoze($, { state: 'off' }, ctx)
  return 'error' in doze ? doze.error : `Reset to defaults.\n${doze.text}`
}

// --- polling: only through $.process, never through the Bash tool -------

async function pollOnce($: $): Promise<void> {
  if (isPolling) return
  isPolling = true
  try {
    if ((await read($, mode)) !== 'process') return
    await refreshDevices($)
    const t = await target($, {})
    if ('error' in t) {
      await update($, device, () => null)
      return
    }
    await refreshState($, { serial: t.serial })
  } catch {
    // the next period tries again
  } finally {
    isPolling = false
  }
}

async function ensurePoller($: $): Promise<void> {
  if (poller !== null || pollMs === 0) return
  if ((await probe($)) !== 'process') return
  poller = $.clock.every(pollMs, () => void pollOnce($))
}

function field(e: unknown, key: string): unknown {
  return (e as Record<string, unknown>)[key]
}
function str(e: unknown, key: string): string | undefined {
  const v = field(e, key)
  return typeof v === 'string' && v ? v : undefined
}

/** A pane key per job: its id, and its namespace when it has one (ids repeat across namespaces). */
function jobKey(job: Job): string {
  return job.namespace ? `${job.id}-${job.namespace}` : String(job.id)
}

function press(label: string): string {
  return `The user pressed "${label}" in the Android device console`
}

async function toggleAction($: $, label: string, changes: DeviceChanges): Promise<void> {
  const r = await withBusy($, label, () => setDeviceState($, changes, { consent: press(label) }))
  await update($, lastMessage, () => ('error' in r ? r.error : `${label}: done`))
}

function toggles($: $, state: DeviceState) {
  const font = state.fontScale ?? 1
  const nextDpi = nextDensity(state)
  return [
    { key: 'dark', hotkey: '1', label: `Dark ${state.isDark ? 'on' : 'off'}`, changes: { dark: !state.isDark } },
    { key: 'font', hotkey: '2', label: `Font ${font}×`, changes: { fontScale: nextFontScale(font) } },
    {
      key: 'density',
      hotkey: '3',
      label: `Density ${state.density ?? '?'}${state.density !== state.physicalDensity ? '*' : ''}`,
      changes: { density: nextDpi },
    },
    { key: 'rtl', hotkey: '4', label: `RTL ${state.isRtl ? 'on' : 'off'}`, changes: { rtl: !state.isRtl } },
    {
      key: 'bounds',
      hotkey: '5',
      label: `Bounds ${state.hasLayoutBounds ? 'on' : 'off'}`,
      changes: { layoutBounds: !state.hasLayoutBounds },
    },
    {
      key: 'anims',
      hotkey: '6',
      label: `Anims ${state.hasAnimations === false ? 'off' : 'on'}`,
      changes: { animations: state.hasAnimations === false },
    },
  ].map(t => ({ ...t, onPress: () => void toggleAction($, t.label, t.changes) }))
}

export const register: Register = (on, options) => {
  configuredPkg = typeof options.package === 'string' && options.package.trim() ? options.package.trim() : null
  pollMs = typeof options.pollSeconds === 'number' ? Math.max(0, options.pollSeconds) * 1000 : 15000
  poller = null
  isPolling = false

  // --- session start: register, probe, first read ---------------------------

  on('session.start', async ($, e, next) => {
    await $.tool.register({
      name: 'set_device_state',
      description:
        'Set live UI state on the attached Android device or emulator through adb: dark mode, font scale, ' +
        'display density, forced RTL, layout bounds, animations. Answers the device state afterwards. ' +
        'Use before judging a screenshot under a configuration (for example dark + font 1.3 + RTL).',
      isDeferred: false,
      inputSchema: {
        type: 'object',
        properties: {
          dark: { type: 'boolean', description: 'Night mode on (true) or off (false).' },
          fontScale: { type: 'number', description: 'System font scale, 0.5 to 3 (1 is default).' },
          density: {
            description: 'Display density in dpi, or "reset" for the physical density.',
            anyOf: [{ type: 'integer' }, { type: 'string', enum: ['reset'] }],
          },
          rtl: { type: 'boolean', description: 'Force RTL layout direction.' },
          layoutBounds: { type: 'boolean', description: 'Show layout bounds.' },
          animations: { type: 'boolean', description: 'false sets all three animation scales to 0.' },
          restartApp: { type: 'boolean', description: 'Force-stop and relaunch the app afterwards (needed for RTL).' },
          serial: { type: 'string', description: 'adb serial; defaults to ANDROID_SERIAL or the one device.' },
          package: { type: 'string', description: 'applicationId; defaults to the project app.' },
        },
      },
    })
    await $.tool.register({
      name: 'run_worker',
      description:
        "Force-run a scheduled WorkManager/JobScheduler job of the app (`cmd jobscheduler run -f`, with `-n <namespace>` on API 34+ " +
        "where WorkManager schedules in androidx.work.systemjobscheduler), ignoring its constraints. With no jobId it lists the app's " +
        'jobs and runs the only one, or the one whose WorkSpec id matches. Job ids change each time work is enqueued; a gone id is re-resolved.',
      isDeferred: false,
      inputSchema: {
        type: 'object',
        properties: {
          jobId: { type: 'integer', description: 'JobScheduler job id.' },
          workSpecId: { type: 'string', description: 'WorkManager WorkSpec UUID (EXTRA_WORK_SPEC_ID; dumpsys shows it only before API 34).' },
          namespace: { type: 'string', description: 'JobScheduler namespace, when two jobs share an id. Found from the job list otherwise.' },
          serial: { type: 'string' },
          package: { type: 'string' },
        },
      },
    })
    await $.tool.register({
      name: 'set_doze',
      description:
        "Force the device into Doze deep idle ('idle', also unplugs the battery) or back out ('off'), " +
        'and/or set the app standby bucket. Answers the Doze and bucket state afterwards.',
      isDeferred: false,
      inputSchema: {
        type: 'object',
        properties: {
          state: { type: 'string', enum: ['idle', 'off'] },
          bucket: { type: 'string', enum: [...BUCKET_NAMES] },
          serial: { type: 'string' },
          package: { type: 'string' },
        },
      },
    })
    await $.command.register({
      name: 'device',
      description: 'Android device console: UI toggles, Doze, standby bucket, jobs. `/device reset` restores defaults.',
      argumentHint: '[reset]',
    })
    const started = await next(e)
    if ((await probe($)) === 'process') {
      void pollOnce($)
      await ensurePoller($)
    }
    return started
  })

  // --- /device ---------------------------------------------------------------

  on('command.run', { command: 'device' }, async ($, e) => {
    const consent = `The user ran /device ${e.args}`.trim()
    await ensurePoller($)
    if (e.args.trim() === 'reset') {
      const text = await withBusy($, 'resetting', () => resetAll($, { consent }))
      await update($, lastMessage, () => text.split('\n')[0] ?? null)
      return { text }
    }
    await $.ui.open({ id: PANE, title: 'Android device', focus: true })
    const text = await withBusy($, 'reading', async () => {
      const state = await refreshState($, { consent })
      const listed = await refreshJobs($, { consent })
      const jobLine = 'error' in listed ? listed.error : `${listed.jobs.length} scheduled job(s) for ${listed.pkg}.`
      return `${state}\n${jobLine}`
    })
    const note = await read($, probeNote)
    return { text: note ? `${text}\n${note}` : text }
  })

  // --- model tools -----------------------------------------------------------

  on('tool.call', { tool: TOOL_SET }, async ($, e) => {
    const changes = readChanges(e as Record<string, unknown>)
    if ('error' in changes) return { deny: changes.error }
    await ensurePoller($)
    const r = await withBusy($, 'setting state', () =>
      setDeviceState($, changes, {
        serial: str(e, 'serial'),
        pkg: str(e, 'package'),
        restartApp: field(e, 'restartApp') === true,
      }),
    )
    return 'error' in r ? { deny: r.error } : { result: r.text }
  }).catch(() => ({ deny: 'android-device-console: set_device_state failed inside the plugin.' }))

  on('tool.call', { tool: TOOL_RUN }, async ($, e) => {
    const jobId = field(e, 'jobId')
    if (jobId !== undefined && !Number.isInteger(jobId)) return { deny: 'jobId must be an integer.' }
    const r = await withBusy($, 'running job', () =>
      runWorker(
        $,
        { jobId: jobId as number | undefined, workSpecId: str(e, 'workSpecId'), namespace: str(e, 'namespace') },
        { serial: str(e, 'serial'), pkg: str(e, 'package') },
      ),
    )
    return 'error' in r ? { deny: r.error } : { result: r.text }
  }).catch(() => ({ deny: 'android-device-console: run_worker failed inside the plugin.' }))

  on('tool.call', { tool: TOOL_DOZE }, async ($, e) => {
    const state = field(e, 'state')
    const bucket = field(e, 'bucket')
    if (state !== undefined && state !== 'idle' && state !== 'off') return { deny: "state must be 'idle' or 'off'." }
    if (bucket !== undefined && !(BUCKET_NAMES as readonly unknown[]).includes(bucket)) {
      return { deny: `bucket must be one of ${BUCKET_NAMES.join(', ')}.` }
    }
    if (state === undefined && bucket === undefined) return { deny: 'Name state, bucket, or both.' }
    const r = await withBusy($, 'changing Doze', () =>
      setDoze(
        $,
        { state: state as 'idle' | 'off' | undefined, bucket: bucket as string | undefined },
        { serial: str(e, 'serial'), pkg: str(e, 'package') },
      ),
    )
    return 'error' in r ? { deny: r.error } : { result: r.text }
  }).catch(() => ({ deny: 'android-device-console: set_doze failed inside the plugin.' }))

  // --- fix the model's hand-typed `cmd jobscheduler run` ----------------------

  on('tool.call', { tool: 'Bash', command: /\bcmd\s+jobscheduler\s+run\b/ }, async ($, e, next) => {
    const env = await $.env.get('ANDROID_SERIAL')
    const ready = (await read($, devices)).filter(d => d.state === 'device')
    const chosen = await read($, chosenSerial)
    const fix = fixJobschedulerCommand(e.command, {
      pkg: await resolvePkg($),
      jobs: await read($, jobs),
      serialToInsert: !env && ready.length > 1 && chosen !== null ? chosen : null,
    })
    if ('deny' in fix) return { deny: fix.deny }
    const command = fix.notes.length === 0 ? e.command : fix.command
    const ran = await next(command === e.command ? e : { ...e, command })
    if (ran.deny !== undefined) return ran
    const notes: string[] = []
    if (fix.notes.length > 0) notes.push(`android-device-console rewrote the command (${fix.notes.join('; ')}): ${command}`)
    const said = `${ran.text ?? ''}\n${ran.isError ? String(ran.result ?? '') : ''}`
    if (isJobMissing(said) && !/\s(-n|--namespace)\s/.test(command)) {
      notes.push(
        'android-device-console: on API 34+ WorkManager 2.9+ schedules its jobs in the JobScheduler namespace ' +
          'androidx.work.systemjobscheduler, and the job id changes on each enqueue. Retry with ' +
          '`-n androidx.work.systemjobscheduler`, or call mcp__android-device-console__run_worker, which resolves both.',
      )
    }
    return notes.length === 0 ? ran : { ...ran, context: [...(ran.context ?? []), ...notes] }
  }).catch(($, e, next) => next(e))

  // --- system prompt: the device state the model judges UI under ------------

  on('prompt.compose', async ($, e, next) => {
    const composed = await next(e)
    const state = await read($, device)
    if (state === null) return composed
    const section = { id: `${PLUGIN}:device`, text: describeDevice(state, await read($, pkgAtom)), scope: 'session' as const }
    return { sections: [...composed.sections, section] }
  })

  // --- drawing ---------------------------------------------------------------

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const state = await read($, device)
    if (e.props.hasSurvey || state === null) return next(e)
    const working = await read($, busy)
    const { Box, Text, Button } = $.ui.resolve(e)
    return (
      <Box flexDirection="row" flexWrap="wrap" columnGap={1}>
        <Text dimColor>{state.model ?? state.serial}{working ? ` · ${working}…` : ''}</Text>
        {toggles($, state).map(t => (
          <Button key={t.key} hotkey={t.hotkey} label={t.label} onPress={t.onPress} />
        ))}
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const els = $.ui.resolve(e)
    const { Box, Text, Button } = els
    const state = await read($, device)
    const list = await read($, devices)
    const chosen = await read($, chosenSerial)
    const jobList = await read($, jobs)
    const pkg = await read($, pkgAtom)
    const working = await read($, busy)
    const message = await read($, lastMessage)
    const note = await read($, probeNote)
    const ready = list.filter(d => d.state === 'device')
    const consent = (label: string) => press(label)

    const refresh = () =>
      void withBusy($, 'reading', async () => {
        await refreshDevices($, consent('Refresh'))
        await refreshState($, { consent: consent('Refresh') })
        await refreshJobs($, { consent: consent('Refresh') })
      })
    const doze = (label: string, input: { state?: 'idle' | 'off'; bucket?: string }) =>
      void withBusy($, label, async () => {
        const r = await setDoze($, input, { consent: consent(label) })
        await update($, lastMessage, () => ('error' in r ? r.error : `${label}: done`))
      })
    const run = (job: Job) =>
      void withBusy($, `running ${job.id}`, async () => {
        const r = await runWorker($, { jobId: job.id, namespace: job.namespace ?? undefined }, { consent: consent(`Run job ${job.id}`) })
        await update($, lastMessage, () => ('error' in r ? r.error : r.text))
      })

    const Select = 'Select' in els ? els.Select : null

    return (
      <Box flexDirection="column" rowGap={1}>
        <Box flexDirection="row" columnGap={1} flexWrap="wrap">
          <Text bold>{state ? `${state.model ?? ''} ${state.serial}${state.api ? ` · API ${state.api}` : ''}` : 'No device read yet'}</Text>
          {working ? <Text dimColor>{working}…</Text> : null}
          <Button key="refresh" hotkey="r" label="Refresh" onPress={refresh} />
        </Box>
        {ready.length > 1 && Select ? (
          <Select
            key="serial"
            label="Target"
            value={chosen ?? undefined}
            options={ready.map(d => ({ value: d.serial, label: d.model ? `${d.serial} ${d.model}` : d.serial }))}
            onSelect={value => void update($, chosenSerial, () => value).then(refresh)}
          />
        ) : null}
        {state ? (
          <Box flexDirection="row" columnGap={1} flexWrap="wrap">
            {toggles($, state).map(t => (
              <Button key={t.key} hotkey={t.hotkey} label={t.label} onPress={t.onPress} />
            ))}
            <Button key="reset" label="Reset all" onPress={() => void withBusy($, 'resetting', async () => {
              const text = await resetAll($, { consent: consent('Reset all') })
              await update($, lastMessage, () => text.split('\n')[0] ?? null)
            })} />
          </Box>
        ) : null}
        <Text bold>Doze and standby{pkg ? ` · ${pkg}` : ''}</Text>
        <Text dimColor>
          {state ? `deep ${state.deepIdle ?? '?'} · light ${state.lightIdle ?? '?'} · bucket ${state.bucket ?? '?'}` : 'unknown'}
        </Text>
        <Box flexDirection="row" columnGap={1} flexWrap="wrap">
          <Button key="idle" hotkey="i" label="Force idle" onPress={() => doze('Force idle', { state: 'idle' })} />
          <Button key="unforce" hotkey="u" label="Unforce" onPress={() => doze('Unforce', { state: 'off' })} />
          {Select && pkg ? (
            <Select
              key="bucket"
              label="Bucket"
              value={state?.bucket && (BUCKET_NAMES as readonly string[]).includes(state.bucket) ? state.bucket : undefined}
              options={BUCKET_NAMES.map(b => ({ value: b }))}
              onSelect={value => doze(`Bucket ${value}`, { bucket: value })}
            />
          ) : null}
        </Box>
        <Text bold>Scheduled jobs</Text>
        {jobList.length === 0 ? <Text dimColor>None listed. Refresh after enqueueing work.</Text> : null}
        {jobList.map(job => (
          <Box key={`job-${jobKey(job)}`} flexDirection="row" columnGap={1}>
            <Button key={`run-${jobKey(job)}`} label={`Run ${job.id}`} onPress={() => run(job)} />
            <Text wrap="truncate-end">
              {job.component.split('/').pop()}
              {job.namespace === 'androidx.work.systemjobscheduler' ? ' · WorkManager' : job.namespace ? ` · ${job.namespace}` : ''}
              {job.workSpecId ? ` · ${job.workSpecId.slice(0, 8)}` : ''}
              {job.unsatisfied ? ` · waiting on ${job.unsatisfied}` : ''}
            </Text>
          </Box>
        ))}
        {message ? <Text dimColor>{message}</Text> : null}
        {note ? <Text dimColor>{note}</Text> : null}
      </Box>
    )
  })
}
