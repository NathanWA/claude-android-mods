import { expect, mock, test } from 'claude-code/testing'

import { ROOT, fixtureFiles, serveFixture } from './fixture'

const NAV_TOOL = 'mcp__android-project-lens__nav_graph'
const START = { cwd: ROOT, surface: 'desktop', isInteractive: true } as const
const TURN = { answer: 'Done.', durationMs: 10, isAborted: false, turnId: 't1', reason: 'answer' } as const

test('nav_graph answers a route with its arguments, declaration and registration', async ($, on) => {
  mock.clock(on, { now: 10_000 })
  serveFixture(on, fixtureFiles())
  await $.session.start(START)

  const one = await $.tool.call({ tool: NAV_TOOL, route: 'Detail' })
  expect(one.deny).toBeUndefined()
  const text = String(one.result)
  expect(text).toContain('Route.Detail(id: String, tab: Int = 0) [class]')
  expect(text).toContain('declared feature/detail/src/main/kotlin/com/example/detail/Routes.kt:11')
  expect(text).toContain('composable<Route.Detail> at app/src/main/kotlin/com/example/app/AppNavHost.kt:7')

  const all = String((await $.tool.call({ tool: NAV_TOOL })).result)
  expect(all).toContain('Navigation 2 and Navigation 3')
  expect(all).toContain('Route.Home [object]')
  expect(all).toContain('navigation<AuthGraph>')
  expect(all).toContain('entry<SettingsKey> at feature/settings/src/main/kotlin/com/example/settings/SettingsEntries.kt:7')
  expect(all).toMatch(/LegacyRoute \[object\] declared [^\n]*NOT REGISTERED/)
  // A @Serializable DTO is no route, and test source sets are not indexed.
  expect(all).not.toContain('UserDto')
  expect(all).not.toContain('TestOnlyRoute')
})

test('turn.complete reports a route declared this turn that no nav host registers, once', async ($, on) => {
  mock.clock(on, { now: 10_000 })
  const files = fixtureFiles()
  serveFixture(on, files)
  const session = mock.session(on)
  on('turn.complete', ($, e) => ({ text: e.answer }))
  on('tool.call', { tool: 'Write' }, ($, e) => {
    files.set(e.file_path, { text: e.content, mtimeMs: 20_000 })
    return { result: { type: 'create', filePath: e.file_path, content: e.content, structuredPatch: [], originalFile: null } }
  })
  await $.session.start(START)

  const written = await $.tool.call({
    tool: 'Write',
    file_path: `${ROOT}/feature/profile/src/main/kotlin/com/example/profile/ProfileRoute.kt`,
    content: 'package com.example.profile\n\n@Serializable\ndata class ProfileRoute(val userId: Long)\n',
  })
  expect(written.deny).toBeUndefined()

  await $.turn.complete(TURN)
  const reports = session.appended().map(r => JSON.stringify(r.message.content))
  expect(reports.length).toBe(1)
  expect(reports[0]).toContain('ProfileRoute (feature/profile/src/main/kotlin/com/example/profile/ProfileRoute.kt:4)')
  // The route that was already unregistered at session start is the baseline.
  expect(reports[0]).not.toContain('LegacyRoute')

  // The same route is not reported again at the next turn's end.
  await $.turn.complete({ ...TURN, turnId: 't2' })
  expect(session.appended().length).toBe(1)

  // nav_graph sees the new file as soon as it is asked.
  const profile = String((await $.tool.call({ tool: NAV_TOOL, route: 'Profile' })).result)
  expect(profile).toContain('ProfileRoute(userId: Long)')
  expect(profile).toContain('NOT REGISTERED')
})

test('prompt.compose carries targetSdk, minSdk and permissions by origin', async ($, on) => {
  mock.clock(on, { now: 10_000 })
  serveFixture(on, fixtureFiles())
  on('prompt.compose', () => ({ sections: [{ id: 'intro', text: 'You are Claude Code.', scope: 'shared' }] }))
  await $.session.start(START)

  const { sections } = await $.prompt.compose({
    model: 'claude-opus-5-5',
    promptModel: 'claude-opus-5-5',
    surfaces: ['desktop'],
    tools: [],
    outputStyle: null,
    traits: [],
  })
  expect(sections[0]?.id).toBe('intro')
  const lens = sections.find(s => s.id === 'android-project-lens:manifest')
  expect(lens?.scope).toBe('session')
  const text = lens?.text ?? ''
  expect(text).toContain('targetSdk 35 (merged manifest, :app debug)')
  expect(text).toContain('minSdk 26 (merged manifest, :app debug)')
  expect(text).toContain('Permissions the app module declares: CAMERA, INTERNET (:app)')
  expect(text).toContain('Permissions other project modules declare: ACCESS_NETWORK_STATE (:feature:detail)')
  expect(text).toContain('Permissions merged in from libraries: WAKE_LOCK (androidx.work:work-runtime:2.9.0)')
  expect(text).toContain('Removed with tools:node="remove": READ_PHONE_STATE')
  // A commented-out permission is not one.
  expect(text).not.toContain('RECORD_AUDIO')
})

test('an edit adding a Play-declaration permission asks first, and a no holds it back', async ($, on) => {
  mock.clock(on, { now: 10_000 })
  const files = fixtureFiles()
  serveFixture(on, files)
  const asked: string[] = []
  let answer = 'Leave it out'
  on('tool.call', { tool: 'AskUserQuestion' }, ($, e) => {
    const question = e.questions[0]?.question ?? ''
    asked.push(question)
    return { result: { questions: e.questions, answers: { [question]: answer } } }
  })
  const edits: string[] = []
  on('tool.call', { tool: 'Edit' }, ($, e) => {
    edits.push(e.new_string)
    return {
      result: {
        filePath: e.file_path,
        oldString: e.old_string,
        newString: e.new_string,
        originalFile: null,
        structuredPatch: [],
        userModified: false,
        replaceAll: false,
      },
    }
  })
  await $.session.start(START)

  const manifest = `${ROOT}/app/src/main/AndroidManifest.xml`
  const anchor = '<uses-permission android:name="android.permission.CAMERA" />'
  const addBackground = {
    tool: 'Edit',
    file_path: manifest,
    old_string: anchor,
    new_string: `${anchor}\n    <uses-permission android:name="android.permission.ACCESS_BACKGROUND_LOCATION" />`,
  } as const

  const refused = await $.tool.call(addBackground)
  expect(asked.length).toBe(1)
  expect(asked[0]).toContain('ACCESS_BACKGROUND_LOCATION')
  expect(asked[0]).toContain('Play Console')
  expect(refused.deny).toContain('chose not to add ACCESS_BACKGROUND_LOCATION')
  expect(edits.length).toBe(0)

  answer = 'Add it'
  const allowed = await $.tool.call(addBackground)
  expect(allowed.deny).toBeUndefined()
  expect(asked.length).toBe(2)
  expect(edits.length).toBe(1)

  // A permission with no Play declaration is not asked about.
  const vibrate = await $.tool.call({
    tool: 'Edit',
    file_path: manifest,
    old_string: anchor,
    new_string: `${anchor}\n    <uses-permission android:name="android.permission.VIBRATE" />`,
  })
  expect(vibrate.deny).toBeUndefined()
  expect(asked.length).toBe(2)
  expect(edits.length).toBe(2)
})

test('an edit to a composable the reports call unstable carries that fact; /stability read lists it', async ($, on) => {
  mock.clock(on, { now: 10_000 })
  const files = fixtureFiles()
  const put = (path: string, text: string) => files.set(`${ROOT}/${path}`, { text, mtimeMs: 6_000 })
  put('build/android-project-lens/compose-modules.txt', `:app=${ROOT}/app/build/compose_compiler\n`)
  put(
    'app/build/compose_compiler/app_debug-composables.txt',
    [
      'restartable skippable scheme("[androidx.compose.ui.UiComposable]") fun Greeting(',
      '  unstable items: List<Item>',
      '  stable modifier: Modifier? = @static Companion',
      ')',
      'restartable skippable scheme("[androidx.compose.ui.UiComposable]") fun Title(',
      '  stable text: String',
      ')',
    ].join('\n'),
  )
  put('app/build/compose_compiler/app_debug-classes.txt', 'unstable class Item {\n  unstable val tags: MutableList<String>\n  <runtime stability> = Unstable\n}\n')
  serveFixture(on, files)
  on('tool.call', { tool: 'Write' }, ($, e) => ({
    result: { type: 'update', filePath: e.file_path, content: e.content, structuredPatch: [], originalFile: null },
  }))
  await $.session.start(START)

  const greeting = await $.tool.call({
    tool: 'Write',
    file_path: `${ROOT}/app/src/main/kotlin/com/example/app/Greeting.kt`,
    content: '@Composable\nfun Greeting(items: List<Item>, modifier: Modifier = Modifier) {\n  Title("hi")\n}\n',
  })
  const context = (greeting.context ?? []).join('\n')
  expect(context).toContain('Greeting (:app) has unstable parameters: items: List<Item>.')
  // Title is called here, not defined, and is stable anyway.
  expect(context).not.toContain('Title')
  expect(context).not.toContain('skippable')

  const plain = await $.tool.call({
    tool: 'Write',
    file_path: `${ROOT}/app/src/main/kotlin/com/example/app/Other.kt`,
    content: 'fun helper() = 1\n',
  })
  expect(plain.context ?? []).toEqual([])

  const report = await $.command.run({
    command: 'stability',
    args: 'read',
    origin: { kind: 'composer' },
    presentation: { isFullscreen: false, columns: 120 },
  })
  expect(report.text).toContain('1 composables have unstable parameters; 1 classes are unstable.')
  expect(report.text).toContain('- Greeting (:app): items: List<Item>')
  expect(report.text).toContain('Item (unstable members val tags: MutableList<String>)')
})
