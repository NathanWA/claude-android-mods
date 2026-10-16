// A fake adb for the tests: answers `process.run` beneath the plugin the way
// an emulator's shell would, and records each argv it was handed.

import type { On, ProcessRunResult } from 'claude-code'

export const PKG = 'com.example.app'
export const SERIAL = 'emulator-5554'

export type Fake = {
  calls: string[][]
  scripts: () => string[]
  state: {
    dark: boolean
    font: string
    density: number | null
    rtl: string
    layout: string
    anim: string
    deep: string
    light: string
    bucket: string
  }
  jobs: string
}

export const ONE_JOB = `JOB SCHEDULER (dumpsys jobscheduler ${PKG})
Registered 1 jobs:
  JOB #u0a190/7: 4d5e6f7 ${PKG}/androidx.work.impl.background.systemjob.SystemJobService
    u0a190 tag=*job*/${PKG}/androidx.work.impl.background.systemjob.SystemJobService#7
    Source: uid=u0a190 user=0 pkg=${PKG}
    Extras: PersistableBundle[{EXTRA_WORK_SPEC_ID=2c3f6a1e-90ab-4cde-8f01-1234567890ab, EXTRA_WORK_SPEC_GENERATION=0}]
    Required constraints: TIMING_DELAY CONNECTIVITY
    Unsatisfied constraints: CONNECTIVITY
Pending queue:
  Pending #0: 4d5e6f7 #u0a190/7 ${PKG}/androidx.work.impl.background.systemjob.SystemJobService
`

export const TWO_JOBS = `${ONE_JOB}Registered 1 more:
  JOB #u0a190/12: 9a8b7c6 ${PKG}/androidx.work.impl.background.systemjob.SystemJobService
    Extras: PersistableBundle[{EXTRA_WORK_SPEC_ID=ffff0000-1111-2222-3333-444455556666}]
    Required constraints: CHARGING
  JOB #u0a77/3: 1112223 com.other.app/.SyncService
    Required constraints: CONNECTIVITY
`

function ok(stdout: string, stderr = ''): { value: ProcessRunResult } {
  return { value: { exitCode: 0, stdout, stderr, isStdoutTruncated: false, isStderrTruncated: false } }
}

export function stateOutput(f: Fake['state']): string {
  const density =
    f.density === null ? 'Physical density: 420' : `Physical density: 420\nOverride density: ${f.density}`
  return [
    '@@model', 'sdk_gphone64_arm64',
    '@@api', '35',
    '@@night', `Night mode: ${f.dark ? 'yes' : 'no'}`,
    '@@font', f.font,
    '@@density', density,
    '@@rtl', f.rtl,
    '@@layout', f.layout,
    '@@anim', f.anim,
    '@@deep', f.deep,
    '@@light', f.light,
    '@@bucket', f.bucket,
  ].join('\n')
}

// Applies a device-shell script's writes to the fake state, then answers
// what the device would print for it.
export function runScript(fake: Fake, script: string): string {
  const s = fake.state
  if (script.startsWith('dumpsys jobscheduler')) return fake.jobs
  if (script.startsWith('cmd jobscheduler run')) return 'Running job [FORCED]'
  const night = /cmd uimode night (yes|no)/.exec(script)
  if (night) s.dark = night[1] === 'yes'
  const font = /font_scale ([\d.]+)/.exec(script)
  if (font) s.font = font[1]!
  if (/wm density reset/.test(script)) s.density = null
  const dpi = /wm density (\d+)/.exec(script)
  if (dpi) s.density = Number(dpi[1])
  const rtl = /debug\.force_rtl (\d)/.exec(script)
  if (rtl) s.rtl = rtl[1]!
  const layout = /setprop debug\.layout (\w+)/.exec(script)
  if (layout) s.layout = layout[1]!
  const anim = /animator_duration_scale (\d)/.exec(script)
  if (anim) s.anim = anim[1]!
  let out = ''
  if (/deviceidle force-idle/.test(script)) {
    s.deep = 'IDLE'
    out = 'Now forced in to deep idle mode'
  }
  if (/deviceidle unforce/.test(script)) {
    s.deep = 'ACTIVE'
    out = 'Light state: ACTIVE, deep state: ACTIVE'
  }
  const bucket = /set-standby-bucket \S+ (\w+)/.exec(script)
  if (bucket) s.bucket = { active: '10', working_set: '20', frequent: '30', rare: '40', restricted: '45' }[bucket[1]!] ?? '10'
  return `${script.startsWith('echo @@out') ? `@@out\n${out}\n` : ''}${stateOutput(s)}`
}

export function newFake(jobs = ONE_JOB): Fake {
  const fake: Fake = {
    calls: [],
    scripts: () => fake.calls.filter(argv => argv.includes('shell')).map(argv => argv[argv.length - 1]!),
    state: {
      dark: false,
      font: 'null',
      density: null,
      rtl: '0',
      layout: '',
      anim: 'null',
      deep: 'ACTIVE',
      light: 'ACTIVE',
      bucket: '10',
    },
    jobs,
  }
  return fake
}

export function fakeDevice(on: On, jobs = ONE_JOB): Fake {
  const fake = newFake(jobs)
  on('process.run', ($, e) => {
    const argv = [...e.argv]
    fake.calls.push(argv)
    if (argv[1] === 'version') return ok('Android Debug Bridge version 1.0.41')
    if (argv[1] === 'devices') return ok(`List of devices attached\n${SERIAL}\tdevice product:sdk model:sdk_gphone64_arm64\n`)
    const at = argv.indexOf('shell')
    return ok(runScript(fake, argv[at + 1] ?? ''))
  })
  return fake
}
