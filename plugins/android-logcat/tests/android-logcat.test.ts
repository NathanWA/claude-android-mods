import { describe, expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

const GREP = 'mcp__android-logcat__logcat_grep'

/** The bottom of Bash: records each command as it reached the tool and answers `stdout`. */
function fakeBash(on: On, stdout = '') {
  const seen: string[] = []
  on('tool.call', { tool: 'Bash' }, ($, e) => {
    seen.push(e.command)
    return { result: { stdout, stderr: '', interrupted: false } }
  })
  return seen
}

/**
 * The session beneath the plugin as the desktop app has it: registrations
 * answered, a Gradle app module on disk, and no `$.process` (adb never starts).
 */
function fakeSession(on: On, cli = false) {
  const tools: { name: string; isDeferred?: boolean }[] = []
  const commands: string[] = []
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('tool.register', ($, e) => {
    tools.push(e)
    return { value: { tool: `mcp__android-logcat__${e.name}` } }
  })
  on('command.register', ($, e) => {
    commands.push(e.name)
    return { value: { command: e.name } }
  })
  on('session.root', () => ({ value: '/tmp/app' }))
  on('fs.read', ($, e) => {
    if (e.path === '/tmp/app/app/build.gradle.kts') return { value: 'android {\n  defaultConfig {\n    applicationId = "com.example.app"\n  }\n}\n' }
    return { deny: `ENOENT ${e.path}` }
  })
  on('process.run', ($, e) => {
    if (!cli) return { deny: '$.process is CLI-only' }
    const stdout = e.argv.includes('pidof') ? '4321\n' : 'Android Debug Bridge version 1.0.41\n'
    return { value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('ui.open', () => ({ value: { isPlaced: true as const } }))
  on('ui.toast', () => ({ value: undefined }))
  return { tools, commands }
}

const THREADTIME = [
  '--------- beginning of main',
  '10-15 09:12:01.100  4321  4321 D OkHttp  : --> GET https://api.example.com/v1/me',
  '10-15 09:12:01.101  4321  4321 D OkHttp  : Authorization: Bearer sk_live_9f8e7d6c5b4a39281706',
  '10-15 09:12:01.300  4321  4350 I Koin    : loaded 42 definitions',
  '10-15 09:12:02.000  4321  4321 W Compose : Recomposition skipped for HomeScreen',
  '10-15 09:12:03.500  4321  4321 E AndroidRuntime: FATAL EXCEPTION: main',
  '10-15 09:12:03.501  4321  4321 E AndroidRuntime: java.lang.IllegalStateException: user jane.doe@example.com not found',
].join('\n')

describe('bounding the model\'s logcat calls', () => {
  test('a bare adb logcat gets -d -t 800', async ($, on) => {
    const seen = fakeBash(on)
    const ran = await $.tool.call({ tool: 'Bash', command: 'adb logcat' })
    expect(seen).toEqual(['adb logcat -d -t 800'])
    expect(ran.context?.join('\n') ?? '').toContain('-d -t 800')
  })

  test('a bare call behind a serial and a pipe is bounded in place', async ($, on) => {
    const seen = fakeBash(on)
    await $.tool.call({
      tool: 'Bash',
      command: 'adb -s emulator-5554 logcat -v threadtime | grep MyTag',
    })
    expect(seen).toEqual(['adb -s emulator-5554 logcat -d -t 800 -v threadtime | grep MyTag'])
  })

  test('an already-bounded call is passed through untouched', async ($, on) => {
    const seen = fakeBash(on)
    const bounded = [
      'adb logcat -d -s MyTag:V',
      'adb logcat -t 100',
      'adb logcat --pid=1234 -v brief',
      'adb logcat -c',
      'adb logcat | head -50',
    ]
    for (const command of bounded) await $.tool.call({ tool: 'Bash', command })
    expect(seen).toEqual(bounded)
  })

  test('gradlew commands are left to build-output-distiller', async ($, on) => {
    const seen = fakeBash(on)
    const command = './gradlew installDebug && adb logcat'
    await $.tool.call({ tool: 'Bash', command })
    expect(seen).toEqual([command])
  })

  test('a known pid scopes the call to the app', async ($, on) => {
    const answers: Record<string, string> = { 'adb shell pidof -s com.example.app': '4321\n' }
    const seen: string[] = []
    on('tool.call', { tool: 'Bash' }, ($, e) => {
      seen.push(e.command)
      return { result: { stdout: answers[e.command] ?? '', stderr: '', interrupted: false } }
    })
    await $.tool.call({ tool: 'Bash', command: 'adb shell pidof -s com.example.app' })
    await $.tool.call({ tool: 'Bash', command: 'adb logcat' })
    expect(seen[1]).toBe('adb logcat -t 200 --pid=4321')
  })
})

describe('redacting adb output', () => {
  test('tokens, bearer headers and emails never reach the model', async ($, on) => {
    const raw = [
      'Account {name=jane.doe@example.com, type=com.google}',
      'Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NSJ9.c2lnbmF0dXJlLXZhbHVl',
      'refresh_token=0a1b2c3d4e5f6g7h8i9j',
      'contact jane.doe@example.com again',
    ].join('\n')
    fakeBash(on, raw)
    const ran = await $.tool.call({ tool: 'Bash', command: 'adb shell dumpsys account' })
    if (ran.deny !== undefined || ran.isError === true) throw new Error('the call was refused')
    const { stdout } = ran.result
    expect(stdout).not.toContain('jane.doe@example.com')
    expect(stdout).not.toContain('eyJhbGciOiJIUzI1NiJ9')
    expect(stdout).not.toContain('0a1b2c3d4e5f6g7h8i9j')
    // The same value keeps the same placeholder across lines.
    expect(stdout.split('<EMAIL#1>').length - 1).toBe(2)
    expect(stdout).toContain('Authorization: <SECRET#1>')
    expect(stdout).toContain('refresh_token=<SECRET#2>')
    expect(ran.context?.join('\n') ?? '').toContain('redacted')
  })

  test('output with nothing to redact keeps the core result as it was', async ($, on) => {
    fakeBash(on, 'List of devices attached\nemulator-5554\tdevice\n')
    const ran = await $.tool.call({ tool: 'Bash', command: 'adb devices' })
    if (ran.deny !== undefined || ran.isError === true) throw new Error('the call was refused')
    expect(ran.result.stdout).toContain('emulator-5554')
    expect(ran.context ?? []).toEqual([])
  })
})

describe('the logcat buffer', () => {
  test('logcat_grep searches the buffer by level, tag and regex', async ($, on) => {
    fakeBash(on, THREADTIME)
    const session = fakeSession(on)
    await $.session.start({ cwd: '/tmp/app', surface: null, isInteractive: false })
    expect(session.tools).toEqual([expect.objectContaining({ name: 'logcat_grep', isDeferred: false })])
    expect(session.commands).toEqual(['logcat'])
    await $.tool.call({ tool: 'Bash', command: 'adb logcat -v threadtime' })

    const errors = await $.tool.call({ tool: GREP, level: 'E' })
    if (errors.deny !== undefined) throw new Error(errors.deny)
    const errorText = String(errors.result)
    expect(errorText).toContain('2 of 6 buffered lines match')
    expect(errorText).toContain('FATAL EXCEPTION')
    expect(errorText).not.toContain('Koin')
    expect(errorText).not.toContain('jane.doe@example.com')

    const okhttp = await $.tool.call({ tool: GREP, tag: 'okhttp', regex: 'authorization' })
    if (okhttp.deny !== undefined) throw new Error(okhttp.deny)
    expect(String(okhttp.result)).toContain('Authorization: <SECRET#1>')
    expect(String(okhttp.result)).not.toContain('sk_live')

    const bad = await $.tool.call({ tool: GREP, regex: '(' })
    expect(String(bad.result)).toContain('Invalid regex')
  })

  test('the /logcat pane draws the buffer on terminal and desktop', async ($, on) => {
    fakeBash(on, THREADTIME)
    fakeSession(on)
    await $.session.start({ cwd: '/tmp/app', surface: null, isInteractive: false })
    await $.tool.call({ tool: 'Bash', command: 'adb logcat -d' })
    const opened = await $.command.run({
      command: 'logcat',
      args: '',
      origin: { kind: 'composer' },
      presentation: { isFullscreen: true, columns: 120 },
    })
    expect(opened.text ?? '').toContain('6 buffered lines')

    for (const surface of ['terminal', 'desktop'] as const) {
      const ui = await $.ui.mount({
        plugin: 'android-logcat',
        surface,
        component: 'Pane',
        requestId: 'android-logcat',
        props: {
          title: 'logcat',
          isFocused: true,
          bodyColumns: 100,
          placement: 'dock',
          scroll: { offset: 0, bodyRows: 30 },
          view: {},
        },
        viewport: { columns: 100, rows: 40 },
      })
      expect(await ui.find({ type: 'Text', text: /FATAL EXCEPTION/ })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /6\/6 lines/ })).toBeDefined()

      await ui.select({ key: 'level', value: 'E' })
      expect(await ui.find({ type: 'Text', text: /Koin/ })).toBeUndefined()
      expect(await ui.find({ type: 'Text', text: /2\/6 lines/ })).toBeDefined()
      await ui.select({ key: 'level', value: 'V' })
      await ui.unmount()
    }
  })

  test('where $.process works, one live child feeds the pid-scoped buffer', async ($, on) => {
    const clock = mock.clock(on)
    fakeSession(on, true)
    const spawned: string[][] = []
    on('process.spawn', async function* ($, e) {
      spawned.push([...e.argv])
      // Another pid's line is dropped; the app's lines arrive split mid-line.
      yield { stream: 'stdout' as const, text: '10-15 09:20:00.000   999   999 E Other   : not ours\n10-15 09:20:00.100  4321  4321 E AndroidRuntime: FATAL EXC' }
      yield { stream: 'stdout' as const, text: 'EPTION: main\n10-15 09:20:00.200  4321  4321 D OkHttp  : token=abcd1234efgh\n' }
      return { value: { code: 0, signal: null } }
    })
    await $.session.start({ cwd: '/tmp/app', surface: null, isInteractive: true })
    await clock.advance(1000)

    expect(spawned).toEqual([['adb', 'logcat', '-v', 'threadtime', '-T', '1', '--pid=4321']])
    const all = await $.tool.call({ tool: GREP })
    if (all.deny !== undefined) throw new Error(all.deny)
    const text = String(all.result)
    expect(text).toContain('2 of 2 buffered lines match (pid 4321 (com.example.app))')
    expect(text).toContain('FATAL EXCEPTION: main')
    expect(text).toContain('token=<SECRET#1>')
    expect(text).not.toContain('not ours')
  })
})
