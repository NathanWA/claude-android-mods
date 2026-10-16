// Compose compiler reports: *-composables.txt and *-classes.txt.
//
// Strong skipping is the default from Compose compiler 2.0.20, so "skippable"
// says nearly nothing: only the unstable-parameter signal is kept.

import type { LensComposable, LensStability } from '../types'

export const EMPTY_STABILITY: LensStability = { composables: {}, unstableClasses: {}, parsed: {}, indexMtime: 0 }

const FUN_HEAD = /\bfun\s+(?:<[^>]*>\s*)?(?:[\w.<>?, ]+\.)?([A-Za-z_]\w*)\s*\(/
const PARAM = /^\s*(unstable|stable|runtime|@static|@dynamic)?\s*([A-Za-z_$][\w$]*)\s*:\s*(.+?)(?:\s*=\s*.*)?$/

/**
 * Parses a `<module>_<variant>-composables.txt` report: every composable it
 * lists, with its unstable parameters (empty when none are).
 */
export function parseComposables(text: string, module: string): LensComposable[] {
  const found: LensComposable[] = []
  let current: LensComposable | null = null
  for (const line of text.split('\n')) {
    const head = FUN_HEAD.exec(line)
    if (head !== null && !/^\s+(unstable|stable|runtime)\s/.test(line)) {
      current = { name: head[1] as string, module, unstable: [] }
      found.push(current)
      if (/\)\s*$/.test(line)) current = null
      continue
    }
    if (current === null) continue
    if (/^\s*\)\s*$/.test(line)) {
      current = null
      continue
    }
    const p = PARAM.exec(line)
    if (p !== null && p[1] === 'unstable') current.unstable.push({ name: p[2] as string, type: (p[3] as string).trim() })
  }
  return found
}

/**
 * Parses a `<module>_<variant>-classes.txt` report: each unstable class and
 * the members that make it so.
 */
export function parseUnstableClasses(text: string): Record<string, string> {
  const found: Record<string, string> = {}
  let current: string | null = null
  let members: string[] = []
  for (const line of text.split('\n')) {
    const head = /^\s*(unstable|stable|runtime)\s+class\s+([A-Za-z_][\w.]*)/.exec(line)
    if (head !== null) {
      current = head[1] === 'unstable' ? (head[2] as string) : null
      members = []
      continue
    }
    if (current === null) continue
    const member = /^\s*unstable\s+(val|var)\s+(\w+)\s*:\s*(.+)$/.exec(line)
    if (member !== null) members.push(`${member[1]} ${member[2]}: ${(member[3] as string).trim()}`)
    if (/^\s*}\s*$/.test(line)) {
      found[current] = members.length > 0 ? `unstable members ${members.join(', ')}` : 'inferred unstable'
      current = null
    }
  }
  return found
}

/** Merges one composables report into the table: composables it lists are replaced, others kept. */
export function mergeComposables(table: LensStability, parsed: LensComposable[]): LensStability {
  const composables = { ...table.composables }
  for (const c of parsed) {
    if (c.unstable.length > 0) composables[c.name] = c
    else delete composables[c.name]
  }
  return { ...table, composables }
}

/** Composables and classes the edited Kotlin text defines that the reports call unstable. */
export function factsForEdit(table: LensStability, text: string): string[] {
  const facts: string[] = []
  const seen = new Set<string>()
  for (const m of text.matchAll(new RegExp(FUN_HEAD.source, 'g'))) {
    const name = m[1] as string
    const c = table.composables[name]
    if (c === undefined || seen.has(name)) continue
    seen.add(name)
    facts.push(
      `${name} (${c.module}) has unstable parameters: ${c.unstable.map(u => `${u.name}: ${u.type}`).join(', ')}.`,
    )
  }
  for (const m of text.matchAll(/\bclass\s+([A-Za-z_]\w*)/g)) {
    const name = m[1] as string
    const hit = Object.entries(table.unstableClasses).find(([k]) => k === name || k.endsWith('.' + name))
    if (hit === undefined || seen.has(name)) continue
    seen.add(name)
    facts.push(`class ${hit[0]} is unstable (${hit[1]}).`)
  }
  if (facts.length === 0) return []
  const shown = facts.slice(0, 4)
  return [
    `Compose compiler report (android-project-lens /stability): ${shown.join(' ')} ` +
      'With strong skipping these still skip when the same instances are passed again; they recompose only when a new instance arrives each time, such as a list or lambda-holding object built during composition.',
  ]
}

/** The /stability summary of the table. */
export function describeStability(table: LensStability): string {
  const composables = Object.values(table.composables).sort((a, b) => b.unstable.length - a.unstable.length)
  const classes = Object.entries(table.unstableClasses)
  if (composables.length === 0 && classes.length === 0) {
    return 'The Compose compiler reports list no composable with unstable parameters.'
  }
  const lines = [`${composables.length} composables have unstable parameters; ${classes.length} classes are unstable.`]
  for (const c of composables.slice(0, 15)) {
    lines.push(`- ${c.name} (${c.module}): ${c.unstable.map(u => `${u.name}: ${u.type}`).join(', ')}`)
  }
  if (composables.length > 15) lines.push(`- and ${composables.length - 15} more`)
  if (classes.length > 0) {
    lines.push(`Unstable classes: ${classes.slice(0, 10).map(([k, why]) => `${k} (${why})`).join('; ')}${classes.length > 10 ? `; and ${classes.length - 10} more` : ''}.`)
  }
  lines.push('Strong skipping is on by default, so these matter only where a new instance is created on each recomposition.')
  return lines.join('\n')
}
