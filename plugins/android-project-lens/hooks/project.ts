// Reading the project through $.fs: $.process is documented CLI-only, and the
// desktop app must work, so nothing here shells out.

import type { EngineInterface } from 'claude-code'

import type { LensManifest, LensNavFile, LensNavIndex, LensPermission, LensStability } from '../types'

import { NAV_MARKERS, parseNavFile } from './nav'
import { parseMergerReport, permissionsOf, usesSdk } from './manifest'
import { mergeComposables, parseComposables, parseUnstableClasses } from './stability'

type FileRef = { path: string; size: number; mtimeMs: number }

export type Project = {
  root: string
  kt: FileRef[]
  /** src/<set>/AndroidManifest.xml files */
  manifests: string[]
  /** directories holding a build.gradle(.kts), with that file */
  modules: { dir: string; buildFile: string }[]
}

const SKIP_DIRS = new Set(['build', 'out', 'node_modules', 'Pods', 'DerivedData', 'captures', 'buildSrc-cache'])
const MAX_DIRS = 20_000
const MAX_KT = 8_000
const MAX_KT_BYTES = 1_000_000
const BATCH = 16

export function join(dir: string, name: string): string {
  return dir.endsWith('/') ? dir + name : `${dir}/${name}`
}

export function relative(root: string, path: string): string {
  const base = root.endsWith('/') ? root : root + '/'
  return path.startsWith(base) ? path.slice(base.length) : path
}

export function absolute(root: string, path: string): string {
  return path.startsWith('/') ? path : join(root, path)
}

/** The Gradle path of a module directory (`feature/scan` -> `:feature:scan`). */
export function gradlePath(root: string, dir: string): string {
  const rel = relative(root, dir)
  return rel === dir && dir === root ? ':' : ':' + rel.split('/').filter(s => s.length > 0).join(':')
}

async function inBatches<T, R>(items: readonly T[], fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = []
  for (let i = 0; i < items.length; i += BATCH) {
    out.push(...(await Promise.all(items.slice(i, i + BATCH).map(fn))))
  }
  return out
}

/** Walks the project once: Kotlin files, source manifests and modules. */
export async function scanProject($: EngineInterface, root: string): Promise<Project> {
  const project: Project = { root, kt: [], manifests: [], modules: [] }
  let frontier = [root]
  let seen = 0
  while (frontier.length > 0 && seen < MAX_DIRS) {
    const next: string[] = []
    const listings = await inBatches(frontier, async dir => {
      try {
        return { dir, entries: await $.fs.list(dir) }
      } catch {
        return { dir, entries: [] }
      }
    })
    for (const { dir, entries } of listings) {
      seen++
      const parent = dir.slice(dir.lastIndexOf('/') + 1)
      for (const entry of entries) {
        const path = join(dir, entry.name)
        if (entry.kind === 'dir') {
          if (entry.name.startsWith('.') || SKIP_DIRS.has(entry.name)) continue
          // Test source sets hold no routes worth indexing.
          if (parent === 'src' && /(^test$|Test$)/.test(entry.name)) continue
          next.push(path)
        } else if (entry.kind === 'file') {
          if (entry.name.endsWith('.kt') && project.kt.length < MAX_KT) {
            project.kt.push({ path, size: entry.size, mtimeMs: entry.mtimeMs })
          } else if (entry.name === 'AndroidManifest.xml' && /\/src\/[^/]+$/.test(dir)) {
            project.manifests.push(path)
          } else if (entry.name === 'build.gradle.kts' || entry.name === 'build.gradle') {
            project.modules.push({ dir, buildFile: path })
          }
        }
      }
    }
    frontier = next
  }
  return project
}

async function readOr($: EngineInterface, path: string, fallback: string): Promise<string> {
  try {
    const text = await $.fs.read(path)
    return typeof text === 'string' ? text : fallback
  } catch {
    return fallback
  }
}

/** Parses one file into the index's shape, or null when it holds nothing of nav. */
async function navFile($: EngineInterface, root: string, path: string): Promise<LensNavFile | null> {
  const src = await readOr($, path, '')
  if (!NAV_MARKERS.test(src)) return null
  const parsed = parseNavFile(relative(root, path), src)
  return parsed.routes.length > 0 || parsed.registrations.length > 0 ? parsed : null
}

/** Builds the route index from the walk's Kotlin files. */
export async function indexNav($: EngineInterface, project: Project, now: number): Promise<LensNavIndex> {
  const files: Record<string, LensNavFile> = {}
  const small = project.kt.filter(f => f.size <= MAX_KT_BYTES)
  const parsed = await inBatches(small, async f => [f.path, await navFile($, project.root, f.path)] as const)
  for (const [path, file] of parsed) if (file !== null) files[relative(project.root, path)] = file
  return { files, indexedAt: now }
}

/** Re-reads the given files into a copy of the index. */
export async function refreshNav($: EngineInterface, root: string, index: LensNavIndex, paths: readonly string[], now: number): Promise<LensNavIndex> {
  const files = { ...index.files }
  for (const path of paths) {
    const file = await navFile($, root, absolute(root, path))
    const key = relative(root, absolute(root, path))
    if (file === null) delete files[key]
    else files[key] = file
  }
  return { files, indexedAt: now }
}

// ---- Manifest ------------------------------------------------------------

const APP_PLUGIN = /com\.android\.application|android[.\-_]?application/i

async function newestMergedManifest($: EngineInterface, moduleDir: string): Promise<{ path: string; mtimeMs: number; variant: string } | undefined> {
  const intermediates = join(moduleDir, 'build/intermediates')
  let roots: string[]
  try {
    roots = (await $.fs.list(intermediates)).filter(e => e.kind === 'dir' && /^merged_manifests?$/.test(e.name)).map(e => join(intermediates, e.name))
  } catch {
    return undefined
  }
  let best: { path: string; mtimeMs: number; variant: string } | undefined
  const consider = async (path: string, variant: string) => {
    try {
      const st = await $.fs.stat(path)
      if (st.kind === 'file' && (best === undefined || st.mtimeMs > best.mtimeMs)) best = { path, mtimeMs: st.mtimeMs, variant }
    } catch {
      // not there in this AGP version's layout
    }
  }
  for (const r of roots) {
    // AGP 4-7: merged_manifests/<v>/AndroidManifest.xml; 8.0-8.2: merged_manifest/<v>/AndroidManifest.xml;
    // 8.3+: merged_manifest/<v>/process<V>MainManifest/AndroidManifest.xml.
    const variants = await $.fs.list(r).catch(() => [])
    for (const v of variants.filter(e => e.kind === 'dir')) {
      const vdir = join(r, v.name)
      const inside = await $.fs.list(vdir).catch(() => [])
      for (const e of inside) {
        if (e.kind === 'file' && e.name === 'AndroidManifest.xml') await consider(join(vdir, e.name), v.name)
        if (e.kind === 'dir') await consider(join(join(vdir, e.name), 'AndroidManifest.xml'), v.name)
      }
    }
  }
  return best
}

async function mergerAttribution($: EngineInterface, moduleDir: string, variant: string): Promise<Record<string, string[]>> {
  const logs = join(moduleDir, 'build/outputs/logs')
  const want = variant.toLowerCase().replace(/[^a-z0-9]/g, '')
  const entries = await $.fs.list(logs).catch(() => [])
  const report = entries
    .filter(e => e.kind === 'file' && e.name.startsWith('manifest-merger-') && e.name.toLowerCase().replace(/[^a-z0-9]/g, '').includes(want))
    .sort((a, b) => b.mtimeMs - a.mtimeMs)[0]
  if (report === undefined) return {}
  return parseMergerReport(await readOr($, join(logs, report.name), ''))
}

function sdkFromText(text: string, key: 'targetSdk' | 'minSdk'): string | undefined {
  const m = new RegExp(`\\b(?:android[-_.]?)?${key}(?:Version)?\\w*\\s*[=(]\\s*"?(\\d{2})"?`, 'i').exec(text)
  return m?.[1]
}

function libraryName(origin: string): string {
  // A path under the Gradle caches names the artifact's folder; a coordinate is kept.
  const cache = /transforms[^/]*\/[^/]+\/transformed\/([^/]+)\//.exec(origin)
  return cache?.[1] ?? origin
}

/** The manifest facts for the system prompt, or null for a project with no manifest. */
export async function gatherManifest($: EngineInterface, project: Project): Promise<LensManifest | null> {
  if (project.manifests.length === 0) return null
  const { root } = project
  const moduleOf = (path: string) =>
    project.modules
      .filter(m => path.startsWith(m.dir + '/'))
      .sort((a, b) => b.dir.length - a.dir.length)[0]

  const buildTexts = new Map<string, string>()
  for (const m of project.modules) buildTexts.set(m.dir, await readOr($, m.buildFile, ''))
  let appDirs = project.modules.filter(m => m.dir !== root && APP_PLUGIN.test(buildTexts.get(m.dir) ?? '')).map(m => m.dir)
  if (appDirs.length === 0) appDirs = project.modules.filter(m => /\/(app|androidApp)$/.test(m.dir)).map(m => m.dir)

  const facts: LensManifest = { app: [], modules: [], libraries: [], removed: [] }
  const projectNames = new Set<string>()
  for (const path of project.manifests) {
    const mod = moduleOf(path)
    const modDir = mod?.dir ?? root
    const set = /\/src\/([^/]+)\/AndroidManifest\.xml$/.exec(path)?.[1] ?? 'main'
    const { declared, removed } = permissionsOf(await readOr($, path, ''))
    const isApp = appDirs.includes(modDir)
    for (const name of declared) {
      projectNames.add(name)
      const origin = `${gradlePath(root, modDir)}${set === 'main' ? '' : ` src/${set}`}`
      const list = isApp ? facts.app : facts.modules
      if (!list.some(p => p.name === name && p.origin === origin)) list.push({ name, origin })
    }
    for (const name of removed) if (!facts.removed.includes(name)) facts.removed.push(name)
  }

  // The merged manifest: the real SDK levels and what libraries bring in.
  let merged: { path: string; mtimeMs: number; variant: string; dir: string } | undefined
  for (const dir of appDirs) {
    const found = await newestMergedManifest($, dir)
    if (found !== undefined && (merged === undefined || found.mtimeMs > merged.mtimeMs)) merged = { ...found, dir }
  }
  if (merged !== undefined) {
    const xml = await readOr($, merged.path, '')
    const sdk = usesSdk(xml)
    const where = `merged manifest, ${gradlePath(root, merged.dir)} ${merged.variant}`
    if (sdk.targetSdk !== undefined) {
      facts.targetSdk = sdk.targetSdk
      facts.targetSdkFrom = where
    }
    if (sdk.minSdk !== undefined) {
      facts.minSdk = sdk.minSdk
      facts.minSdkFrom = where
    }
    const attribution = await mergerAttribution($, merged.dir, merged.variant)
    const libraries: LensPermission[] = []
    for (const name of permissionsOf(xml).declared) {
      if (projectNames.has(name)) continue
      const from = (attribution[name] ?? []).filter(o => !o.startsWith(root)).map(libraryName)
      libraries.push({ name, origin: from.length > 0 ? from.join(', ') : 'a library' })
    }
    facts.libraries = libraries
    facts.merged = { path: relative(root, merged.path), mtimeMs: merged.mtimeMs }
  }

  // Fall back to literals in the build files, the version catalog, then build-logic.
  if (facts.targetSdk === undefined || facts.minSdk === undefined) {
    const sources: [string, string][] = []
    for (const m of project.modules.filter(x => appDirs.includes(x.dir))) {
      sources.push([relative(root, m.buildFile), buildTexts.get(m.dir) ?? ''])
    }
    const catalog = join(root, 'gradle/libs.versions.toml')
    sources.push(['gradle/libs.versions.toml', await readOr($, catalog, '')])
    for (const f of project.kt.filter(k => /\/build-logic\//.test(k.path)).slice(0, 40)) {
      sources.push([relative(root, f.path), await readOr($, f.path, '')])
    }
    for (const [from, text] of sources) {
      if (facts.targetSdk === undefined) {
        const v = sdkFromText(text, 'targetSdk')
        if (v !== undefined) {
          facts.targetSdk = v
          facts.targetSdkFrom = from
        }
      }
      if (facts.minSdk === undefined) {
        const v = sdkFromText(text, 'minSdk')
        if (v !== undefined) {
          facts.minSdk = v
          facts.minSdkFrom = from
        }
      }
    }
  }
  return facts
}

// ---- Compose compiler reports -------------------------------------------

/** Where the /stability init script writes its module index. */
export function reportIndexPath(root: string): string {
  return join(root, 'build/android-project-lens/compose-modules.txt')
}

const MAX_REPORT_BYTES = 4 * 1024 * 1024

/**
 * Reads the Compose compiler reports the init script's index names, parsing
 * only files changed since their last parse and merging them into the table.
 */
export async function loadStability($: EngineInterface, root: string, table: LensStability): Promise<{ table: LensStability; reportFiles: number }> {
  const indexPath = reportIndexPath(root)
  let indexStat
  try {
    indexStat = await $.fs.stat(indexPath)
  } catch {
    return { table, reportFiles: 0 }
  }
  const lines = (await readOr($, indexPath, '')).split('\n').map(l => l.trim()).filter(l => l.includes('='))
  let next: LensStability = { ...table, parsed: { ...table.parsed }, unstableClasses: { ...table.unstableClasses }, indexMtime: indexStat.mtimeMs }
  let reportFiles = 0
  for (const line of lines) {
    const eq = line.indexOf('=')
    const module = line.slice(0, eq)
    const dir = line.slice(eq + 1)
    const entries = await $.fs.list(dir).catch(() => [])
    for (const e of entries) {
      if (e.kind !== 'file' || e.size > MAX_REPORT_BYTES) continue
      const isComposables = e.name.endsWith('-composables.txt')
      const isClasses = e.name.endsWith('-classes.txt')
      if (!isComposables && !isClasses) continue
      reportFiles++
      const path = join(dir, e.name)
      if (next.parsed[path] === e.mtimeMs) continue
      const text = await readOr($, path, '')
      if (isComposables) next = mergeComposables(next, parseComposables(text, module))
      else Object.assign(next.unstableClasses, parseUnstableClasses(text))
      next.parsed[path] = e.mtimeMs
    }
  }
  return { table: next, reportFiles }
}
