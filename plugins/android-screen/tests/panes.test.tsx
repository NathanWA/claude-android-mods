import { expect, test } from 'claude-code/testing'

import { EMULATOR, PHONE, fakeDevice } from './fake-device'

function mirrorPane() {
  return {
    plugin: 'android-screen',
    component: 'Pane' as const,
    requestId: 'android-mirror',
    viewport: { columns: 100, rows: 40 },
    props: { title: 'Device', isFocused: false, bodyColumns: 60, placement: 'dock', scroll: {}, view: {} } as never,
  }
}

test('the mirror draws a screenshot after a refresh, on the terminal and the desktop', async ($, on) => {
  fakeDevice(on, { devices: [EMULATOR] })
  const terminal = await $.ui.mount({ ...mirrorPane(), surface: 'terminal' })
  expect(await terminal.find({ type: 'Text', text: /Waiting for the first screenshot/ })).toBeDefined()
  await terminal.press({ key: 'refresh' })
  expect(await terminal.find({ type: 'Image' })).toBeDefined()
  expect(await terminal.find({ type: 'Text', text: /emulator-5554 · 1080×2400/ })).toBeDefined()
  await terminal.unmount()

  const desktop = await $.ui.mount({ ...mirrorPane(), surface: 'desktop' })
  expect(await desktop.find({ type: 'Svg' })).toBeDefined()
  await desktop.unmount()
})

test('with several devices the mirror offers a pick, and shows the one picked', async ($, on) => {
  fakeDevice(on, { devices: [EMULATOR, PHONE] })
  const ui = await $.ui.mount({ ...mirrorPane(), surface: 'desktop' })
  await ui.press({ key: 'refresh' })
  expect(await ui.find({ key: 'pick-1', text: '1A2B3C4D' })).toBeDefined()
  await ui.press({ key: 'pick-1' })
  expect(await ui.find({ type: 'Text', text: /^1A2B3C4D · 1080×2400/ })).toBeDefined()
  expect(await ui.find({ key: 'pick-1' })).toBeUndefined()
  await ui.unmount()
})
