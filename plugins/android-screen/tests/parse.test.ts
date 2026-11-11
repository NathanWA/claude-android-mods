import { describe, expect, test } from 'claude-code/testing'

import {
  compactUiTree,
  inputText,
  parseApplicationId,
  parseDevices,
  parseSipsSize,
  pickPackage,
  pickTarget,
  shellLine,
} from '../hooks/parse'

const EMULATOR = { serial: 'emulator-5554', state: 'device', model: 'sdk gphone64 arm64' }
const PHONE = { serial: '1A2B3C4D', state: 'device', model: 'Pixel 8' }

describe('devices', () => {
  test('parses adb devices -l', async () => {
    const listed = parseDevices(
      [
        'List of devices attached',
        'emulator-5554          device product:sdk_gphone64_arm64 model:sdk_gphone64_arm64 device:emu64a transport_id:1',
        '1A2B3C4D               unauthorized usb:1-1 transport_id:2',
        '',
      ].join('\n'),
    )
    expect(listed).toEqual([EMULATOR, { serial: '1A2B3C4D', state: 'unauthorized', model: null }])
  })

  test('targets an explicit serial, then ANDROID_SERIAL, then the only ready device', async () => {
    expect(pickTarget([EMULATOR, PHONE], 'given', 'env')).toEqual({ serial: 'given' })
    expect(pickTarget([EMULATOR, PHONE], undefined, 'env')).toEqual({ serial: 'env' })
    expect(pickTarget([EMULATOR, { ...PHONE, state: 'offline' }], undefined, undefined)).toEqual({ serial: 'emulator-5554' })
  })

  test('never guesses between several devices', async () => {
    expect(pickTarget([EMULATOR, PHONE], undefined, undefined)).toEqual({
      error: '2 devices are connected (emulator-5554 sdk gphone64 arm64, 1A2B3C4D Pixel 8). Pass serial, or set ANDROID_SERIAL.',
    })
    expect(pickTarget([], undefined, undefined)).toEqual({ error: 'No device is connected (adb devices lists none).' })
    expect(pickTarget([{ ...PHONE, state: 'unauthorized' }], undefined, undefined)).toEqual({
      error: 'No device is ready: 1A2B3C4D (unauthorized).',
    })
  })
})

describe('project app', () => {
  test('reads applicationId from Kotlin and Groovy build files', async () => {
    expect(parseApplicationId('android {\n  namespace = "com.example.lib"\n  defaultConfig {\n    applicationId = "com.example.app"\n  }\n}')).toBe('com.example.app')
    expect(parseApplicationId("android { defaultConfig { applicationId 'com.example.groovy' } }")).toBe('com.example.groovy')
    expect(parseApplicationId('android { namespace = "com.example.only" }')).toBe('com.example.only')
  })

  test('picks the installed variant of the app', async () => {
    expect(pickPackage('com.example', 'package:com.example.debug\npackage:com.example.debug.test\n')).toBe('com.example.debug')
    expect(pickPackage('com.example', 'package:com.example\npackage:com.example.debug\n')).toBe('com.example')
    expect(pickPackage('com.example', '')).toBe('com.example')
  })
})

describe('shell lines', () => {
  test('quotes only the words that need it', async () => {
    expect(shellLine(['adb', '-s', 'emulator-5554', 'shell', 'input tap 1 2'])).toBe("adb -s emulator-5554 shell 'input tap 1 2'")
    expect(shellLine(['/Users/me/Library/Android/sdk/platform-tools/adb', 'version'])).toBe(
      '/Users/me/Library/Android/sdk/platform-tools/adb version',
    )
  })

  test('quotes text for input text', async () => {
    expect(inputText("it's here")).toBe("'it'\\''s%shere'")
  })

  test('reads the size sips reports', async () => {
    expect(parseSipsSize('/tmp/a.png\n  pixelWidth: 1280\n  pixelHeight: 2856\n')).toEqual({ width: 1280, height: 2856 })
    expect(parseSipsSize('')).toBe(null)
  })
})

describe('view hierarchy', () => {
  test('indents by labelled ancestors and decodes character references', async () => {
    const xml =
      '<hierarchy><node class="android.view.View" text="" resource-id="" content-desc="Card" bounds="[0,0][100,100]">' +
      '<node class="android.widget.FrameLayout" text="" resource-id="" content-desc="" bounds="[0,0][100,100]">' +
      '<node class="android.widget.TextView" text="Hi&#13;&#10;there" resource-id="" content-desc="" bounds="[0,0][100,50]"/>' +
      '</node></node></hierarchy>'
    expect(compactUiTree(xml)).toBe(['View desc="Card" @(50,50)', '  TextView "Hi  there" @(50,25)'].join('\n'))
  })

  test('leaves out nodes with no area on screen, and says how many', async () => {
    const xml =
      '<hierarchy><node class="android.webkit.WebView" text="" resource-id="" content-desc="" bounds="[0,0][1280,2856]">' +
      '<node class="android.widget.TextView" text="Chapter Two" resource-id="" content-desc="" bounds="[100,300][1180,440]"/>' +
      '<node class="android.widget.TextView" text="Chapter One" resource-id="" content-desc="" bounds="[0,0][0,0]"/>' +
      '<node class="android.view.View" text="" resource-id="" content-desc="1. Aphrodite" clickable="true" bounds="[0,0][0,0]"/>' +
      '</node></hierarchy>'
    expect(compactUiTree(xml)).toBe(
      ['TextView "Chapter Two" @(640,370)', '(2 labelled nodes with no area on screen left out)'].join('\n'),
    )
  })

  test('keeps labelled and interactive nodes with their tap points', async () => {
    const xml =
      '<?xml version="1.0"?><hierarchy rotation="0">' +
      '<node class="android.widget.FrameLayout" text="" resource-id="" content-desc="" clickable="false" enabled="true" bounds="[0,0][1080,2400]">' +
      '<node class="android.widget.Button" text="Sign in" resource-id="com.example:id/sign_in" content-desc="" clickable="true" enabled="true" bounds="[100,200][300,260]"/>' +
      '<node class="android.view.View" text="" resource-id="search_field" content-desc="Search &amp; filter" clickable="false" enabled="false" bounds="[0,300][1080,400]"/>' +
      '</node></hierarchy>'
    expect(compactUiTree(xml)).toBe(
      ['Button "Sign in" id=sign_in [clickable] @(200,230)', 'View desc="Search & filter" id=search_field [disabled] @(540,350)'].join('\n'),
    )
  })
})
