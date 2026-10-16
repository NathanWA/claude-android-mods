export type ExecMode = 'process' | 'bash'

export type Device = { serial: string; state: string; model: string | null }

export type DeviceState = {
  serial: string
  model: string | null
  api: number | null
  isDark: boolean | null
  fontScale: number | null
  density: number | null
  physicalDensity: number | null
  isRtl: boolean | null
  hasLayoutBounds: boolean | null
  hasAnimations: boolean | null
  deepIdle: string | null
  lightIdle: string | null
  bucket: string | null
  readAt: number
}

export type Job = {
  id: number
  component: string
  workSpecId: string | null
  required: string | null
  unsatisfied: string | null
}

declare module 'claude-code' {
  interface PluginState {
    'android-device-console': {
      mode: ExecMode | null
      adb: string
      probeNote: string | null
      devices: Device[]
      chosenSerial: string | null
      device: DeviceState | null
      jobs: Job[]
      pkg: string | null
      busy: string | null
      lastMessage: string | null
    }
  }
}
