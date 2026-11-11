import type { On } from 'claude-code'

export const EMULATOR = 'emulator-5554          device product:sdk_gphone64_arm64 model:sdk_gphone64_arm64 device:emu64a transport_id:1'
export const PHONE = '1A2B3C4D               device usb:1-1 model:Pixel_8 transport_id:2'

export const UI_DUMP =
  '<?xml version="1.0"?><hierarchy rotation="0">' +
  '<node class="android.widget.Button" text="Sign in" resource-id="com.example:id/sign_in" content-desc="" clickable="true" enabled="true" bounds="[100,200][300,260]"/>' +
  '</hierarchy>UI hierchary dumped to: /dev/tty'

export type FakeDevice = {
  /** Connected devices, as `adb devices -l` lists them. */
  devices: string[]
  /** What `$.env.get('ANDROID_SERIAL')` answers. */
  serial?: string
  /** Run commands through the Bash tool, as a host without $.process does. */
  isBashOnly?: boolean
}

/**
 * Stands in for the host and one adb: answers $.env, $.fs and $.clock, and either
 * $.process or the Bash tool, by the command line. Returns every command line run.
 */
export function fakeDevice(on: On, device: FakeDevice): string[] {
  const lines: string[] = []
  on('env.get', ($, e) => ({ value: e.name === 'ANDROID_SERIAL' ? device.serial : undefined }))
  on('fs.exists', ($, e) => ({ value: e.path === '/usr/bin/sips' }))
  on('fs.read', () => ({ value: { base64: '/9j/4AAQSkZJRg==' } }))
  on('clock.now', () => ({ value: Date.UTC(2026, 10, 11, 12) }))
  on('session.cwd', () => ({ value: '/project' }))
  on('session.surfaces', () => ({ value: ['terminal', 'desktop'] }))

  const answer = (line: string): string => {
    lines.push(line)
    if (line.includes('devices -l')) return ['List of devices attached', ...device.devices, ''].join('\n')
    if (line.includes('screencap')) return '/tmp/screen.png\n  pixelWidth: 1080\n  pixelHeight: 2400\n'
    if (line.includes('uiautomator dump /dev/tty')) return UI_DUMP
    return ''
  }

  if (device.isBashOnly) {
    on('tool.call', { tool: 'Bash' }, ($, e) => ({
      result: { stdout: answer(String(e.command)), stderr: '', interrupted: false, isImage: false },
    }))
  } else {
    on('process.run', ($, e) => {
      const argv = [...e.argv]
      const stdout = argv[1] === 'version' ? 'Android Debug Bridge version 1.0.41\n' : answer(argv[2] ?? argv.join(' '))
      return { value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    })
  }
  return lines
}
