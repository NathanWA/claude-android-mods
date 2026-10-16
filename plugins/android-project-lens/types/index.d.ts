/** One argument of a route's primary constructor. */
export type LensRouteArg = { name: string; type: string; default?: string }

/** A `@Serializable` route class or object found in the sources. */
export type LensRoute = {
  /** Simple name (`Detail`). */
  name: string
  /** Name qualified by its enclosing declarations (`Route.Detail`). */
  qualified: string
  kind: 'object' | 'class'
  args: LensRouteArg[]
  file: string
  line: number
}

/** A place that registers a route with a nav host. */
export type LensRegistration = {
  /** The type argument as written (`Route.Detail`). */
  target: string
  /** `composable`, `dialog`, `navigation` (Navigation 2) or `entry` (Navigation 3). */
  kind: string
  file: string
  line: number
}

/** Routes and registrations of one source file. */
export type LensNavFile = { routes: LensRoute[]; registrations: LensRegistration[] }

/** The whole route index, by project-relative path. */
export type LensNavIndex = { files: Record<string, LensNavFile>; indexedAt: number }

/** One composable from a Compose compiler report that has unstable parameters. */
export type LensComposable = {
  name: string
  module: string
  unstable: { name: string; type: string }[]
}

/** What the Compose compiler reports said, merged across runs. */
export type LensStability = {
  composables: Record<string, LensComposable>
  unstableClasses: Record<string, string>
  /** report file path -> mtimeMs at its last parse */
  parsed: Record<string, number>
  /** mtimeMs of the module index the init script wrote, at the last read */
  indexMtime: number
}

/** One permission and where it comes from. */
export type LensPermission = { name: string; origin: string }

/** Manifest facts for the system prompt. */
export type LensManifest = {
  targetSdk?: string
  targetSdkFrom?: string
  minSdk?: string
  minSdkFrom?: string
  /** Declared in an application module's own source manifests. */
  app: LensPermission[]
  /** Declared in other project modules' source manifests. */
  modules: LensPermission[]
  /** Present only in the merged manifest: brought in by libraries. */
  libraries: LensPermission[]
  /** Removed with tools:node="remove" in a source manifest. */
  removed: string[]
  merged?: { path: string; mtimeMs: number }
}

declare module 'claude-code' {
  interface PluginState {
    'android-project-lens': {
      root: string
      nav: LensNavIndex
      /** .kt files edited since the index last read them */
      dirtyKt: string[]
      /** unregistered routes already reported, so a turn reports only new ones */
      reportedUnregistered: string[]
      stability: LensStability
      manifest: LensManifest | null
    }
  }
}
