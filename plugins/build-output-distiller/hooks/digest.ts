// Turns a parsed Gradle run into the short text the model reads in place of
// the console output, the file:line list, and the fix hints.

import type { BuildError, BuildErrorKind } from '../types'

import type { TestFailure } from './junit'
import { missingBinding, type ParsedOutput } from './parse'

export type ModuleTests = {
  /** `:app`, `:core:data`, or the module's directory when no task named it. */
  module: string
  tests: number
  failed: number
  skipped: number
  failures: (TestFailure & { path?: string })[]
}

export type DigestInput = {
  parsed: ParsedOutput
  isFailed: boolean
  exitCode?: number
  /** The parsed errors, paths made relative, test failures included. */
  errors: BuildError[]
  tests?: ModuleTests[]
  /** Where the whole console output can still be read. */
  logPath?: string
}

const SECTIONS: [BuildErrorKind, string][] = [
  ['kotlin', 'Kotlin compiler errors'],
  ['java', 'javac / kapt errors'],
  ['dagger', 'Hilt / Dagger errors'],
  ['room', 'Room errors'],
  ['ksp', 'KSP errors'],
  ['aapt', 'Android resource (AAPT) errors'],
  ['manifest', 'Manifest merger errors'],
  ['r8', 'R8 errors'],
  ['lint', 'Errors reported at file:line'],
  ['gradle', 'Build script errors'],
]
const PER_SECTION = 15
const OTHER_LINES = 30

export function buildDigest(input: DigestInput): string {
  const { parsed, isFailed, exitCode, errors, tests, logPath } = input
  const out: string[] = []

  const outcome = isFailed ? 'BUILD FAILED' : 'BUILD SUCCESSFUL'
  const head = [`Gradle: ${outcome}${parsed.duration ? ` in ${parsed.duration}` : ''}`]
  if (exitCode !== undefined && exitCode !== 0) head.push(`exit code ${exitCode}`)
  if (isFailed && parsed.failedTasks.length > 0) head.push(`failed: ${parsed.failedTasks.join(', ')}`)
  else if (parsed.actionable) head.push(parsed.actionable)
  out.push(head.join(' · '))
  out.push(
    `[build-output-distiller: ${parsed.lineCount.toLocaleString('en-US')} lines of console output distilled` +
      (logPath ? `; the whole output is in ${logPath}]` : ']'),
  )

  for (const [kind, title] of SECTIONS) {
    const list = errors.filter(error => error.kind === kind)
    if (list.length === 0) continue
    out.push('', `${title} (${list.length}):`)
    for (const error of list.slice(0, PER_SECTION)) {
      out.push(`  ${location(error)}${error.message}`)
      const room = kind === 'dagger' ? 10 : 4
      for (const line of (error.detail ?? []).slice(0, room)) out.push(`      ${line}`)
    }
    if (list.length > PER_SECTION) out.push(`  … and ${list.length - PER_SECTION} more`)
    if (kind === 'r8' && parsed.missingRules) out.push(`  Rules R8 suggests: ${parsed.missingRules}`)
  }

  if (parsed.wentWrong.length > 0) {
    out.push('', 'What went wrong:')
    for (const block of parsed.wentWrong) {
      for (const line of block.slice(0, 12)) out.push(`  ${line}`)
    }
  }

  if (tests !== undefined && tests.length > 0) {
    out.push('', 'Tests (from build/test-results):')
    for (const module of tests) {
      const parts = [`${module.tests} tests`]
      parts.push(module.failed > 0 ? `${module.failed} failed` : 'all passed')
      if (module.skipped > 0) parts.push(`${module.skipped} skipped`)
      out.push(`  ${module.module} — ${parts.join(', ')}`)
      for (const failure of module.failures.slice(0, 10)) {
        out.push(`    ${failure.className} > ${failure.name}`)
        out.push(`      ${failure.message}`)
        const where = failure.path ?? failure.file
        if (where) out.push(`      at ${where}${failure.line ? `:${failure.line}` : ''}`)
      }
      if (module.failures.length > 10) out.push(`    … and ${module.failures.length - 10} more`)
    }
  }

  if (parsed.warnings > 0) out.push('', `${parsed.warnings} compiler warning${parsed.warnings === 1 ? '' : 's'} left out.`)

  if (!isFailed && parsed.other.length > 0) {
    const tail = parsed.other.slice(-OTHER_LINES)
    out.push('', `Other output${parsed.other.length > OTHER_LINES ? ` (last ${OTHER_LINES} lines)` : ''}:`)
    for (const line of tail) out.push(`  ${line}`)
  }

  return out.join('\n')
}

/** `path:line` of every located error, in order, once each. */
export function fileLines(errors: BuildError[]): string[] {
  const seen: string[] = []
  for (const error of errors) {
    if (error.file === undefined) continue
    const spot = error.line === undefined ? error.file : `${error.file}:${error.line}`
    if (!seen.includes(spot)) seen.push(spot)
  }
  return seen
}

const WENT_WRONG_HINTS: [RegExp, string][] = [
  [/There were failing tests|tests completed, \d+ failed/i, 'Tests failed: open each failing test at the line given; rerun one with --tests "<Class>.<method>" while fixing it.'],
  [/Could not resolve|Could not find [\w.-]+:[\w.-]+|Failed to resolve/i, 'Dependency resolution failed: check the coordinates and version (libs.versions.toml), that a repository in settings.gradle(.kts) hosts it, and that the run is not --offline without a cached copy.'],
  [/SDK location not found|ANDROID_HOME|sdk\.dir/i, 'Android SDK not found: set sdk.dir in local.properties, or ANDROID_HOME.'],
  [/Unsupported class file major version|requires Java \d+|Android Gradle plugin requires Java|JVM target compatibility|toolchain/i, 'JDK mismatch: AGP 8+ needs JDK 17+. Check JAVA_HOME or org.gradle.java.home, and that jvmToolchain / jvmTarget agree between Java and Kotlin.'],
  [/OutOfMemoryError|Java heap space|Metaspace|GC overhead/i, 'Out of memory: raise org.gradle.jvmargs (and kotlin.daemon.jvmargs) in gradle.properties, e.g. -Xmx4g.'],
  [/Duplicate class/i, 'Duplicate classes: two dependencies ship the same class. Find them with ./gradlew :app:dependencies, then exclude one or align versions with a BOM.'],
  [/Lint found (\d+ )?errors|lintVital/i, 'Lint failed the build: read the report path above and fix the issues it lists (or update the baseline), rather than turning off abortOnError.'],
  [/Manifest merger failed/i, 'Manifest merger: add tools:replace="<attribute>" (or tools:node) on the conflicting element, or align the value with the library manifest.'],
  [/Android resource linking failed|AAPT/i, 'Resource linking: the named resource or attribute is not defined where it is used. Check the name, the res qualifier folders, and that the module defining it is a dependency.'],
  [/keystore|signing config|SigningConfig/i, 'Signing: the keystore path, alias or passwords for this build type are missing or wrong (often read from local.properties or the environment).'],
  [/configuration cache problems?/i, 'Configuration cache: the report named above lists each problem; a task reading project state at execution time is the usual cause.'],
  [/minSdk(Version)? \d+ cannot be smaller/i, 'minSdk: a library needs a higher minSdk. Raise it, or use tools:overrideLibrary if you guard the calls.'],
  [/depend on it to compile against version|compileSdk/i, 'compileSdk: a dependency needs a newer compileSdk; raise it to the version the AAR metadata check names.'],
  [/Plugin \[id: .+\] was not found|Plugin with id '.+' not found/i, 'Gradle plugin not found: check its id and version in libs.versions.toml [plugins] and the pluginManagement repositories.'],
  [/Script compilation error|Unresolved reference: libs|build\.gradle/i, 'Build script error: fix the build.gradle(.kts) line named above; a version-catalog accessor typo (libs.x.y) is a common cause.'],
]

/** Labels `$.model.classify` picks from when no pattern explains a failure. */
export const CLASSIFY_HINTS: Record<string, string> = {
  'dependency-resolution': 'This looks like a dependency resolution failure: check coordinates, versions and repositories.',
  'jdk-or-toolchain': 'This looks like a JDK / toolchain mismatch: check JAVA_HOME, org.gradle.java.home and jvmToolchain.',
  'android-sdk': 'This looks like an Android SDK problem: check sdk.dir, compileSdk and installed platforms/build-tools.',
  'out-of-memory': 'This looks like the Gradle or Kotlin daemon running out of memory: raise org.gradle.jvmargs.',
  'build-script': 'This looks like an error in a build script or convention plugin: read the build file named in the output.',
  'source-code': 'This looks like an error in the source code: read the files named in the output.',
  other: 'No known cause: read the full output at the path above.',
}

/** What to do about each kind of error present, most specific first. */
export function fixHints(errors: BuildError[], parsed: ParsedOutput): string[] {
  const hints: string[] = []
  const kinds = new Set(errors.map(error => error.kind))
  const push = (hint: string) => {
    if (!hints.includes(hint)) hints.push(hint)
  }

  for (const error of errors.filter(one => one.kind === 'dagger')) {
    const type = missingBinding(error.message)
    if (type) {
      push(
        `Hilt/Dagger: nothing provides ${type}. Give it an @Inject constructor, or add a @Provides/@Binds for it in a @Module @InstallIn(<the component that injects it>) that this module can see; a qualifier on the injection site must be on the binding too. The indented trace shows who asked for it.`,
      )
    } else if (/DuplicateBindings/.test(error.message)) {
      push('Hilt/Dagger: the same type is bound twice in one component. Remove one binding or tell them apart with a qualifier.')
    } else {
      push('Hilt/Dagger: read the [Dagger/...] message and its trace; the first indented line names the element that needs fixing.')
    }
  }
  if (kinds.has('kotlin')) {
    push(
      "Kotlin: fix the first error first; later ones often cascade from it. An unresolved reference usually means a missing import, a typo, or a dependency missing from this module's own build.gradle(.kts).",
    )
  }
  if (kinds.has('java')) push('javac / kapt: errors in build/generated or build/tmp/kapt3 stubs point back to the annotated Kotlin source; fix that source, not the generated file.')
  if (kinds.has('room')) {
    push('Room checks SQL at compile time: compare the @Query table and column names with the @Entity (and @ColumnInfo(name)), and add a Migration when the schema changes.')
  }
  if (kinds.has('ksp')) push('KSP: the message names the element the processor rejected. If Kotlin errors are listed too, fix those first; processors often fail on code that does not compile.')
  if (kinds.has('aapt')) {
    push('Resource linking: the named resource or attribute is not defined where it is used. Check the name and the res qualifier folders; with non-transitive R classes, use the R of the module that defines it.')
  }
  if (kinds.has('manifest')) push('Manifest merger: add tools:replace="<attribute>" on the conflicting element (with xmlns:tools), or align the value with the library manifest.')
  if (kinds.has('r8')) {
    push(
      `R8 missing classes: if they are compile-only annotations, add the -dontwarn lines from ${parsed.missingRules ?? 'build/outputs/mapping/<variant>/missing_rules.txt'} to proguard-rules.pro; otherwise add the dependency that provides them.`,
    )
  }
  if (kinds.has('lint')) push('A checker (lint, detekt, ktlint) reported these at file:line; fix them in place or update its baseline.')
  if (kinds.has('gradle')) push('Build script error: fix the build.gradle(.kts) line named; a version-catalog accessor typo (libs.x.y) is a common cause.')
  if (kinds.has('test')) push('Tests failed: open each failing test at the line given; rerun one with --tests "<Class>.<method>" while fixing it.')

  const wentWrong = parsed.wentWrong.flat().join('\n')
  for (const [pattern, hint] of WENT_WRONG_HINTS) {
    if (pattern.test(wentWrong)) push(hint)
  }
  return hints.slice(0, 4)
}

function location(error: BuildError): string {
  if (error.file === undefined) return ''
  const line = error.line === undefined ? '' : `:${error.line}${error.column === undefined ? '' : `:${error.column}`}`
  return `${error.file}${line}  `
}
