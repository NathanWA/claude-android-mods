import { expect, test } from 'claude-code/testing'

import { EMULATOR, PHONE, fakeDevice } from './fake-device'

test('ui_tree answers with the compact hierarchy', async ($, on) => {
  fakeDevice(on, { devices: [EMULATOR] })
  const ran = await $.tool.call({ tool: 'mcp__android-screen__ui_tree' })
  expect(ran.result).toEqual([{ type: 'text', text: 'Button "Sign in" id=sign_in [clickable] @(200,230)' }])
})

test('a tool refuses to guess between several devices', async ($, on) => {
  fakeDevice(on, { devices: [EMULATOR, PHONE] })
  const ran = await $.tool.call({ tool: 'mcp__android-screen__ui_tree' })
  expect(ran.deny).toBe(
    '2 devices are connected (emulator-5554 sdk gphone64 arm64, 1A2B3C4D Pixel 8). Pass serial, or set ANDROID_SERIAL.',
  )
})

test('ANDROID_SERIAL picks the device without listing devices', async ($, on) => {
  const lines = fakeDevice(on, { devices: [EMULATOR, PHONE], serial: '1A2B3C4D' })
  await $.tool.call({ tool: 'mcp__android-screen__input', action: 'tap', x: 10, y: 20 })
  expect(lines).toEqual(["adb -s 1A2B3C4D shell 'input tap 10 20'"])
})

test('without $.process, adb goes through the Bash tool', async ($, on) => {
  const lines = fakeDevice(on, { devices: [EMULATOR], isBashOnly: true })
  const ran = await $.tool.call({ tool: 'mcp__android-screen__input', action: 'key', key: 'back' })
  expect(ran.result).toEqual([{ type: 'text', text: 'Pressed back.' }])
  expect(lines).toEqual(['adb devices -l', 'adb -s emulator-5554 shell \'input keyevent KEYCODE_BACK\''])
})

test('app restart force-stops, then launches the named package', async ($, on) => {
  const lines = fakeDevice(on, { devices: [EMULATOR] })
  const ran = await $.tool.call({ tool: 'mcp__android-screen__app', action: 'restart', package: 'com.example' })
  expect(ran.result).toEqual([{ type: 'text', text: 'Restarted com.example.' }])
  expect(lines.slice(1)).toEqual([
    "adb -s emulator-5554 shell 'am force-stop com.example'",
    "adb -s emulator-5554 shell 'monkey -p com.example -c android.intent.category.LAUNCHER 1'",
  ])
})

test('the screenshot tool returns an image block', async ($, on) => {
  fakeDevice(on, { devices: [EMULATOR] })
  const ran = await $.tool.call({ tool: 'mcp__android-screen__screenshot' })
  const blocks = ran.result as { type: string }[]
  expect(blocks.map(block => block.type)).toEqual(['image', 'text'])
})

test('/deeplink without a URI shows its usage', async $ => {
  const ran = await $.command.run({ command: 'deeplink', args: '' })
  expect(ran.text).toBe('Usage: /deeplink <uri> [package]')
})
