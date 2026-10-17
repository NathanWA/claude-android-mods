// A fake adb for the tests: answers `process.run` beneath the plugin the way
// an emulator's shell would, and records each argv it was handed.

import type { On, ProcessRunResult } from 'claude-code'

export const PKG = 'com.example.app'
export const SERIAL = 'emulator-5554'
export const WM_NS = 'androidx.work.systemjobscheduler'
const SERVICE = 'androidx.work.impl.background.systemjob.SystemJobService'

export type FakeJob = { id: number; namespace: string | null }

export type Fake = {
  calls: string[][]
  scripts: () => string[]
  api: number
  state: {
    dark: boolean
    font: string
    density: number | null
    rtl: string
    appLocales: string
    layout: string
    anim: string
    deep: string
    light: string
    bucket: string
  }
  /** The scheduled jobs; `jobs` text is printed for dumpsys when set, else these are. */
  scheduled: FakeJob[]
  jobs: string | null
}

export const ONE_JOB = `JOB SCHEDULER (dumpsys jobscheduler ${PKG})
Registered 1 jobs:
  JOB #u0a190/7: 4d5e6f7 ${PKG}/${SERVICE}
    u0a190 tag=*job*/${PKG}/${SERVICE}#7
    Source: uid=u0a190 user=0 pkg=${PKG}
    Extras: PersistableBundle[{EXTRA_WORK_SPEC_ID=2c3f6a1e-90ab-4cde-8f01-1234567890ab, EXTRA_WORK_SPEC_GENERATION=0}]
    Required constraints: TIMING_DELAY CONNECTIVITY
    Unsatisfied constraints: CONNECTIVITY
Pending queue:
  Pending #0: 4d5e6f7 #u0a190/7 ${PKG}/${SERVICE}
`

export const TWO_JOBS = `${ONE_JOB}Registered 1 more:
  JOB #u0a190/12: 9a8b7c6 ${PKG}/${SERVICE}
    Extras: PersistableBundle[{EXTRA_WORK_SPEC_ID=ffff0000-1111-2222-3333-444455556666}]
    Required constraints: CHARGING
  JOB #u0a77/3: 1112223 com.other.app/.SyncService
    Required constraints: CONNECTIVITY
`

/** What `dumpsys jobscheduler <pkg>` prints on API 35 (shape taken from an emulator). */
export function namespacedDump(jobs: readonly FakeJob[]): string {
  const blocks = jobs.map(job => {
    const head = job.namespace
      ? `  JOB ${job.namespace}:u0a215/${job.id}: 67db562 @${job.namespace}@${PKG}/${SERVICE}`
      : `  JOB #u0a215/${job.id}: 1a2b3c4 ${PKG}/.OwnJobService`
    return [
      head,
      `    u0a215 tag=*job*/@${job.namespace}@${PKG}/${SERVICE}`,
      `    Source: uid=u0a215 user=0 pkg=${PKG}`,
      '    JobInfo:',
      `      Service: ${PKG}/${SERVICE}`,
      '      Extras: mParcelledData.dataSize=248',
      '    Required constraints: CHARGING IDLE CONNECTIVITY FLEXIBILITY [0x10200005]',
      '    Unsatisfied constraints: CHARGING IDLE [0x5]',
      '    Ready: false (job=false user=true !restricted=true !pending=true !active=true !backingup=true comp=true)',
      '',
    ].join('\n')
  })
  return [
    'Settings:',
    '  min_ready_cpu_only_jobs_count=3 ',
    '',
    `Registered ${jobs.length} jobs:`,
    ...blocks,
    'PrefetchController:',
    '  Cached launch times:',
    '',
    'Pending queue:',
    '  None',
    '',
    'Active jobs:',
    '',
    'Idle contexts (1):',
    '  ID=87049004: inactive since -44s314ms, stopped because: app called jobFinished',
  ].join('\n')
}

function result(stdout: string, exitCode = 0): { value: ProcessRunResult } {
  return { value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
}

const RTL = /^(ar|fa|he|iw|ur|yi|ps|ckb|dv|ug|sd)([-_]|$)/

export function stateOutput(fake: Fake): string {
  const f = fake.state
  const density =
    f.density === null ? 'Physical density: 420' : `Physical density: 420\nOverride density: ${f.density}`
  return [
    '@@model', 'sdk_gphone64_arm64',
    '@@api', String(fake.api),
    '@@night', `Night mode: ${f.dark ? 'yes' : 'no'}`,
    '@@font', f.font,
    '@@density', density,
    '@@rtl', f.rtl,
    '@@layout', f.layout,
    '@@anim', f.anim,
    '@@deep', f.deep,
    '@@light', f.light,
    '@@bucket', f.bucket,
    '@@applocales',
    fake.api >= 33 ? `Locales for ${PKG} for user 0 are [${f.appLocales}]` : "cmd: Can't find service: locale",
  ].join('\n')
}

/** A run command's answer and exit code, as `cmd jobscheduler run` gives them. */
function runJob(fake: Fake, script: string): [string, number] {
  const m = /cmd jobscheduler run -f (?:-n (\S+) )?(\S+) (-?\d+)/.exec(script)
  if (!m) return ['usage: cmd jobscheduler run [-f] [-u USER] [-n NAMESPACE] PACKAGE JOB_ID', 255]
  const ns = m[1] ?? null
  const pkg = m[2]!
  const id = Number(m[3])
  if (fake.jobs !== null) return ['Running job [FORCED]', 0]
  return fake.scheduled.some(job => job.id === id && job.namespace === ns)
    ? ['Running job [FORCED]', 0]
    : [`Could not find job ${id} in package ${pkg} / user 0${ns ? ` and namespace ${ns}` : ''}`, 23]
}

// Applies a device-shell script's writes to the fake state, then answers
// what the device would print for it.
export function runScript(fake: Fake, script: string): [string, number] {
  const s = fake.state
  if (script.startsWith('dumpsys jobscheduler')) return [fake.jobs ?? namespacedDump(fake.scheduled), 0]
  if (script.startsWith('cmd jobscheduler run')) return runJob(fake, script)
  const night = /cmd uimode night (yes|no)/.exec(script)
  if (night) s.dark = night[1] === 'yes'
  const font = /font_scale ([\d.]+)/.exec(script)
  if (font) s.font = font[1]!
  if (/wm density reset/.test(script)) s.density = null
  const dpi = /wm density (\d+)/.exec(script)
  if (dpi) s.density = Number(dpi[1])
  let rtlOut = ''
  if (/--locales he/.test(script)) {
    // The API 33+ branch of the script's `if`, else the developer setting.
    if (fake.api >= 33) {
      rtlOut = `@@rtlprev\nLocales for ${PKG} for user 0 are [${s.appLocales}]\n@@rtlvia\napp-locale\n`
      s.appLocales = 'he'
    } else {
      s.rtl = '1'
      rtlOut = '@@rtlvia\nforce-rtl\n'
    }
  } else if (/debug\.force_rtl 1/.test(script)) {
    s.rtl = '1'
    rtlOut = '@@rtlvia\nforce-rtl\n'
  }
  if (/debug\.force_rtl 0/.test(script)) {
    s.rtl = '0'
    const back = /cmd locale set-app-locales \S+(?: --locales (\S+))?; fi/.exec(script)
    if (back && fake.api >= 33 && RTL.test(s.appLocales.split(',')[0] ?? '')) s.appLocales = back[1] ?? ''
  }
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
  return [`${script.startsWith('echo @@out') ? `@@out\n${out}\n` : ''}${rtlOut}${stateOutput(fake)}`, 0]
}

export function newFake(jobs: string | null = ONE_JOB, api = 35): Fake {
  const fake: Fake = {
    calls: [],
    scripts: () => fake.calls.filter(argv => argv.includes('shell')).map(argv => argv[argv.length - 1]!),
    api,
    state: {
      dark: false,
      font: 'null',
      density: null,
      rtl: '0',
      appLocales: '',
      layout: '',
      anim: 'null',
      deep: 'ACTIVE',
      light: 'ACTIVE',
      bucket: '10',
    },
    scheduled: [],
    jobs,
  }
  return fake
}

export function fakeDevice(on: On, jobs: string | null = ONE_JOB, api = 35): Fake {
  const fake = newFake(jobs, api)
  on('process.run', ($, e) => {
    const argv = [...e.argv]
    fake.calls.push(argv)
    if (argv[1] === 'version') return result('Android Debug Bridge version 1.0.41')
    if (argv[1] === 'devices') return result(`List of devices attached\n${SERIAL}\tdevice product:sdk model:sdk_gphone64_arm64\n`)
    const at = argv.indexOf('shell')
    const [stdout, code] = runScript(fake, argv[at + 1] ?? '')
    return result(stdout, code)
  })
  return fake
}
