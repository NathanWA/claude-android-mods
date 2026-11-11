// Pure helpers for adb output and shell lines: no `$`, so tests can call them directly.

export type ListedDevice = { serial: string; state: string; model: string | null }

/** Parses `adb devices -l`. */
export function parseDevices(stdout: string): ListedDevice[] {
  const found: ListedDevice[] = []
  for (const raw of stdout.split('\n')) {
    const line = raw.trim()
    if (line === '' || line.startsWith('List of devices') || line.startsWith('*')) continue
    const [serial, state, ...rest] = line.split(/\s+/)
    if (serial === undefined || state === undefined) continue
    const model = rest.find(part => part.startsWith('model:'))?.slice('model:'.length) ?? null
    found.push({ serial, state, model: model === null ? null : model.replaceAll('_', ' ') })
  }
  return found
}

export type Target = { serial: string } | { error: string }

/**
 * The device to act on, in android-device-console's order: an explicit serial,
 * then `ANDROID_SERIAL`, then the only ready device. Several ready devices and no
 * choice is an error that lists them; it never guesses.
 */
export function pickTarget(devices: readonly ListedDevice[], explicit: string | undefined, envSerial: string | undefined): Target {
  if (explicit) return { serial: explicit }
  if (envSerial) return { serial: envSerial }
  const ready = devices.filter(device => device.state === 'device')
  if (ready.length === 1) return { serial: ready[0]!.serial }
  if (ready.length === 0) {
    const other = devices.map(device => `${device.serial} (${device.state})`).join(', ')
    return { error: other ? `No device is ready: ${other}.` : 'No device is connected (adb devices lists none).' }
  }
  const list = ready.map(device => device.serial + (device.model ? ` ${device.model}` : '')).join(', ')
  return { error: `${ready.length} devices are connected (${list}). Pass serial, or set ANDROID_SERIAL.` }
}

/** Finds `applicationId` (or failing that `namespace`) in a Gradle build file. */
export function parseApplicationId(gradle: string): string | null {
  const id = /\bapplicationId\s*(?:=|\s)\s*["']([\w.]+)["']/.exec(gradle)
  if (id?.[1]) return id[1]
  const namespace = /\bnamespace\s*(?:=|\s)\s*["']([\w.]+)["']/.exec(gradle)
  return namespace?.[1] ?? null
}

export function isAppModule(gradle: string): boolean {
  return /com\.android\.application|android\.application|androidApplication/.test(gradle)
}

/**
 * Picks the installed package for an application ID from `pm list packages <id>`:
 * the exact ID, else the shortest one that extends it (`com.app.debug`).
 */
export function pickPackage(applicationId: string, pmList: string): string {
  const installed = pmList
    .split('\n')
    .map(line => line.trim().replace(/^package:/, ''))
    .filter(name => name !== '')
  if (installed.includes(applicationId)) return applicationId
  const extended = installed
    .filter(name => name.startsWith(applicationId + '.'))
    .sort((a, b) => a.length - b.length)
  return extended[0] ?? applicationId
}

const SAFE_WORD = /^[\w@%+=:,./-]+$/

/** Quotes one word for `sh`: the host's, or the device's that `adb shell` hands its words to. */
export function shellQuote(value: string): string {
  return SAFE_WORD.test(value) ? value : `'${value.replaceAll("'", `'\\''`)}'`
}

/** Joins an argument vector into one `sh` command line. */
export function shellLine(argv: readonly string[]): string {
  return argv.map(shellQuote).join(' ')
}

/** `input text` takes no spaces: they are written `%s`. */
export function inputText(value: string): string {
  return shellQuote(value.replaceAll(' ', '%s'))
}

const ATTRIBUTE = /([\w-]+)="([^"]*)"/g

function decode(value: string): string {
  return value
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&apos;', "'")
    .replace(/&#(\d+);/g, (_, code: string) => (code === '10' || code === '13' ? ' ' : String.fromCharCode(Number(code))))
    .replaceAll('&amp;', '&')
}

/**
 * Turns a `uiautomator dump` into one line per meaningful node: its class, text,
 * content description, resource id (Compose test tags with testTagsAsResourceId),
 * flags, and the center point to tap. Nodes with no area on screen are left out
 * (a WebView reports a whole document's off-screen text at [0,0][0,0]) and counted.
 */
export function compactUiTree(xml: string, maxLines = 400): string {
  const out: string[] = []
  let offScreen = 0
  // One entry per open node: whether it printed a line. Lines indent by printed ancestors only.
  const open: boolean[] = []
  const tags = /<node\b([^>]*?)(\/?)>|<\/node>/g
  for (let match = tags.exec(xml); match !== null; match = tags.exec(xml)) {
    if (match[0] === '</node>') {
      open.pop()
      continue
    }
    const attributes: Record<string, string> = {}
    for (const [, name, value] of (match[1] ?? '').matchAll(ATTRIBUTE)) {
      if (name !== undefined) attributes[name] = decode(value ?? '')
    }
    const isSelfClosing = match[2] === '/'
    const text = attributes['text'] ?? ''
    const description = attributes['content-desc'] ?? ''
    const resourceId = attributes['resource-id'] ?? ''
    const flags: string[] = ['clickable', 'checked', 'selected', 'focused', 'scrollable'].filter(
      flag => attributes[flag] === 'true',
    )
    if (attributes['enabled'] === 'false') flags.push('disabled')
    const bounds = /\[(\d+),(\d+)\]\[(\d+),(\d+)\]/.exec(attributes['bounds'] ?? '')
    const box = bounds === null ? null : (bounds.slice(1).map(Number) as [number, number, number, number])
    const isOnScreen = box === null || (box[2] > box[0] && box[3] > box[1])
    const isLabelled = text !== '' || description !== '' || resourceId !== '' || flags.length > 0
    if (isLabelled && !isOnScreen) offScreen += 1
    const isMeaningful = isLabelled && isOnScreen
    if (isMeaningful) {
      const kind = (attributes['class'] ?? 'node').split('.').pop()
      const parts = [kind]
      if (text !== '') parts.push(JSON.stringify(text))
      if (description !== '') parts.push(`desc=${JSON.stringify(description)}`)
      if (resourceId !== '') parts.push(`id=${resourceId.replace(/^[\w.]+:id\//, '')}`)
      if (flags.length > 0) parts.push(`[${flags.join(',')}]`)
      if (box !== null) parts.push(`@(${Math.round((box[0] + box[2]) / 2)},${Math.round((box[1] + box[3]) / 2)})`)
      out.push('  '.repeat(open.filter(Boolean).length) + parts.join(' '))
    }
    if (!isSelfClosing) open.push(isMeaningful)
  }
  const lines = out.length > maxLines ? [...out.slice(0, maxLines), `… ${out.length - maxLines} more nodes`] : out
  if (offScreen > 0) lines.push(`(${offScreen} labelled nodes with no area on screen left out)`)
  return lines.join('\n')
}

/** Parses `sips -g pixelWidth -g pixelHeight` output. */
export function parseSipsSize(stdout: string): { width: number; height: number } | null {
  const width = /pixelWidth:\s*(\d+)/.exec(stdout)?.[1]
  const height = /pixelHeight:\s*(\d+)/.exec(stdout)?.[1]
  if (width === undefined || height === undefined) return null
  return { width: Number(width), height: Number(height) }
}
