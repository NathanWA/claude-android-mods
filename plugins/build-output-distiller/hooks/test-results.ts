// Finds the JUnit XML a Gradle run just wrote and sums it up per module.

import type { EngineInterface } from 'claude-code'

import type { ModuleTests } from './digest'
import { parseJUnit } from './junit'
import { join, relativeTo } from './paths'

export type CollectInput = {
  /** The Gradle project's directory. */
  root: string
  /** The session's directory, which paths are shown relative to. */
  cwd: string
  /** Milliseconds; only XML written since counts. */
  since: number
  /** Module directories relative to `root` (`''` the root project). */
  moduleDirs: string[]
  /** Module directories a test report named (absolute). */
  reportDirs: string[]
}

const MAX_FILES = 200
const SOURCE_SETS = ['test', 'testDebug', 'androidUnitTest', 'jvmTest', 'commonTest', 'androidTest', 'androidInstrumentedTest']
const RESULT_DIRS = ['build/test-results', 'build/outputs/androidTest-results']

/** The modules whose test results are new since the run started; empty when
 * the run wrote none. */
export async function collectTests($: EngineInterface, input: CollectInput): Promise<ModuleTests[]> {
  const dirs = new Set([...input.reportDirs, ...input.moduleDirs.map(dir => join(input.root, dir))])
  if (dirs.size === 0) {
    for (const dir of await discoverModules($, input.root)) dirs.add(dir)
  }

  const modules: ModuleTests[] = []
  let budget = MAX_FILES
  for (const dir of dirs) {
    const files: string[] = []
    for (const results of RESULT_DIRS) {
      await walk($, join(dir, results), 3, input.since, files)
    }
    if (files.length === 0) continue
    const module: ModuleTests = { module: moduleLabel(input.root, dir), tests: 0, failed: 0, skipped: 0, failures: [] }
    for (const file of files.slice(0, budget)) {
      const xml = await $.fs.read(file).catch(() => undefined)
      if (typeof xml !== 'string') continue
      const counts = parseJUnit(xml)
      module.tests += counts.tests
      module.failed += counts.failed
      module.skipped += counts.skipped
      module.failures.push(...counts.failures)
    }
    budget -= files.length
    for (const failure of module.failures.slice(0, 10)) {
      const found = await locateSource($, dir, failure.className, failure.file)
      if (found) Object.assign(failure, { path: relativeTo(input.cwd, found) })
    }
    modules.push(module)
    if (budget <= 0) break
  }
  return modules.sort((a, b) => b.failed - a.failed)
}

/** Collects TEST-*.xml under `dir`, `depth` levels down, written since `since`. */
async function walk($: EngineInterface, dir: string, depth: number, since: number, into: string[]): Promise<void> {
  const entries = await $.fs.list(dir).catch(() => [])
  for (const entry of entries) {
    const path = join(dir, entry.name)
    if (entry.kind === 'dir' && depth > 0 && entry.name !== 'binary') {
      await walk($, path, depth - 1, since, into)
    } else if (entry.kind === 'file' && /^TEST-.*\.xml$/.test(entry.name) && entry.mtimeMs >= since - 2000) {
      into.push(path)
    }
  }
}

/** The modules under `root` that have test results at all, two levels deep. */
async function discoverModules($: EngineInterface, root: string): Promise<string[]> {
  const found = [root]
  const top = await $.fs.list(root).catch(() => [])
  for (const entry of top.filter(one => one.kind === 'dir' && !one.name.startsWith('.')).slice(0, 40)) {
    const dir = join(root, entry.name)
    found.push(dir)
    if (await $.fs.exists(join(dir, 'build')).catch(() => false)) continue
    const nested = await $.fs.list(dir).catch(() => [])
    for (const child of nested.filter(one => one.kind === 'dir' && !one.name.startsWith('.')).slice(0, 20)) {
      found.push(join(dir, child.name))
    }
  }
  return found
}

/** `<module>/src/test/kotlin/com/acme/FooTest.kt`, when it is there. */
async function locateSource(
  $: EngineInterface,
  moduleDir: string,
  className: string,
  file: string | undefined,
): Promise<string | undefined> {
  if (file === undefined) return undefined
  const pkg = className.split('.').slice(0, -1).join('/')
  for (const set of SOURCE_SETS) {
    for (const language of ['kotlin', 'java']) {
      const candidate = join(moduleDir, 'src', set, language, pkg, file)
      if (await $.fs.exists(candidate).catch(() => false)) return candidate
    }
  }
  return undefined
}

function moduleLabel(root: string, dir: string): string {
  const relative = relativeTo(root, dir)
  if (relative === '' || relative === '.') return ':'
  return relative.startsWith('/') ? relative : `:${relative.split('/').join(':')}`
}
