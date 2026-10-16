// The route index: @Serializable route types and the nav-host calls that
// register them, Navigation 2 (`composable<X>`) and Navigation 3 (`entry<X>`).

import type { LensNavFile, LensNavIndex, LensRegistration, LensRoute, LensRouteArg } from '../types'

import { blankCommentsAndStrings, closeOf, lineAt, lineStarts, splitTopLevel } from './kotlin'

/** Text worth parsing: anything without these markers holds no route. */
export const NAV_MARKERS = /@(?:kotlinx\.serialization\.)?Serializable|\b(?:composable|dialog|navigation|entry|bottomSheet)\s*<|NavEntry\s*\(/

const ROUTE_NAME = /(Route|Routes|Screen|Screens|Destination|Destinations|Dest|Graph|NavKey|Nav)$/
const MODIFIERS = new Set(['data', 'sealed', 'internal', 'private', 'public', 'protected', 'open', 'abstract', 'value', 'inline', 'enum', 'expect', 'actual'])

const TOKEN = /\b(class|interface|object)\b(?:\s+([A-Za-z_]\w*))?|\b(fun|val|var)\b|[(){}]/g
const REGISTRATION = /\b(composable|dialog|navigation|entry|bottomSheet)\s*<\s*([A-Za-z_][\w.]*)\s*>/g
const NAV3_WHEN = /\bis\s+([A-Za-z_][\w.]*)\s*->\s*NavEntry\b/g

/** Parses one Kotlin file's routes and registrations. */
export function parseNavFile(path: string, src: string): LensNavFile {
  const text = blankCommentsAndStrings(src)
  const starts = lineStarts(src)
  const routes: LensRoute[] = []
  const registrations: LensRegistration[] = []

  // Containers: a stack of the declarations whose bodies we are inside.
  const stack: string[] = []
  let pending: string | null = null
  let parens = 0
  let boundary = 0

  for (const m of text.matchAll(TOKEN)) {
    const at = m.index ?? 0
    const tok = m[0]
    if (tok === '(') {
      parens++
      continue
    }
    if (tok === ')') {
      parens = Math.max(0, parens - 1)
      if (parens === 0) boundary = at + 1
      continue
    }
    if (tok === '{') {
      stack.push(pending ?? '')
      pending = null
      boundary = at + 1
      continue
    }
    if (tok === '}') {
      stack.pop()
      pending = null
      boundary = at + 1
      continue
    }
    if (parens > 0) continue
    if (m[3] !== undefined) {
      pending = ''
      continue
    }
    const kind = m[1] as 'class' | 'interface' | 'object'
    const name = m[2]
    pending = name ?? ''
    const before = text.slice(boundary, at)
    boundary = at + tok.length
    if (name === undefined || kind === 'interface') continue
    if (!/@(?:kotlinx\.serialization\.)?Serializable\b/.test(leadingModifiers(before))) continue

    // The primary constructor and supertypes.
    let cursor = at + tok.length
    while (text[cursor] === ' ' || text[cursor] === '\t') cursor++
    if (text[cursor] === '<') cursor = Math.max(cursor, closeOf(text, cursor))
    while (text[cursor] === ' ' || text[cursor] === '\t') cursor++
    let args: LensRouteArg[] = []
    if (kind === 'class' && text[cursor] === '(') {
      const end = closeOf(text, cursor)
      if (end !== -1) {
        args = parseArgs(src.slice(cursor + 1, end - 1), text.slice(cursor + 1, end - 1))
        cursor = end
      }
    }
    const tail = /^\s*:\s*([^{;\n]*)/.exec(text.slice(cursor, cursor + 400))
    const supertypes = tail?.[1] ?? ''
    const containers = stack.filter(s => s.length > 0)
    const isRoute =
      ROUTE_NAME.test(name) ||
      containers.some(c => ROUTE_NAME.test(c)) ||
      /\bNavKey\b/.test(supertypes) ||
      splitTopLevel(supertypes).some(s => ROUTE_NAME.test(s.replace(/\(.*$/s, '').replace(/<.*$/s, '').trim()))
    if (!isRoute) continue
    routes.push({
      name,
      qualified: [...containers, name].join('.'),
      kind: kind === 'object' ? 'object' : 'class',
      args,
      file: path,
      line: lineAt(starts, at),
    })
  }

  for (const m of text.matchAll(REGISTRATION)) {
    const target = m[2] as string
    if (/^[A-Z]$/.test(target)) continue // a generic helper's own type parameter
    registrations.push({ target, kind: m[1] as string, file: path, line: lineAt(starts, m.index ?? 0) })
  }
  if (/\bNavEntry\s*\(/.test(text)) {
    for (const m of text.matchAll(NAV3_WHEN)) {
      registrations.push({ target: m[1] as string, kind: 'entry', file: path, line: lineAt(starts, m.index ?? 0) })
    }
  }
  return { routes, registrations }
}

const TRAILING_MODIFIER = new RegExp(`(?:@[\\w.]+(?:\\s*\\([^()]*\\))?|\\b(?:${[...MODIFIERS].join('|')}))\\s*$`)

/** The annotations and modifiers written directly before a declaration keyword. */
function leadingModifiers(before: string): string {
  let rest = before.trimEnd()
  let taken = ''
  for (let m = TRAILING_MODIFIER.exec(rest); m !== null && m[0].length > 0; m = TRAILING_MODIFIER.exec(rest)) {
    taken = m[0] + ' ' + taken
    rest = rest.slice(0, m.index).trimEnd()
  }
  return taken
}

function parseArgs(original: string, blanked: string): LensRouteArg[] {
  const args: LensRouteArg[] = []
  // Split the blanked text so commas in strings do not split; slice the original.
  let from = 0
  const pieces: [number, number][] = []
  let depth = 0
  for (let i = 0; i <= blanked.length; i++) {
    const c = blanked[i]
    if (c === '(' || c === '[' || c === '{' || c === '<') depth++
    else if (c === ')' || c === ']' || c === '}' || (c === '>' && blanked[i - 1] !== '-')) depth = Math.max(0, depth - 1)
    if ((c === ',' && depth === 0) || i === blanked.length) {
      pieces.push([from, i])
      from = i + 1
    }
  }
  for (const [a, b] of pieces) {
    const piece = original.slice(a, b).replace(/@[\w.]+(\s*\([^)]*\))?/g, ' ').trim()
    const m = /^(?:(?:private|internal|public|protected|override)\s+)*(?:val|var)?\s*([A-Za-z_]\w*)\s*:\s*([\s\S]+?)(?:\s*=\s*([\s\S]+))?$/.exec(piece)
    if (m === null) continue
    const arg: LensRouteArg = { name: m[1] as string, type: (m[2] as string).replace(/\s+/g, ' ').trim() }
    if (m[3] !== undefined) arg.default = m[3].replace(/\s+/g, ' ').trim()
    args.push(arg)
  }
  return args
}

/** Whether a registration's type argument names this route. */
export function registers(target: string, route: LensRoute): boolean {
  return (
    target === route.qualified ||
    target === route.name ||
    route.qualified.endsWith('.' + target) ||
    target.endsWith('.' + route.qualified)
  )
}

export function allRoutes(index: LensNavIndex): LensRoute[] {
  return Object.values(index.files).flatMap(f => f.routes)
}

export function allRegistrations(index: LensNavIndex): LensRegistration[] {
  return Object.values(index.files).flatMap(f => f.registrations)
}

/** Routes no nav host registers, as `qualified@file`. */
export function unregisteredRoutes(index: LensNavIndex): LensRoute[] {
  const regs = allRegistrations(index)
  return allRoutes(index).filter(r => !regs.some(g => registers(g.target, r)))
}

export function routeKey(route: LensRoute): string {
  return `${route.qualified}@${route.file}`
}

function describeArgs(route: LensRoute): string {
  if (route.kind === 'object') return ''
  return `(${route.args.map(a => `${a.name}: ${a.type}${a.default !== undefined ? ` = ${a.default}` : ''}`).join(', ')})`
}

/** The nav_graph tool's answer, for one route query or the whole graph. */
export function describeGraph(index: LensNavIndex, query?: string): string {
  const routes = allRoutes(index)
  const regs = allRegistrations(index)
  const flavour = regs.some(r => r.kind === 'entry')
    ? regs.some(r => r.kind !== 'entry')
      ? 'Navigation 2 and Navigation 3'
      : 'Navigation 3'
    : regs.length > 0
      ? 'Navigation 2'
      : 'no registrations found'

  const q = query?.trim().toLowerCase()
  const picked = q ? routes.filter(r => r.qualified.toLowerCase().includes(q)) : routes
  if (routes.length === 0) {
    return 'No @Serializable route types found in this project (searched .kt files outside build/ and test source sets).'
  }
  if (picked.length === 0) {
    return `No route matches "${query}". Routes: ${routes.map(r => r.qualified).join(', ')}.`
  }

  const lines: string[] = []
  if (!q) lines.push(`${routes.length} routes, ${regs.length} registrations (${flavour}).`)
  for (const r of picked.sort((a, b) => a.qualified.localeCompare(b.qualified))) {
    const where = regs.filter(g => registers(g.target, r))
    const head = `${r.qualified}${describeArgs(r)} [${r.kind}] declared ${r.file}:${r.line}`
    const reg = where.length === 0
      ? 'NOT REGISTERED with any nav host'
      : where.map(g => `${g.kind}<${g.target}> at ${g.file}:${g.line}`).join('; ')
    lines.push(q ? `${head}\n  registered: ${reg}` : `- ${head}; registered: ${reg}`)
  }
  if (!q) {
    const orphans = regs.filter(g => !routes.some(r => registers(g.target, r)))
    if (orphans.length > 0) {
      lines.push(`Registrations naming no route found here: ${orphans.map(g => `${g.kind}<${g.target}> at ${g.file}:${g.line}`).join('; ')}.`)
    }
  }
  return lines.join('\n')
}
