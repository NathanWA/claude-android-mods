import { atom, read, update } from 'claude-code'
import type { CommandSpec, EngineInterface, On, PluginOptions, Register, Timer } from 'claude-code'

import type { MirrorFrame } from '../types'
import {
  compactUiTree,
  inputText,
  isAppModule,
  parseApplicationId,
  parseDevices,
  parseSipsSize,
  pickPackage,
  pickTarget,
  shellLine,
  shellQuote,
} from './parse'
import type { ListedDevice } from './parse'

// ─── State the mirror pane draws from ─────────────────────────────────────────

const mirror = atom({ plugin: 'android-screen', key: 'mirror' } as const, null as MirrorFrame | null)
const mirrorStatus = atom({ plugin: 'android-screen', key: 'mirrorStatus' } as const, '')
const mirrorSerial = atom({ plugin: 'android-screen', key: 'mirrorSerial' } as const, null as string | null)
const mirrorChoices = atom({ plugin: 'android-screen', key: 'mirrorChoices' } as const, [] as string[])

type Engine = EngineInterface

type Ctx = {
  options: PluginOptions
}

function option(ctx: Ctx, name: string): string {
  const value = ctx.options[name]
  return typeof value === 'string' ? value.trim() : ''
}

function numberOption(ctx: Ctx, name: string, fallback: number): number {
  const value = ctx.options[name]
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback
}

// ─── Running adb ──────────────────────────────────────────────────────────────

type Ran = { ok: boolean; out: string; err: string }

// `process`: $.process runs commands directly. `bash`: the host has no $.process
// (it is documented as CLI-only), so commands go through the Bash tool and ask
// permission like any other Bash call.
type Exec = { mode: 'process' | 'bash'; adb: string }

let exec: Exec | null = null
const packages = new Map<string, string | null>()

async function probe($: Engine): Promise<Exec> {
  if (exec !== null) return exec
  const home = await $.env.get('HOME')
  const androidHome = await $.env.get('ANDROID_HOME')
  const sdkRoot = await $.env.get('ANDROID_SDK_ROOT')
  const onDisk = [
    androidHome && `${androidHome}/platform-tools/adb`,
    sdkRoot && `${sdkRoot}/platform-tools/adb`,
    home && `${home}/Library/Android/sdk/platform-tools/adb`,
    home && `${home}/Android/Sdk/platform-tools/adb`,
  ].filter((candidate): candidate is string => Boolean(candidate))
  for (const candidate of ['adb', ...onDisk]) {
    try {
      const ran = await $.process.run([candidate, 'version'], { timeoutMs: 5_000 })
      if (ran.exitCode === 0) return (exec = { mode: 'process', adb: candidate })
    } catch {
      // Not there, or the host has no $.process.
    }
  }
  for (const candidate of onDisk) {
    if (await $.fs.exists(candidate).catch(() => false)) return (exec = { mode: 'bash', adb: candidate })
  }
  return (exec = { mode: 'bash', adb: 'adb' })
}

/** Runs one `sh` command line, through $.process when the host has it, else the Bash tool. */
async function sh($: Engine, line: string, why: string, timeoutMs = 30_000): Promise<Ran> {
  const how = await probe($)
  if (how.mode === 'process') {
    try {
      const ran = await $.process.run(['/bin/sh', '-c', line], { timeoutMs })
      return { ok: ran.exitCode === 0, out: ran.stdout, err: ran.stderr }
    } catch (error) {
      return { ok: false, out: '', err: error instanceof Error ? error.message : String(error) }
    }
  }
  const ran = await $.tool.call({ tool: 'Bash', command: line, description: why, timeout: timeoutMs })
  if (ran.deny !== undefined) return { ok: false, out: '', err: ran.deny }
  if (ran.isError) return { ok: false, out: '', err: ran.text ?? String(ran.result) }
  return { ok: true, out: ran.result.stdout, err: ran.result.stderr }
}

async function adb(
  $: Engine,
  serial: string | null,
  args: readonly string[],
  why: string,
  timeoutMs?: number,
): Promise<Ran> {
  const how = await probe($)
  const argv = serial === null ? [how.adb, ...args] : [how.adb, '-s', serial, ...args]
  return sh($, shellLine(argv), why, timeoutMs)
}

/** Runs a command in the device's shell and returns its trimmed output, or throws. */
async function shell($: Engine, serial: string, command: string, why: string, timeoutMs?: number): Promise<string> {
  const ran = await adb($, serial, ['shell', command], why, timeoutMs)
  if (!ran.ok) throw new Error((ran.err || ran.out).trim() || 'adb shell failed')
  return ran.out.trim()
}

async function listDevices($: Engine): Promise<ListedDevice[]> {
  const ran = await adb($, null, ['devices', '-l'], 'List connected Android devices', 10_000)
  return ran.ok ? parseDevices(ran.out) : []
}

/** The device to act on (pickTarget's order). Throws the reason when there is none, or several. */
async function target($: Engine, explicit?: unknown): Promise<string> {
  const given = typeof explicit === 'string' && explicit.trim() !== '' ? explicit.trim() : undefined
  const env = (await $.env.get('ANDROID_SERIAL')) || undefined
  const picked = pickTarget(given === undefined && env === undefined ? await listDevices($) : [], given, env)
  if ('error' in picked) throw new Error(picked.error)
  return picked.serial
}

/** The application ID the project builds, from the `package` option or the app module's Gradle file. */
async function projectApplicationId($: Engine, ctx: Ctx): Promise<string | null> {
  const configured = option(ctx, 'package')
  if (configured !== '') return configured
  const root = await $.session.cwd()
  const modules = ['app']
  try {
    for (const entry of await $.fs.list(root)) {
      if (entry.kind === 'dir' && entry.name !== 'app' && !entry.name.startsWith('.')) modules.push(entry.name)
    }
  } catch {
    // An unreadable folder leaves only the conventional app module.
  }
  for (const module of modules) {
    for (const file of ['build.gradle.kts', 'build.gradle']) {
      const path = `${root}/${module}/${file}`
      if (!(await $.fs.exists(path).catch(() => false))) continue
      const gradle = await $.fs.read(path).catch(() => '')
      if (module !== 'app' && !isAppModule(gradle)) continue
      const id = parseApplicationId(gradle)
      if (id !== null) return id
    }
  }
  return null
}

/** The installed package of the project's app on `serial` (with any debug suffix), or null. */
async function appPackage($: Engine, ctx: Ctx, serial: string): Promise<string | null> {
  if (packages.has(serial)) return packages.get(serial) ?? null
  const id = await projectApplicationId($, ctx)
  let chosen: string | null = id
  if (id !== null) {
    const listed = await adb($, serial, ['shell', 'pm', 'list', 'packages', id], 'Find the installed app package', 10_000)
    if (listed.ok) chosen = pickPackage(id, listed.out)
  }
  packages.set(serial, chosen)
  return chosen
}

/** Resolves a package argument: an explicit name, else the project's app. Throws when neither is known. */
async function requirePackage($: Engine, ctx: Ctx, serial: string, explicit?: unknown): Promise<string> {
  if (typeof explicit === 'string' && explicit.trim() !== '') return explicit.trim()
  const found = await appPackage($, ctx, serial)
  if (found === null) {
    throw new Error('Could not tell which app to use: pass a package name, or set the plugin\'s "package" option.')
  }
  return found
}

async function launch($: Engine, serial: string, name: string): Promise<void> {
  const out = await shell($, serial, `monkey -p ${shellQuote(name)} -c android.intent.category.LAUNCHER 1`, `Launch ${name}`)
  if (/No activities found|monkey aborted/i.test(out)) {
    throw new Error(`${name} has no launcher activity on ${serial}, or is not installed.`)
  }
}

async function openUrl($: Engine, serial: string, url: string, target?: string): Promise<string> {
  const command = `am start -W -a android.intent.action.VIEW -d ${shellQuote(url)}${target === undefined ? '' : ` ${shellQuote(target)}`}`
  const out = await shell($, serial, command, `Open ${url} on the device`, 20_000)
  if (/Error|unable to resolve/i.test(out)) throw new Error(out)
  const activity = /Activity: (\S+)/.exec(out)?.[1]
  return `Opened ${url}${activity === undefined ? '' : ` in ${activity}`}.`
}

/** Sends one key event (`KEYCODE_BACK`, `4`, `HOME`) to the device. */
async function keyEvent($: Engine, serial: string, key: string): Promise<void> {
  const code = /^\d+$/.test(key) || key.startsWith('KEYCODE_') ? key : `KEYCODE_${key.toUpperCase()}`
  await shell($, serial, `input keyevent ${shellQuote(code)}`, `Press ${code} on the device`)
}

// ─── Screenshots ──────────────────────────────────────────────────────────────

type Screen = {
  /** Absolute path of the full-size PNG. */
  png: string
  width: number
  height: number
  /** A downscaled JPEG, base64, when asked for and `sips` (macOS) is there. */
  jpeg: string | null
}

let counter = 0

/**
 * Takes a screenshot of `serial` into a PNG file and, when `jpeg` is given and
 * `sips` is there, a downscaled JPEG no longer than `maxChars` of base64. One
 * command line, so the Bash fallback asks once per screenshot.
 */
async function captureScreen(
  $: Engine,
  serial: string,
  jpeg?: { maxSide: number; quality: number; maxChars?: number },
): Promise<Screen> {
  const how = await probe($)
  const dir = `${((await $.env.get('TMPDIR')) ?? '/tmp').replace(/\/$/, '')}/claude-android-screen`
  counter += 1
  const png = `${dir}/screen-${serial.replace(/[^\w.-]/g, '_')}-${counter % 2}.png`
  const jpg = png.replace(/\.png$/, '.jpg')
  const sips = (maxSide: number, quality: number) =>
    shellLine(['/usr/bin/sips', '-Z', String(maxSide), '-s', 'format', 'jpeg', '-s', 'formatOptions', String(quality), png, '--out', jpg]) +
    ' >/dev/null'
  // screencap writes binary PNG; the redirect keeps it off the text pipe.
  const line = [
    'set -e',
    `mkdir -p ${shellQuote(dir)}`,
    `${shellLine([how.adb, '-s', serial, 'exec-out', 'screencap', '-p'])} > ${shellQuote(png + '.part')}`,
    `mv -f ${shellQuote(png + '.part')} ${shellQuote(png)}`,
    'if [ -x /usr/bin/sips ]; then',
    `  /usr/bin/sips -g pixelWidth -g pixelHeight ${shellQuote(png)}`,
    ...(jpeg === undefined ? [] : [`  ${sips(jpeg.maxSide, jpeg.quality)}`]),
    'fi',
  ].join('\n')
  const ran = await sh($, line, `Take a screenshot of ${serial}`)
  if (!ran.ok) throw new Error(ran.err.trim() || 'screencap failed')

  const size = parseSipsSize(ran.out)
  let encoded: string | null = null
  if (size !== null && jpeg !== undefined) {
    encoded = (await $.fs.read(jpg, { as: 'bytes' })).base64
    if (encoded.length > (jpeg.maxChars ?? Number.POSITIVE_INFINITY)) {
      const smaller = await sh($, sips(Math.round(jpeg.maxSide * 0.7), Math.max(20, jpeg.quality - 15)), 'Shrink the screenshot')
      encoded = smaller.ok ? (await $.fs.read(jpg, { as: 'bytes' })).base64 : null
      if (encoded !== null && encoded.length > (jpeg.maxChars ?? Number.POSITIVE_INFINITY)) encoded = null
    }
  }
  return { png, width: size?.width ?? 1080, height: size?.height ?? 2400, jpeg: encoded }
}

// ─── Device mirror pane ───────────────────────────────────────────────────────

const MIRROR_PANE = 'android-mirror'

// An SVG's whole source is capped at 131,072 characters; leave room for the markup.
const SVG_IMAGE_CHARS = 125_000

let timer: Timer | null = null
let isCapturing = false
let isPaused = false

/** The mirror's device: ANDROID_SERIAL, the one picked in the pane, or the only ready device. */
async function mirrorTarget($: Engine): Promise<string> {
  const env = await $.env.get('ANDROID_SERIAL')
  if (env) return env
  const devices = await listDevices($)
  const ready = devices.filter(device => device.state === 'device').map(device => device.serial)
  const chosen = await read($, mirrorSerial)
  const picked = pickTarget(devices, chosen !== null && ready.includes(chosen) ? chosen : undefined, undefined)
  const choices = 'error' in picked && ready.length > 1 ? ready : []
  if (JSON.stringify(choices) !== JSON.stringify(await read($, mirrorChoices))) await update($, mirrorChoices, () => choices)
  if ('error' in picked) throw new Error(picked.error)
  return picked.serial
}

async function refreshMirror($: Engine): Promise<void> {
  if (isCapturing) return
  isCapturing = true
  try {
    const serial = await mirrorTarget($)
    const wantsJpeg = (await $.session.surfaces()).some(surface => surface !== 'terminal')
    const shot = await captureScreen($, serial, wantsJpeg ? { maxSide: 800, quality: 55, maxChars: SVG_IMAGE_CHARS } : undefined)
    const takenAt = await $.clock.now()
    await update($, mirror, previous => ({
      serial,
      file: shot.png,
      generation: (previous?.generation ?? 0) + 1,
      width: shot.width,
      height: shot.height,
      jpeg: shot.jpeg,
      takenAt,
    }))
    const polling = (await probe($)).mode === 'process' ? '' : ' · Refresh to update'
    await update($, mirrorStatus, () => `${serial} · ${shot.width}×${shot.height} · ${new Date(takenAt).toLocaleTimeString()}${polling}`)
  } catch (error) {
    await update($, mirrorStatus, () => `Screenshot failed: ${error instanceof Error ? error.message : String(error)}`)
  } finally {
    isCapturing = false
  }
}

function stopMirror(): void {
  timer?.cancel()
  timer = null
}

async function startMirror($: Engine, ctx: Ctx): Promise<void> {
  stopMirror()
  void refreshMirror($)
  // Never poll through the Bash tool: each call would ask permission.
  if ((await probe($)).mode !== 'process') return
  timer = $.clock.every(numberOption(ctx, 'mirrorIntervalMs', 1_500), () => {
    if (isPaused) return
    void $.ui.panes().then(panes => {
      const pane = panes.find(one => one.id === MIRROR_PANE)
      if (pane === undefined) stopMirror()
      else if (pane.isShown) void refreshMirror($)
    })
  })
}

async function openMirror($: Engine, ctx: Ctx): Promise<string> {
  await $.ui.open({ id: MIRROR_PANE, title: 'Device' })
  isPaused = false
  await startMirror($, ctx)
  return 'Device mirror opened.'
}

async function press($: Engine, key: string): Promise<void> {
  try {
    await keyEvent($, await mirrorTarget($), key)
    await $.clock.sleep(350)
    await refreshMirror($)
  } catch (error) {
    $.ui.toast(error instanceof Error ? error.message : String(error))
  }
}

async function resumeMirror($: Engine, ctx: Ctx): Promise<void> {
  if ((await $.ui.panes()).some(pane => pane.id === MIRROR_PANE)) await startMirror($, ctx)
}

function registerMirror(on: On): void {
  on('ui.close', { id: MIRROR_PANE }, ($, e, next) => {
    stopMirror()
    return next(e)
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'Pane', requestId: MIRROR_PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const frame = await read($, mirror)
    const status = await read($, mirrorStatus)
    const choices = await read($, mirrorChoices)
    const isPolling = timer !== null

    let picture
    if (frame === null) {
      picture = <Text dimColor>{choices.length > 0 ? 'Pick a device to mirror.' : 'Waiting for the first screenshot…'}</Text>
    } else if (e.surface === 'terminal') {
      const { Image } = $.ui.resolve(e)
      const maxRows = Math.max(4, Math.min(255, (e.viewport?.rows ?? 40) - 5))
      let columns = Math.max(4, Math.min(255, e.props.bodyColumns))
      // Terminal cells are about twice as tall as they are wide.
      let rows = Math.round((columns * frame.height) / frame.width / 2)
      if (rows > maxRows) {
        rows = maxRows
        columns = Math.max(4, Math.min(255, Math.round((rows * 2 * frame.width) / frame.height)))
      }
      picture = (
        <Image
          key="screen"
          source={{ file: frame.file, format: 'png', generation: frame.generation }}
          columns={columns}
          rows={Math.max(1, rows)}
          alt="Device screen (this terminal cannot show images; kitty and Ghostty can)"
        />
      )
    } else if (e.surface !== 'mobile' && frame.jpeg !== null) {
      const { Svg } = $.ui.resolve(e)
      const width = Math.max(200, Math.min(420, e.props.bodyColumns * 8))
      const height = Math.round((width * frame.height) / frame.width)
      const source =
        `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${frame.width} ${frame.height}">` +
        `<image width="${frame.width}" height="${frame.height}" href="data:image/jpeg;base64,${frame.jpeg}"/></svg>`
      picture = <Svg source={source} alt="Device screen" width={width} height={height} />
    } else {
      picture = <Text dimColor>This surface cannot draw the screenshot. It is saved at {frame.file}</Text>
    }

    return (
      <Box flexDirection="column">
        <Box flexDirection="row" flexWrap="wrap" columnGap={1}>
          <Button key="back" hotkey="b" label="◀ Back" onPress={() => void press($, 'BACK')} />
          <Button key="home" hotkey="h" label="● Home" onPress={() => void press($, 'HOME')} />
          <Button key="recents" hotkey="o" label="■ Recents" onPress={() => void press($, 'APP_SWITCH')} />
          <Button key="refresh" hotkey="r" label="Refresh" onPress={() => void refreshMirror($)} />
          {isPolling && (
            <Button
              key="pause"
              hotkey="p"
              label={isPaused ? 'Resume' : 'Pause'}
              onPress={() => {
                isPaused = !isPaused
                void update($, mirrorStatus, text => text.replace(/ · paused$/, '') + (isPaused ? ' · paused' : ''))
              }}
            />
          )}
        </Box>
        {choices.length > 0 && (
          <Box flexDirection="row" flexWrap="wrap" columnGap={1}>
            {choices.map((serial, index) => (
              <Button
                key={`pick-${index}`}
                label={serial}
                onPress={async () => {
                  await update($, mirrorSerial, () => serial)
                  await refreshMirror($)
                }}
              />
            ))}
          </Box>
        )}
        {picture}
        <Text dimColor wrap="truncate-end">
          {status}
        </Text>
      </Box>
    )
  })
}

// ─── Tools Claude can call ────────────────────────────────────────────────────

// Blocks as the Messages API spells them.
type Block =
  | { type: 'text'; text: string }
  | { type: 'image'; source: { type: 'base64'; media_type: 'image/jpeg'; data: string } }

// A tool's result is a string or a list of content blocks; a failure answers with `deny`,
// which the model reads as an error result.
type Answer = { result: Block[] } | { deny: string }

const SERIAL = {
  serial: {
    type: 'string',
    description: 'Device serial (adb devices). Defaults to ANDROID_SERIAL, or the only connected device.',
  },
}

function text(value: string): Answer {
  return { result: [{ type: 'text', text: value }] }
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

function num(value: unknown): number | undefined {
  const parsed = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : Number.NaN
  return Number.isFinite(parsed) ? parsed : undefined
}

type ToolDef = {
  name: string
  description: string
  properties: Record<string, unknown>
  required?: string[]
}

const TOOLS: ToolDef[] = [
  {
    name: 'screenshot',
    description:
      'Android: take a screenshot of the device screen and return it as an image, to check UI changes on a real device or emulator. Coordinates for the input tool are in device pixels; the reply says the scale.',
    properties: { ...SERIAL },
  },
  {
    name: 'ui_tree',
    description:
      "Android: dump the current screen's view hierarchy (uiautomator): one line per node with class, text, content description, resource id or Compose test tag, state flags and the center point to tap. Cheaper and more exact than a screenshot for finding elements.",
    properties: { ...SERIAL },
  },
  {
    name: 'input',
    description:
      'Android: send input to the device: `tap` at x,y; `swipe` from x,y to x2,y2; `text` to type into the focused field; `key` to press a key (BACK, HOME, ENTER, TAB, DEL, APP_SWITCH, or a keycode). Coordinates are device pixels, as ui_tree reports them.',
    properties: {
      ...SERIAL,
      action: { type: 'string', enum: ['tap', 'swipe', 'text', 'key'] },
      x: { type: 'number' },
      y: { type: 'number' },
      x2: { type: 'number' },
      y2: { type: 'number' },
      duration_ms: { type: 'number', description: 'Swipe duration (default 300).' },
      text: { type: 'string' },
      key: { type: 'string' },
    },
    required: ['action'],
  },
  {
    name: 'app',
    description:
      'Android: control the project app (or `package`) on the device: `launch` it, `restart` it (force-stop then launch, e.g. after installing a new build), `stop` it, or `open_url` to fire a deep link / App Link through an ACTION_VIEW intent.',
    properties: {
      ...SERIAL,
      action: { type: 'string', enum: ['launch', 'restart', 'stop', 'open_url'] },
      package: { type: 'string', description: 'Package name; defaults to the project app.' },
      url: { type: 'string', description: 'For open_url: the URI to open.' },
    },
    required: ['action'],
  },
]

async function declareTools($: Engine): Promise<void> {
  for (const def of TOOLS) {
    await $.tool.register({
      name: def.name,
      description: def.description,
      inputSchema: { type: 'object', properties: def.properties, ...(def.required ? { required: def.required } : {}) },
    })
  }
}

async function toolScreenshot($: Engine, input: Record<string, unknown>): Promise<Answer> {
  const serial = await target($, input['serial'])
  const shot = await captureScreen($, serial, { maxSide: 1280, quality: 70 })
  const longest = Math.max(shot.width, shot.height)
  const scale = longest > 1280 ? 1280 / longest : 1
  const note =
    `${serial} screen, ${shot.width}×${shot.height} device pixels` +
    (scale < 1 ? `; the image is scaled by ${scale.toFixed(3)}, so divide image coordinates by that for input.` : '.') +
    ` Full PNG: ${shot.png}`
  if (shot.jpeg === null) return text(`${note}\nRead that file to see it.`)
  return {
    result: [
      { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: shot.jpeg } },
      { type: 'text', text: note },
    ],
  }
}

async function toolUiTree($: Engine, input: Record<string, unknown>): Promise<Answer> {
  const serial = await target($, input['serial'])
  const why = `Dump the view hierarchy of ${serial}`
  let dump = await adb($, serial, ['exec-out', 'uiautomator', 'dump', '/dev/tty'], why, 30_000)
  if (!dump.out.includes('<hierarchy')) {
    dump = await adb($, serial, ['shell', 'uiautomator dump /sdcard/window_dump.xml >/dev/null && cat /sdcard/window_dump.xml'], why, 30_000)
  }
  if (!dump.out.includes('<hierarchy')) throw new Error((dump.err || dump.out).trim() || 'uiautomator dump failed')
  return text(compactUiTree(dump.out) || 'The hierarchy has no labelled or interactive nodes.')
}

async function toolInput($: Engine, input: Record<string, unknown>): Promise<Answer> {
  const serial = await target($, input['serial'])
  const action = str(input['action'])
  const point = (xKey: string, yKey: string) => {
    const x = num(input[xKey])
    const y = num(input[yKey])
    if (x === undefined || y === undefined) throw new Error(`${action} needs ${xKey} and ${yKey}.`)
    return `${Math.round(x)} ${Math.round(y)}`
  }
  switch (action) {
    case 'tap':
      await shell($, serial, `input tap ${point('x', 'y')}`, `Tap ${point('x', 'y')} on the device`)
      return text(`Tapped ${point('x', 'y')}.`)
    case 'swipe': {
      const duration = Math.round(num(input['duration_ms']) ?? 300)
      await shell($, serial, `input swipe ${point('x', 'y')} ${point('x2', 'y2')} ${duration}`, 'Swipe on the device')
      return text(`Swiped ${point('x', 'y')} → ${point('x2', 'y2')}.`)
    }
    case 'text': {
      const value = typeof input['text'] === 'string' ? input['text'] : ''
      if (value === '') throw new Error('text needs `text`.')
      await shell($, serial, `input text ${inputText(value)}`, 'Type on the device')
      return text(`Typed ${JSON.stringify(value)}.`)
    }
    case 'key': {
      const key = str(input['key'])
      if (key === undefined) throw new Error('key needs `key`.')
      await keyEvent($, serial, key)
      return text(`Pressed ${key}.`)
    }
    default:
      throw new Error('action must be tap, swipe, text or key.')
  }
}

async function toolApp($: Engine, ctx: Ctx, input: Record<string, unknown>): Promise<Answer> {
  const serial = await target($, input['serial'])
  const action = str(input['action'])
  if (action === 'open_url') {
    const url = str(input['url'])
    if (url === undefined) throw new Error('open_url needs `url`.')
    return text(await openUrl($, serial, url, str(input['package'])))
  }
  if (action !== 'launch' && action !== 'restart' && action !== 'stop') {
    throw new Error('action must be launch, restart, stop or open_url.')
  }
  const name = await requirePackage($, ctx, serial, input['package'])
  if (action !== 'launch') await shell($, serial, `am force-stop ${shellQuote(name)}`, `Stop ${name}`)
  if (action === 'stop') return text(`Stopped ${name}.`)
  await launch($, serial, name)
  return text(`${action === 'restart' ? 'Restarted' : 'Launched'} ${name}.`)
}

async function runTool($: Engine, ctx: Ctx, name: string, input: Record<string, unknown>): Promise<Answer> {
  switch (name) {
    case 'screenshot':
      return toolScreenshot($, input)
    case 'ui_tree':
      return toolUiTree($, input)
    case 'input':
      return toolInput($, input)
    case 'app':
      return toolApp($, ctx, input)
    default:
      throw new Error(`Unknown tool ${name}`)
  }
}

/** Serves the tools under `mcp__android-screen__<name>`. */
function registerTools(on: On, ctx: Ctx): void {
  for (const def of TOOLS) {
    on('tool.call', { tool: `mcp__android-screen__${def.name}` }, async ($, e) => {
      try {
        return await runTool($, ctx, def.name, e as Record<string, unknown>)
      } catch (error) {
        return { deny: error instanceof Error ? error.message : String(error) }
      }
    }).catch(() => ({ deny: `android-screen: ${def.name} failed.` }))
  }
}

// ─── Slash commands ───────────────────────────────────────────────────────────

const COMMANDS: CommandSpec[] = [
  {
    name: 'mirror',
    description: 'Open a live mirror of the Android device screen',
  },
  {
    name: 'deeplink',
    description: 'Open a deep link or App Link on the Android device',
    argumentHint: '<uri> [package]',
  },
  {
    name: 'relaunch',
    description: 'Force-stop and relaunch the project app on the Android device',
    argumentHint: '[package]',
  },
]

async function declareCommands($: Engine): Promise<void> {
  for (const spec of COMMANDS) await $.command.register(spec)
}

async function commandDeeplink($: Engine, args: string): Promise<string> {
  const [url, pkg] = args.trim().split(/\s+/)
  if (!url) return 'Usage: /deeplink <uri> [package]'
  return openUrl($, await target($), url, pkg)
}

async function commandRelaunch($: Engine, ctx: Ctx, args: string): Promise<string> {
  const serial = await target($)
  const name = await requirePackage($, ctx, serial, args)
  await shell($, serial, `am force-stop ${shellQuote(name)}`, `Stop ${name}`)
  await launch($, serial, name)
  return `Relaunched ${name}.`
}

async function runCommand($: Engine, ctx: Ctx, name: string, args: string): Promise<string> {
  switch (name) {
    case 'mirror':
      return openMirror($, ctx)
    case 'deeplink':
      return commandDeeplink($, args)
    case 'relaunch':
      return commandRelaunch($, ctx, args)
    default:
      throw new Error(`Unknown command ${name}`)
  }
}

/** Slash commands: each answers its own `command.run`. */
function registerCommands(on: On, ctx: Ctx): void {
  for (const command of COMMANDS) {
    on('command.run', { command: command.name }, async ($, e) => {
      try {
        return { text: await runCommand($, ctx, command.name, e.args) }
      } catch (error) {
        return { text: `Error: ${error instanceof Error ? error.message : String(error)}` }
      }
    }).catch(() => ({ text: `android-screen: /${command.name} failed.` }))
  }
}

// ─── Registration ─────────────────────────────────────────────────────────────

export const register: Register = (on, options) => {
  const ctx: Ctx = { options }

  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await declareTools($)
    await declareCommands($)
    await resumeMirror($, ctx)
    return started
  })

  registerMirror(on)
  registerTools(on, ctx)
  registerCommands(on, ctx)
}
