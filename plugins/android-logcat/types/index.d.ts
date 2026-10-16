export type LogLevel = 'V' | 'D' | 'I' | 'W' | 'E' | 'F'

/** One parsed logcat line (threadtime or brief), already redacted. */
export type LogLine = {
  time: string
  pid: number
  tid: number
  level: LogLevel
  tag: string
  msg: string
}

/** The pane's filter: minimum level and a tag-or-text substring. */
export type LogcatFilter = { level: LogLevel; text: string }

/**
 * What the pane draws: only the visible window of the module's ring buffer,
 * already filtered, plus counters. The full ring stays in the module.
 */
export type LogcatView = {
  lines: LogLine[]
  total: number
  matched: number
  pkg?: string
  pid?: number
  /** `spawn` when this mod owns a live `adb logcat` child; else `observe`. */
  source: 'spawn' | 'observe'
  redactions: number
}

declare module 'claude-code' {
  interface PluginState {
    'android-logcat': {
      view: LogcatView
      filter: LogcatFilter
      /** tool_use_ids of adb Bash calls, for the session.append safety net. */
      adbCalls: string[]
    }
  }
}
