export type MirrorFrame = {
  serial: string
  /** Full-size PNG on disk, drawn by terminals that show images. */
  file: string
  generation: number
  width: number
  height: number
  /** Downscaled JPEG, base64, for surfaces that draw it through an SVG. */
  jpeg: string | null
  takenAt: number
}

declare module 'claude-code' {
  interface PluginState {
    'android-screen': {
      mirror: MirrorFrame | null
      mirrorStatus: string
      /** The device the mirror pane shows when several are connected and none is set. */
      mirrorSerial: string | null
      /** Ready serials to pick from when the mirror's target is ambiguous; empty otherwise. */
      mirrorChoices: string[]
    }
  }
}
