import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import { fixJobschedulerCommand, parseJobs, parseState } from '../hooks/adb'
import { ONE_JOB, PKG, SERIAL, TWO_JOBS, fakeDevice, newFake, stateOutput } from './fake-device'

const OPTIONS = { options: { package: PKG, pollSeconds: 0 } }
const SET = 'mcp__android-device-console__set_device_state'
const RUN = 'mcp__android-device-console__run_worker'
const DOZE = 'mcp__android-device-console__set_doze'

const COMPOSE = {
  model: 'claude-opus-5-5',
  promptModel: 'claude-opus-5-5',
  surfaces: [],
  tools: [],
  outputStyle: null,
  traits: [],
} as const

async function sections($: Engine) {
  return (await $.prompt.compose(COMPOSE)).sections
}

// --- set_device_state ---------------------------------------------------------

test('set_device_state flips dark mode and font scale on the ANDROID_SERIAL device', OPTIONS, async ($, on) => {
  mock.env(on, { ANDROID_SERIAL: SERIAL })
  mock.clock(on)
  const fake = fakeDevice(on)

  const r = await $.tool.call({ tool: SET, dark: true, fontScale: 1.3 })

  expect(r.deny).toBeUndefined()
  expect(String(r.result)).toContain('dark mode on')
  expect(String(r.result)).toContain('font scale 1.3 (not default)')
  const shell = fake.calls.find(argv => argv.includes('shell'))!
  expect(shell.slice(1, 4)).toEqual(['-s', SERIAL, 'shell'])
  expect(fake.scripts()[0]).toContain('cmd uimode night yes')
  expect(fake.scripts()[0]).toContain('settings put system font_scale 1.3')
})

test('set_device_state sets density, RTL, layout bounds and animations', OPTIONS, async ($, on) => {
  mock.env(on, { ANDROID_SERIAL: SERIAL })
  mock.clock(on)
  const fake = fakeDevice(on)

  const r = await $.tool.call({ tool: SET, density: 560, rtl: true, layoutBounds: true, animations: false })

  const text = String(r.result)
  expect(text).toContain('density 560 dpi (overridden; physical 420)')
  expect(text).toContain('forced RTL on')
  expect(text).toContain('layout bounds on')
  expect(text).toContain('animations off')
  expect(text).toContain('restart the app')
  const script = fake.scripts()[0]!
  expect(script).toContain('wm density 560')
  expect(script).toContain('settings put global window_animation_scale 0')
  expect(script).toContain('service call activity 1599295570')
})

test('set_device_state refuses bad input before touching the device', OPTIONS, async ($, on) => {
  mock.env(on, { ANDROID_SERIAL: SERIAL })
  const fake = fakeDevice(on)

  expect((await $.tool.call({ tool: SET, fontScale: 9 })).deny).toContain('fontScale')
  expect((await $.tool.call({ tool: SET })).deny).toContain('at least one')
  expect(fake.calls).toEqual([])
})

test('with no ANDROID_SERIAL, the one ready device is targeted', OPTIONS, async ($, on) => {
  mock.env(on, {})
  mock.clock(on)
  const fake = fakeDevice(on)

  await $.tool.call({ tool: SET, dark: true })

  expect(fake.calls.some(argv => argv[1] === 'devices')).toBe(true)
  expect(fake.calls.find(argv => argv.includes('shell'))?.slice(1, 3)).toEqual(['-s', SERIAL])
})

test('several devices and no choice: the tool says so and runs nothing on a device', OPTIONS, async ($, on) => {
  mock.env(on, {})
  const calls: string[][] = []
  on('process.run', ($, e) => {
    calls.push([...e.argv])
    const stdout =
      e.argv[1] === 'devices'
        ? 'List of devices attached\nemulator-5554\tdevice model:A\nR58M123\tdevice model:B\n'
        : 'Android Debug Bridge version 1.0.41'
    return { value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })

  const r = await $.tool.call({ tool: SET, dark: true })

  expect(r.deny).toContain('2 devices are connected')
  expect(r.deny).toContain('ANDROID_SERIAL')
  expect(calls.some(argv => argv.includes('shell'))).toBe(false)
})

// --- run_worker -----------------------------------------------------------------

test('run_worker finds the only job and force-runs it', OPTIONS, async ($, on) => {
  mock.env(on, { ANDROID_SERIAL: SERIAL })
  const fake = fakeDevice(on, ONE_JOB)

  const r = await $.tool.call({ tool: RUN })

  expect(r.deny).toBeUndefined()
  expect(String(r.result)).toContain(`Forced job 7 of ${PKG}`)
  expect(fake.scripts()).toEqual([`dumpsys jobscheduler ${PKG}`, `cmd jobscheduler run -f ${PKG} 7`])
})

test('run_worker picks a job by WorkSpec id, and asks when it cannot tell', OPTIONS, async ($, on) => {
  mock.env(on, { ANDROID_SERIAL: SERIAL })
  const fake = fakeDevice(on, TWO_JOBS)

  const ambiguous = await $.tool.call({ tool: RUN })
  expect(ambiguous.deny).toContain('2 jobs are scheduled')

  const r = await $.tool.call({ tool: RUN, workSpecId: 'ffff0000-1111-2222-3333-444455556666' })
  expect(String(r.result)).toContain('Forced job 12')
  expect(fake.scripts().at(-1)).toBe(`cmd jobscheduler run -f ${PKG} 12`)

  const direct = await $.tool.call({ tool: RUN, jobId: 7 })
  expect(String(direct.result)).toContain('Forced job 7')
})

// --- set_doze -------------------------------------------------------------------

test('set_doze forces deep idle and sets the standby bucket in one adb call', OPTIONS, async ($, on) => {
  mock.env(on, { ANDROID_SERIAL: SERIAL })
  mock.clock(on)
  const fake = fakeDevice(on)

  const r = await $.tool.call({ tool: DOZE, state: 'idle', bucket: 'rare' })

  const text = String(r.result)
  expect(text).toContain('Now forced in to deep idle mode')
  expect(text).toContain('Doze deep IDLE')
  expect(text).toContain(`${PKG} standby bucket rare`)
  expect(fake.scripts()).toHaveLength(1)
  const script = fake.scripts()[0]!
  expect(script).toContain('dumpsys deviceidle enable; dumpsys battery unplug; dumpsys deviceidle force-idle')
  expect(script).toContain(`am set-standby-bucket ${PKG} rare`)

  const off = await $.tool.call({ tool: DOZE, state: 'off' })
  expect(String(off.result)).toContain('Doze deep ACTIVE')
  expect((await $.tool.call({ tool: DOZE, bucket: 'sometimes' })).deny).toContain('bucket must be one of')
})

// --- the jobscheduler command fix -------------------------------------------------

function bash(on: On) {
  const seen: string[] = []
  on('tool.call', { tool: 'Bash' }, ($, e) => {
    seen.push(e.command)
    return { result: { stdout: 'Running job [FORCED]', stderr: '', interrupted: false } }
  })
  return seen
}

test('adds -f and the package to a hand-typed jobscheduler run', OPTIONS, async ($, on) => {
  mock.env(on, {})
  const seen = bash(on)

  const r = await $.tool.call({ tool: 'Bash', command: 'adb shell cmd jobscheduler run 7 && echo done' })

  expect(seen).toEqual([`adb shell cmd jobscheduler run -f ${PKG} 7 && echo done`])
  expect(r.context?.join('\n')).toContain('added -f')
  expect(r.context?.join('\n')).toContain(`added the package ${PKG}`)
})

test('puts the package before the id and leaves a correct command alone', OPTIONS, async ($, on) => {
  mock.env(on, {})
  const seen = bash(on)

  await $.tool.call({ tool: 'Bash', command: `adb shell "cmd jobscheduler run -f 7 ${PKG}"` })
  const fine = await $.tool.call({ tool: 'Bash', command: `adb shell cmd jobscheduler run -f ${PKG} 7` })

  expect(seen).toEqual([`adb shell "cmd jobscheduler run -f ${PKG} 7"`, `adb shell cmd jobscheduler run -f ${PKG} 7`])
  expect(fine.context).toBeUndefined()
})

test('fills a missing job id from the jobs the console knows, refuses when several', OPTIONS, async ($, on) => {
  mock.env(on, { ANDROID_SERIAL: SERIAL })
  fakeDevice(on, ONE_JOB)
  const seen = bash(on)

  await $.tool.call({ tool: RUN })
  const r = await $.tool.call({ tool: 'Bash', command: `adb shell cmd jobscheduler run -f ${PKG}` })

  expect(seen).toEqual([`adb shell cmd jobscheduler run -f ${PKG} 7`])
  expect(r.context?.join('\n')).toContain('added job id 7')
})

test('refuses a missing job id when the app has several jobs', OPTIONS, async ($, on) => {
  mock.env(on, { ANDROID_SERIAL: SERIAL })
  fakeDevice(on, TWO_JOBS)
  const seen = bash(on)

  await $.tool.call({ tool: RUN })
  const r = await $.tool.call({ tool: 'Bash', command: `adb shell cmd jobscheduler run -f ${PKG}` })

  expect(seen).toEqual([])
  expect(r.deny).toContain('7 (WorkSpec 2c3f6a1e')
  expect(r.deny).toContain('12 (WorkSpec ffff0000')
})

test('the fixer as a pure function: serial only when the person chose one', () => {
  const fix = fixJobschedulerCommand('adb shell cmd jobscheduler run 3', {
    pkg: PKG,
    jobs: [],
    serialToInsert: 'R58M123',
  })
  expect(fix).toEqual({
    command: `adb -s R58M123 shell cmd jobscheduler run -f ${PKG} 3`,
    notes: ['added -f so the job runs even with unmet constraints', `added the package ${PKG}`, 'targeted R58M123 with -s'],
  })
  expect(fixJobschedulerCommand('./gradlew :app:installDebug', { pkg: PKG, jobs: [], serialToInsert: null })).toEqual({
    command: './gradlew :app:installDebug',
    notes: [],
  })
  expect(fixJobschedulerCommand('adb shell cmd jobscheduler run 3', { pkg: null, jobs: [], serialToInsert: null })).toHaveProperty('deny')
})

// --- the prompt section -----------------------------------------------------------

test('the system prompt states the device state once it is known', OPTIONS, async ($, on) => {
  mock.env(on, { ANDROID_SERIAL: SERIAL })
  mock.clock(on)
  fakeDevice(on)
  on('prompt.compose', () => ({ sections: [{ id: 'intro', text: 'You are Claude.', scope: 'shared' }] }))

  expect((await sections($)).map(s => s.id)).toEqual(['intro'])

  await $.tool.call({ tool: SET, dark: true, fontScale: 1.3 })
  const after = await sections($)

  expect(after.map(s => s.id)).toEqual(['intro', 'android-device-console:device'])
  const device = after[1]!
  expect(device.scope).toBe('session')
  expect(device.text).toContain(`Target: ${SERIAL}, sdk_gphone64_arm64, API 35.`)
  expect(device.text).toContain('dark mode on')
  expect(device.text).toContain('font scale 1.3')
  expect(device.text).toContain(`${PKG} standby bucket active`)
})

// --- the Bash fallback and the band -----------------------------------------------

test('without $.process the band presses go through the Bash tool with consent', OPTIONS, async ($, on) => {
  mock.env(on, { ANDROID_SERIAL: SERIAL })
  mock.clock(on)
  on('process.run', () => {
    throw new Error('process is CLI only')
  })
  const fake = newFake()
  const commands: string[] = []
  const consents: (string | undefined)[] = []
  on('tool.call', { tool: 'Bash' }, ($, e) => {
    commands.push(e.command)
    consents.push((e as { consent?: string }).consent)
    const script = /shell '(.*)'$/s.exec(e.command)?.[1]?.replaceAll(`'\\''`, "'") ?? ''
    fake.calls.push(['adb', '-s', SERIAL, 'shell', script])
    const stdout = stateOutput(fake.state)
    return { result: { stdout: script.startsWith('echo @@out') ? `@@out\n${stdout}` : stdout, stderr: '', interrupted: false } }
  })

  await $.tool.call({ tool: SET, fontScale: 1.15 })
  expect(commands[0]).toMatch(/^adb -s emulator-5554 shell 'echo @@out; settings put system font_scale 1.15;/)

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({
      plugin: 'android-device-console',
      surface,
      component: 'AbovePrompt',
      props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 100, scroll: { offset: 0, bodyRows: 9 }, view: {} },
    })
    expect(await ui.find({ key: 'dark' })).toBeDefined()
    await ui.press({ key: 'dark' })
    await ui.unmount()
  }
  expect(commands.filter(c => c.includes('cmd uimode night yes'))).toHaveLength(2)
  expect(consents[0]).toBeUndefined()
  expect(consents.at(-1)).toBe('The user pressed "Dark off" in the Android device console')
})

// --- parsers on other API levels ------------------------------------------------------

test('parsers tolerate older and missing dumpsys output', () => {
  const old = parseState(
    SERIAL,
    '@@model\nNexus 5X\n@@api\n26\n@@night\nNight mode: auto\n@@font\nnull\n@@density\nPhysical density: 420\n' +
      '@@rtl\nnull\n@@layout\n\n@@anim\nnull\n@@deep\nUnknown command: get\n@@light\n\n@@bucket\nactive',
    0,
  )
  expect(old.isDark).toBeNull()
  expect(old.fontScale).toBe(1)
  expect(old.density).toBe(420)
  expect(old.isRtl).toBe(false)
  expect(old.hasAnimations).toBe(true)
  expect(old.deepIdle).toBeNull()
  expect(old.bucket).toBe('active')
  expect(parseJobs('JOB #1000/3: abc com.other/.Svc\n', PKG)).toEqual([])
  expect(parseJobs(TWO_JOBS, null).map(j => j.id)).toEqual([7, 12, 3])
})

// --- the /device pane -----------------------------------------------------------

test('the /device pane draws toggles, Doze controls and a run button per job', OPTIONS, async ($, on) => {
  mock.env(on, { ANDROID_SERIAL: SERIAL })
  mock.clock(on)
  const fake = fakeDevice(on, ONE_JOB)
  await $.tool.call({ tool: DOZE, state: 'off' })
  await $.tool.call({ tool: RUN, jobId: 7 })
  await $.tool.call({ tool: RUN })

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({
      plugin: 'android-device-console',
      surface,
      component: 'Pane',
      requestId: 'device-console',
      props: { title: 'Android device', isFocused: true, bodyColumns: 80, placement: 'dock', scroll: { offset: 0, bodyRows: 30 }, view: {} },
    })
    for (const key of ['dark', 'font', 'density', 'rtl', 'bounds', 'anims', 'idle', 'unforce', 'bucket', 'run-7']) {
      expect(await ui.find({ key })).toBeDefined()
    }
    await ui.unmount()
  }

  const ui = await $.ui.mount({
    plugin: 'android-device-console',
    surface: 'desktop',
    component: 'Pane',
    requestId: 'device-console',
    props: { title: 'Android device', isFocused: true, bodyColumns: 80, placement: 'dock', scroll: { offset: 0, bodyRows: 30 }, view: {} },
  })
  await ui.press({ key: 'idle' })
  expect(fake.scripts().at(-1)).toContain('dumpsys deviceidle force-idle')
  await ui.select({ key: 'bucket', value: 'restricted' })
  expect(fake.scripts().at(-1)).toContain(`am set-standby-bucket ${PKG} restricted`)
  await ui.press({ key: 'run-7' })
  expect(fake.scripts().at(-1)).toBe(`cmd jobscheduler run -f ${PKG} 7`)
  await ui.unmount()
})
