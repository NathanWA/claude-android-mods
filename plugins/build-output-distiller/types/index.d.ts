export type BuildErrorKind =
  | 'kotlin'
  | 'java'
  | 'ksp'
  | 'dagger'
  | 'room'
  | 'aapt'
  | 'r8'
  | 'manifest'
  | 'lint'
  | 'test'
  | 'gradle'

export type BuildError = {
  kind: BuildErrorKind
  /** As the output named it: absolute, or relative to the session's directory. */
  file?: string
  line?: number
  column?: number
  message: string
  /** Indented lines that followed it (a Dagger trace, a test's stack). */
  detail?: string[]
}

/** The last failed Gradle run, kept to notice the same failure coming back. */
export type LastFailure = {
  hash: string
  task: string
  firstError: string
  repeats: number
}

/** What the /build pane draws. */
export type LastBuild = {
  command: string
  headline: string
  isFailed: boolean
  errors: BuildError[]
  at: number
}

declare module 'claude-code' {
  interface PluginState {
    'build-output-distiller': {
      lastFailure: LastFailure | null
      lastBuild: LastBuild | null
    }
  }
}
