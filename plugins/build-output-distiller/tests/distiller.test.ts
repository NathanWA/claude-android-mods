import type { On, ToolCallResult } from 'claude-code'
import { describe, expect, mock, test } from 'claude-code/testing'

const PLUGIN = 'build-output-distiller'
const CWD = '/work/acme'
const NOW = 1_760_000_000_000

/** Up-to-date task lines a real run prints by the dozen. */
const TASK_NOISE = Array.from({ length: 70 }, (_, i) => `> Task :app:task${i} UP-TO-DATE`).join('\n')

const KOTLIN_FAILURE = `Exit code 1
${TASK_NOISE}
> Task :app:compileDebugKotlin FAILED
e: file:///work/acme/app/src/main/java/com/acme/ui/HomeScreen.kt:42:17 Unresolved reference 'viewModle'.
e: file:///work/acme/app/src/main/java/com/acme/ui/HomeScreen.kt:58:9 Argument type mismatch: actual type is 'String', but 'Int' was expected.
w: file:///work/acme/app/src/main/java/com/acme/Legacy.kt:3:1 'Foo' is deprecated.

FAILURE: Build failed with an exception.

* What went wrong:
Execution failed for task ':app:compileDebugKotlin'.
> A failure occurred while executing org.jetbrains.kotlin.compilerRunner.GradleCompilerRunnerWithWorkers$GradleKotlinCompilerWorkAction
   > Compilation error. See log for more details

* Try:
> Run with --stacktrace option to get the stack trace.
> Run with --info or --debug option to get more log output.

BUILD FAILED in 14s
31 actionable tasks: 5 executed, 26 up-to-date`

const DAGGER_FAILURE = `${TASK_NOISE}
> Task :app:kspDebugKotlin FAILED
e: [ksp] /work/acme/app/build/generated/hilt/component_sources/debug/com/acme/AcmeApp_HiltComponents.java:155: [Dagger/MissingBinding] com.acme.data.UserRepository cannot be provided without an @Provides-annotated method.
      com.acme.data.UserRepository is injected at
          [com.acme.AcmeApp_HiltComponents.ViewModelC] com.acme.ui.HomeViewModel(userRepository)
      com.acme.ui.HomeViewModel is injected at
          [com.acme.AcmeApp_HiltComponents.ViewModelC] com.acme.ui.HomeViewModel_HiltModules.BindsModule.binds(vm)

FAILURE: Build failed with an exception.

* What went wrong:
Execution failed for task ':app:kspDebugKotlin'.
> A failure occurred while executing com.google.devtools.ksp.gradle.KspAAWorkerAction
   > KSP failed with exit code: PROCESSING_ERROR

BUILD FAILED in 9s
24 actionable tasks: 3 executed, 21 up-to-date`

const DEPENDENCY_TREE = [
  '> Task :app:dependencies',
  '',
  'releaseRuntimeClasspath - Runtime classpath of compilation release.',
  ...Array.from({ length: 120 }, (_, i) => `+--- com.acme.lib:lib${i}:1.${i}.0 -> 1.${i}.1`),
  '',
  'BUILD SUCCESSFUL in 2s',
  '1 actionable task: 1 executed',
].join('\n')

const TEST_FAILURE = `Exit code 1
${TASK_NOISE}
> Task :app:testDebugUnitTest FAILED

LoginViewModelTest > emits error on bad password FAILED
    java.lang.AssertionError at LoginViewModelTest.kt:57

3 tests completed, 1 failed

FAILURE: Build failed with an exception.

* What went wrong:
Execution failed for task ':app:testDebugUnitTest'.
> There were failing tests. See the report at: file:///work/acme/app/build/reports/tests/testDebugUnitTest/index.html

BUILD FAILED in 21s`

const JUNIT_XML = `<?xml version="1.0" encoding="UTF-8"?>
<testsuite name="com.acme.LoginViewModelTest" tests="3" skipped="0" failures="1" errors="0" timestamp="2026-10-15T12:00:00" time="0.4">
  <testcase name="emits loading first" classname="com.acme.LoginViewModelTest" time="0.1"/>
  <testcase name="emits error on bad password" classname="com.acme.LoginViewModelTest" time="0.2">
    <failure message="expected:&lt;Error&gt; but was:&lt;Loading&gt;" type="java.lang.AssertionError">java.lang.AssertionError: expected:&lt;Error&gt; but was:&lt;Loading&gt;
	at org.junit.Assert.fail(Assert.java:89)
	at com.acme.LoginViewModelTest$emits error on bad password$1.invokeSuspend(LoginViewModelTest.kt:57)
	at kotlinx.coroutines.test.TestBuildersKt.runTest(TestBuilders.kt:40)
</failure>
  </testcase>
  <testcase name="emits success" classname="com.acme.LoginViewModelTest" time="0.1"/>
  <system-out><![CDATA[]]></system-out>
</testsuite>`

const HOME_SCREEN = Array.from({ length: 70 }, (_, i) =>
  i === 41 ? '    val state by viewModle.state.collectAsState()' : `    // line ${i + 1}`,
).join('\n')

type Entry = { name: string; kind: 'file' | 'dir'; mtimeMs?: number }

/** The world beneath the plugin: the session's directory, a file system in
 * memory, the clock, toasts, and no model. */
function world(on: On, files: Record<string, string> = {}, dirs: Record<string, Entry[]> = {}) {
  const written: Record<string, string> = {}
  const toasts: string[] = []
  mock.clock(on, { now: NOW })
  on('session.cwd', () => ({ value: CWD }))
  on('fs.read', ($, e) => {
    const text = files[e.path]
    return text === undefined ? { deny: `ENOENT: ${e.path}` } : { value: text }
  })
  on('fs.write', ($, e) => {
    written[e.path] = e.text
    return { value: undefined }
  })
  on('fs.list', ($, e) => {
    const list = dirs[e.path]
    return list === undefined
      ? { deny: `ENOENT: ${e.path}` }
      : { value: list.map(entry => ({ size: 0, isLink: false, mtimeMs: 0, ...entry })) }
  })
  on('fs.exists', ($, e) => ({ value: e.path in files || e.path in dirs }))
  on('ui.toast', ($, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  on('model.classify', () => ({ value: undefined }))
  // Permission rules: every Bash command is allowed unless a test says otherwise.
  on('tool.check', () => ({ decision: 'allow' as const }))
  return { written, toasts }
}

type BashSeen = { command: string; timeout?: number; run_in_background?: boolean }

/** Answers every Bash call with `answer`, recording what reached the tool. */
function bash(on: On, answer: ToolCallResult<'Bash'>): BashSeen[] {
  const seen: BashSeen[] = []
  on('tool.call', { tool: 'Bash' }, ($, e) => {
    seen.push({ command: e.command, timeout: e.timeout, run_in_background: e.run_in_background })
    return answer
  })
  return seen
}

function failed(text: string): ToolCallResult<'Bash'> {
  return { isError: true, result: text, text }
}

function stdoutOf(ran: ToolCallResult<'Bash'>): string {
  if (ran.deny !== undefined || ran.isError) throw new Error(`expected a result, got ${JSON.stringify(ran)}`)
  return ran.result.stdout
}

describe('build-output-distiller', () => {
  test('a failing Kotlin compile becomes a digest with file:line context', async ($, on) => {
    const { written } = world(on)
    const seen = bash(on, failed(KOTLIN_FAILURE))

    const ran = await $.tool.call({ tool: 'Bash', command: './gradlew :app:assembleDebug', run_in_background: true })

    expect(seen).toEqual([
      { command: './gradlew :app:assembleDebug --console=plain', timeout: 600_000, run_in_background: false },
    ])
    const stdout = stdoutOf(ran)
    expect(stdout).toContain('Gradle: BUILD FAILED in 14s · exit code 1 · failed: :app:compileDebugKotlin')
    expect(stdout).toContain('Kotlin compiler errors (2):')
    expect(stdout).toContain("app/src/main/java/com/acme/ui/HomeScreen.kt:42:17  Unresolved reference 'viewModle'.")
    expect(stdout).toContain('app/src/main/java/com/acme/ui/HomeScreen.kt:58:9  Argument type mismatch')
    expect(stdout).toContain('1 compiler warning left out.')
    expect(stdout).toContain('the whole output is in build/build-output-distiller/last-run.log')
    expect(stdout).not.toContain('> Task :app:task3 UP-TO-DATE')
    expect(stdout.length).toBeLessThan(KOTLIN_FAILURE.length / 2)
    expect(ran.result).toMatchObject({ stderr: '' })
    expect(ran.context).toEqual([
      'build-output-distiller: files to open, in order: app/src/main/java/com/acme/ui/HomeScreen.kt:42, app/src/main/java/com/acme/ui/HomeScreen.kt:58',
      expect.stringContaining('Kotlin: fix the first error first'),
    ])
    expect(written[`${CWD}/build/build-output-distiller/last-run.log`]).toBe(KOTLIN_FAILURE)
  })

  test('the console flag is left off when a permission rule would no longer match', async ($, on) => {
    on('tool.check', { tool: 'Bash' }, ($, e) =>
      String((e.input as { command: string }).command).endsWith('--console=plain')
        ? { decision: 'ask' as const }
        : { decision: 'allow' as const, rule: 'Bash(./gradlew :app:assembleDebug)' },
    )
    world(on)
    const seen = bash(on, failed(KOTLIN_FAILURE))

    const ran = await $.tool.call({ tool: 'Bash', command: './gradlew :app:assembleDebug' })

    expect(seen).toEqual([{ command: './gradlew :app:assembleDebug', timeout: 600_000, run_in_background: false }])
    expect(stdoutOf(ran)).toContain('Kotlin compiler errors (2):')
  })

  test('a Hilt MissingBinding names the type, its trace and the binding to add', async ($, on) => {
    const persisted = '/Users/me/.claude/projects/acme/tool-results/b1.txt'
    const { written } = world(on, { [persisted]: DAGGER_FAILURE })
    bash(on, {
      result: {
        stdout: '<persisted-output>\nOutput too large (52KB).\n</persisted-output>',
        stderr: '',
        interrupted: false,
        persistedOutputPath: persisted,
        persistedOutputSize: 52_000,
      },
    })

    const ran = await $.tool.call({ tool: 'Bash', command: 'cd . && ./gradlew assembleDebug' })

    const stdout = stdoutOf(ran)
    expect(stdout).toContain('failed: :app:kspDebugKotlin')
    expect(stdout).toContain('Hilt / Dagger errors (1):')
    expect(stdout).toContain(
      'app/build/generated/hilt/component_sources/debug/com/acme/AcmeApp_HiltComponents.java:155  [Dagger/MissingBinding] com.acme.data.UserRepository cannot be provided',
    )
    expect(stdout).toContain('      com.acme.data.UserRepository is injected at')
    expect(stdout).toContain('KSP failed with exit code: PROCESSING_ERROR')
    expect(stdout).toContain(`the whole output is in ${persisted}`)
    expect(stdout).not.toContain('<persisted-output>')
    expect(ran.result).not.toHaveProperty('persistedOutputPath')
    expect(ran.context?.[1]).toContain('Hilt/Dagger: nothing provides com.acme.data.UserRepository')
    expect(written).toEqual({})
  })

  test('./gradlew dependencies passes through untouched', async ($, on) => {
    world(on)
    const answer: ToolCallResult<'Bash'> = { result: { stdout: DEPENDENCY_TREE, stderr: '', interrupted: false } }
    const seen = bash(on, answer)

    const ran = await $.tool.call({ tool: 'Bash', command: './gradlew dependencies' })

    expect(seen).toEqual([{ command: './gradlew dependencies', timeout: undefined, run_in_background: undefined }])
    expect(stdoutOf(ran)).toBe(DEPENDENCY_TREE)
    expect(ran.context).toBeUndefined()
  })

  test('the same failure twice says the last fix did not take', async ($, on) => {
    const { toasts } = world(on)
    bash(on, failed(KOTLIN_FAILURE))

    const first = await $.tool.call({ tool: 'Bash', command: './gradlew assembleDebug' })
    expect(first.context?.join('\n')).not.toContain('the last fix did not take')
    expect(toasts).toEqual([])

    const second = await $.tool.call({ tool: 'Bash', command: './gradlew assembleDebug' })
    expect(second.context?.[0]).toBe(
      "build-output-distiller: the last fix did not take. This is the same failure as the previous Gradle run: :app:compileDebugKotlin: app/src/main/java/com/acme/ui/HomeScreen.kt: Unresolved reference 'viewModle'. Re-read the code at that location and reconsider the cause before editing again.",
    )
    expect(toasts).toEqual(['Same Gradle failure again (2 runs in a row): :app:compileDebugKotlin'])

    const third = await $.tool.call({ tool: 'Bash', command: './gradlew assembleDebug' })
    expect(third.context?.[0]).toContain('(3 runs in a row)')
  })

  test('a different failure in between does not count as a repeat', async ($, on) => {
    world(on)
    let answer = failed(KOTLIN_FAILURE)
    on('tool.call', { tool: 'Bash' }, () => answer)

    await $.tool.call({ tool: 'Bash', command: './gradlew assembleDebug' })
    answer = failed(DAGGER_FAILURE)
    const other = await $.tool.call({ tool: 'Bash', command: './gradlew assembleDebug' })
    answer = failed(KOTLIN_FAILURE)
    const back = await $.tool.call({ tool: 'Bash', command: './gradlew assembleDebug' })

    expect(other.context?.join('\n')).not.toContain('the last fix did not take')
    expect(back.context?.join('\n')).not.toContain('the last fix did not take')
  })

  test('failing unit tests are summed up per module from the new JUnit XML', async ($, on) => {
    const results = `${CWD}/app/build/test-results`
    world(
      on,
      {
        [`${results}/testDebugUnitTest/TEST-com.acme.LoginViewModelTest.xml`]: JUNIT_XML,
        [`${CWD}/app/src/test/kotlin/com/acme/LoginViewModelTest.kt`]: '',
      },
      {
        [results]: [{ name: 'testDebugUnitTest', kind: 'dir' }, { name: 'binary', kind: 'dir' }],
        [`${results}/testDebugUnitTest`]: [
          { name: 'TEST-com.acme.LoginViewModelTest.xml', kind: 'file', mtimeMs: NOW + 5_000 },
          { name: 'TEST-com.acme.OldTest.xml', kind: 'file', mtimeMs: NOW - 60_000 },
        ],
      },
    )
    bash(on, failed(TEST_FAILURE))

    const ran = await $.tool.call({ tool: 'Bash', command: './gradlew :app:testDebugUnitTest' })

    const stdout = stdoutOf(ran)
    expect(stdout).toContain('Tests (from build/test-results):')
    expect(stdout).toContain('  :app — 3 tests, 1 failed')
    expect(stdout).toContain('    com.acme.LoginViewModelTest > emits error on bad password')
    expect(stdout).toContain('      expected:<Error> but was:<Loading>')
    expect(stdout).toContain('      at app/src/test/kotlin/com/acme/LoginViewModelTest.kt:57')
    expect(stdout).not.toContain('OldTest')
    expect(ran.context?.[0]).toBe(
      'build-output-distiller: files to open, in order: app/src/test/kotlin/com/acme/LoginViewModelTest.kt:57',
    )
  })

  test('failing tests with no new XML pass the raw output through', async ($, on) => {
    world(on, {}, { [`${CWD}/app/build/test-results`]: [] })
    const answer = failed(TEST_FAILURE)
    bash(on, answer)

    const ran = await $.tool.call({ tool: 'Bash', command: './gradlew :app:testDebugUnitTest' })

    expect(ran).toMatchObject({ isError: true, text: TEST_FAILURE })
  })

  test('a small passing build is left as it is', async ($, on) => {
    world(on)
    const stdout = '> Task :app:assembleDebug UP-TO-DATE\n\nBUILD SUCCESSFUL in 1s\n42 actionable tasks: 42 up-to-date'
    bash(on, { result: { stdout, stderr: '', interrupted: false } })

    const ran = await $.tool.call({ tool: 'Bash', command: './gradlew assembleDebug' })

    expect(stdoutOf(ran)).toBe(stdout)
  })

  test('/build draws one Code element per error, with the lines around it', async ($, on) => {
    world(on, { [`${CWD}/app/src/main/java/com/acme/ui/HomeScreen.kt`]: HOME_SCREEN })
    bash(on, failed(KOTLIN_FAILURE))
    await $.tool.call({ tool: 'Bash', command: './gradlew assembleDebug' })

    for (const surface of ['terminal', 'desktop'] as const) {
      const ui = await $.ui.mount({
        plugin: PLUGIN,
        surface,
        component: 'Pane',
        requestId: 'gradle-build',
        props: {
          title: 'Gradle build',
          isFocused: false,
          bodyColumns: 100,
          placement: 'dock',
          scroll: { offset: 0, bodyRows: 40 },
          view: {},
        },
      })
      const codes = await ui.findAll({ type: 'Code' })
      expect(codes).toHaveLength(2)
      expect(codes[0]?.props).toMatchObject({ startLine: 40, path: 'app/src/main/java/com/acme/ui/HomeScreen.kt' })
      expect(codes[0]?.text).toContain('viewModle.state')
      expect(await ui.find({ type: 'Text', text: /BUILD FAILED in 14s/ })).toBeDefined()
      await ui.unmount()
    }
  })
})
