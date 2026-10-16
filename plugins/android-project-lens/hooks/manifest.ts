// AndroidManifest.xml without an XML parser: the sandbox has none, and a
// manifest is regular enough for a hand tokenizer.

import type { LensManifest, LensPermission } from '../types'

export type XmlElement = { name: string; attrs: Record<string, string>; line: number }

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }

function decode(value: string): string {
  return value.replace(/&(#x[0-9a-fA-F]+|#\d+|\w+);/g, (whole, ref: string) => {
    if (ref.startsWith('#x')) return String.fromCodePoint(parseInt(ref.slice(2), 16))
    if (ref.startsWith('#')) return String.fromCodePoint(parseInt(ref.slice(1), 10))
    return ENTITIES[ref] ?? whole
  })
}

/** Every start (or empty) element of the document, in order, with its attributes. */
export function tokenizeXml(src: string): XmlElement[] {
  const elements: XmlElement[] = []
  let i = 0
  let line = 1
  const advance = (to: number) => {
    for (let k = i; k < to && k < src.length; k++) if (src[k] === '\n') line++
    i = to
  }
  while (i < src.length) {
    const lt = src.indexOf('<', i)
    if (lt === -1) break
    advance(lt)
    if (src.startsWith('<!--', i)) {
      const end = src.indexOf('-->', i + 4)
      advance(end === -1 ? src.length : end + 3)
      continue
    }
    if (src.startsWith('<![CDATA[', i)) {
      const end = src.indexOf(']]>', i)
      advance(end === -1 ? src.length : end + 3)
      continue
    }
    if (src.startsWith('<?', i) || src.startsWith('<!', i) || src.startsWith('</', i)) {
      const end = src.indexOf('>', i)
      advance(end === -1 ? src.length : end + 1)
      continue
    }
    // A start tag: find its end outside quotes.
    let j = i + 1
    let quote: string | null = null
    while (j < src.length) {
      const c = src[j]
      if (quote !== null) {
        if (c === quote) quote = null
      } else if (c === '"' || c === "'") quote = c
      else if (c === '>') break
      j++
    }
    const body = src.slice(i + 1, j).replace(/\/\s*$/, '')
    const nameMatch = /^([\w:.-]+)/.exec(body)
    if (nameMatch !== null) {
      const attrs: Record<string, string> = {}
      for (const a of body.slice(nameMatch[0].length).matchAll(/([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) {
        attrs[a[1] as string] = decode(a[2] ?? a[3] ?? '')
      }
      elements.push({ name: nameMatch[1] as string, attrs, line })
    }
    advance(j + 1)
  }
  return elements
}

const PERMISSION_TAGS = new Set(['uses-permission', 'uses-permission-sdk-23', 'uses-permission-sdk-m'])

/** The permissions a manifest asks for, and those it removes with tools:node="remove". */
export function permissionsOf(xml: string): { declared: string[]; removed: string[] } {
  const declared = new Set<string>()
  const removed = new Set<string>()
  for (const el of tokenizeXml(xml)) {
    if (!PERMISSION_TAGS.has(el.name)) continue
    const name = el.attrs['android:name']
    if (name === undefined || name.length === 0) continue
    if (el.attrs['tools:node'] === 'remove' || el.attrs['tools:node'] === 'removeAll') removed.add(name)
    else declared.add(name)
  }
  return { declared: [...declared], removed: [...removed] }
}

/** `<uses-sdk>` of a (merged) manifest. */
export function usesSdk(xml: string): { minSdk?: string; targetSdk?: string } {
  const el = tokenizeXml(xml).find(e => e.name === 'uses-sdk')
  if (el === undefined) return {}
  const out: { minSdk?: string; targetSdk?: string } = {}
  const min = el.attrs['android:minSdkVersion']
  const target = el.attrs['android:targetSdkVersion']
  if (min !== undefined) out.minSdk = min
  if (target !== undefined) out.targetSdk = target
  return out
}

/** Permissions the edit adds: in `after` and not in `before`. */
export function addedPermissions(before: string, after: string): string[] {
  const was = new Set(permissionsOf(before).declared)
  return permissionsOf(after).declared.filter(p => !was.has(p))
}

/**
 * Permissions Google Play asks a declaration for in the Play Console before
 * the app can ship with them, and why.
 */
const PLAY_DECLARATIONS: Record<string, string> = {
  'android.permission.ACCESS_BACKGROUND_LOCATION': 'background location: Play Console location declaration and a video of the feature',
  'android.permission.READ_SMS': 'SMS group: Play only allows it for default SMS handlers or listed exceptions',
  'android.permission.SEND_SMS': 'SMS group: Play only allows it for default SMS handlers or listed exceptions',
  'android.permission.RECEIVE_SMS': 'SMS group: Play only allows it for default SMS handlers or listed exceptions',
  'android.permission.RECEIVE_MMS': 'SMS group: Play only allows it for default SMS handlers or listed exceptions',
  'android.permission.RECEIVE_WAP_PUSH': 'SMS group: Play only allows it for default SMS handlers or listed exceptions',
  'android.permission.READ_CALL_LOG': 'Call Log group: Play only allows it for default phone handlers or listed exceptions',
  'android.permission.WRITE_CALL_LOG': 'Call Log group: Play only allows it for default phone handlers or listed exceptions',
  'android.permission.PROCESS_OUTGOING_CALLS': 'Call Log group: Play only allows it for default phone handlers or listed exceptions',
  'android.permission.MANAGE_EXTERNAL_STORAGE': 'All files access: Play declaration; most apps must use MediaStore or SAF instead',
  'android.permission.QUERY_ALL_PACKAGES': 'package visibility: Play declaration; a <queries> element usually suffices',
  'android.permission.REQUEST_INSTALL_PACKAGES': 'installing packages: Play declaration of the core feature that needs it',
  'android.permission.READ_MEDIA_IMAGES': 'photo and video permissions: Play declaration; one-time access through the photo picker needs none',
  'android.permission.READ_MEDIA_VIDEO': 'photo and video permissions: Play declaration; one-time access through the photo picker needs none',
  'android.permission.USE_EXACT_ALARM': 'exact alarms: Play only allows it for alarm and calendar apps; SCHEDULE_EXACT_ALARM or inexact alarms otherwise',
  'android.permission.USE_FULL_SCREEN_INTENT': 'full-screen intents: Play declaration for apps targeting Android 14+, limited to calls and alarms',
  'android.permission.BIND_ACCESSIBILITY_SERVICE': 'accessibility API: Play declaration and prominent disclosure',
  'android.permission.BIND_VPN_SERVICE': 'VpnService: Play declaration of the VPN core feature',
}

/** Why Play needs a declaration for this permission, or undefined when it needs none. */
export function playDeclaration(permission: string): string | undefined {
  const known = PLAY_DECLARATIONS[permission]
  if (known !== undefined) return known
  if (permission.startsWith('android.permission.FOREGROUND_SERVICE_')) {
    return 'foreground service type: Play Console foreground service declaration for apps targeting Android 14+'
  }
  if (permission.startsWith('android.permission.health.')) return 'Health Connect data: Play Console health permissions declaration'
  return undefined
}

/**
 * Attributions from a manifest-merger report: permission -> the library
 * coordinates (or file paths) it was merged from. Unofficial AGP format, so
 * anything unrecognised is left out rather than guessed.
 */
export function parseMergerReport(text: string): Record<string, string[]> {
  const out: Record<string, string[]> = {}
  let current: string | null = null
  for (const line of text.split('\n')) {
    const head = /^uses-permission(?:-sdk-23|-sdk-m)?#(\S+)/.exec(line)
    if (head !== null) {
      current = head[1] as string
      out[current] = out[current] ?? []
      continue
    }
    if (/^\S/.test(line) && !/^(ADDED|MERGED|INJECTED|IMPLIED|REJECTED)\s/.test(line)) {
      current = null
      continue
    }
    if (current === null) continue
    const from = /^(?:ADDED|MERGED|IMPLIED)\s+from\s+(?:\[([^\]]+)\]|(\S+))/.exec(line.trim())
    if (from === null) continue
    const origin = from[1] ?? from[2] ?? ''
    const list = out[current] as string[]
    if (origin.length > 0 && !list.includes(origin)) list.push(origin)
  }
  return out
}

function short(permission: string): string {
  return permission.replace(/^android\.permission\./, '')
}

function group(list: readonly LensPermission[]): string {
  const byOrigin = new Map<string, string[]>()
  for (const p of list) byOrigin.set(p.origin, [...(byOrigin.get(p.origin) ?? []), short(p.name)])
  return [...byOrigin].map(([origin, names]) => `${names.sort().join(', ')} (${origin})`).join('; ')
}

/** The system prompt section. */
export function describeManifest(m: LensManifest): string {
  const lines = ['Android project facts (android-project-lens; permission names drop the android.permission. prefix):']
  const sdk: string[] = []
  if (m.targetSdk !== undefined) sdk.push(`targetSdk ${m.targetSdk} (${m.targetSdkFrom ?? 'unknown source'})`)
  if (m.minSdk !== undefined) sdk.push(`minSdk ${m.minSdk} (${m.minSdkFrom ?? 'unknown source'})`)
  lines.push(sdk.length > 0 ? `- ${sdk.join(', ')}` : '- targetSdk and minSdk: not found (no merged manifest yet and no literal in the build files)')
  lines.push(`- Permissions the app module declares: ${m.app.length > 0 ? group(m.app) : 'none'}`)
  if (m.modules.length > 0) lines.push(`- Permissions other project modules declare: ${group(m.modules)}`)
  if (m.merged !== undefined) {
    lines.push(`- Permissions merged in from libraries: ${m.libraries.length > 0 ? group(m.libraries) : 'none'} (from ${m.merged.path})`)
  } else {
    lines.push('- Library permissions: unknown until the app is built once (no merged manifest under build/intermediates).')
  }
  if (m.removed.length > 0) lines.push(`- Removed with tools:node="remove": ${m.removed.map(short).sort().join(', ')}`)
  return lines.join('\n')
}
