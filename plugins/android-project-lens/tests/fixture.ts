// A small Android project in memory, served to the plugin as $.fs.

import type { On } from 'claude-code'

export const ROOT = '/proj'

export type Files = Map<string, { text: string; mtimeMs: number }>

const ROUTES = `package com.example.detail

import kotlinx.serialization.Serializable

@Serializable
sealed interface Route {
    @Serializable
    data object Home : Route

    @Serializable
    data class Detail(
        val id: String,
        val tab: Int = 0, // which tab opens first
    ) : Route
}

@Serializable
object AuthGraph

@Serializable
data object LoginRoute

/** Declared long ago and never wired up: the baseline, not reported. */
@Serializable
data object LegacyRoute

@Serializable
data class UserDto(val name: String)
`

const NAV_HOST = `package com.example.app

@Composable
fun AppNavHost(navController: NavHostController) {
    NavHost(navController, startDestination = Route.Home) {
        composable<Route.Home> { HomeScreen() }
        composable<Route.Detail> { entry ->
            val detail: Route.Detail = entry.toRoute()
            DetailScreen(detail.id)
        }
        navigation<AuthGraph>(startDestination = LoginRoute) {
            composable<LoginRoute> { LoginScreen() }
        }
    }
}
`

const NAV3 = `package com.example.settings

@Serializable
data object SettingsKey : NavKey

fun EntryProviderBuilder<NavKey>.settingsEntries() {
    entry<SettingsKey> { SettingsScreen() }
}
`

const APP_MANIFEST = `<?xml version="1.0" encoding="utf-8"?>
<manifest xmlns:android="http://schemas.android.com/apk/res/android"
    xmlns:tools="http://schemas.android.com/tools">

    <uses-permission android:name="android.permission.INTERNET" />
    <uses-permission android:name="android.permission.CAMERA" />
    <!-- <uses-permission android:name="android.permission.RECORD_AUDIO" /> -->
    <uses-permission android:name="android.permission.READ_PHONE_STATE" tools:node="remove" />

    <application android:label="Example" />
</manifest>
`

const DETAIL_MANIFEST = `<manifest xmlns:android="http://schemas.android.com/apk/res/android">
    <uses-permission android:name="android.permission.ACCESS_NETWORK_STATE"/>
</manifest>
`

const MERGED = `<?xml version="1.0" encoding="utf-8"?>
<manifest xmlns:android="http://schemas.android.com/apk/res/android" package="com.example">
    <uses-sdk android:minSdkVersion="26" android:targetSdkVersion="35" />
    <uses-permission android:name="android.permission.INTERNET" />
    <uses-permission android:name="android.permission.CAMERA" />
    <uses-permission android:name="android.permission.ACCESS_NETWORK_STATE" />
    <uses-permission android:name="android.permission.WAKE_LOCK" />
    <application android:label="Example" />
</manifest>
`

const MERGER_REPORT = `-- Merging decision tree log ---
manifest
ADDED from /proj/app/src/main/AndroidManifest.xml:2:1-12:12
uses-permission#android.permission.INTERNET
ADDED from /proj/app/src/main/AndroidManifest.xml:5:5-67
uses-permission#android.permission.WAKE_LOCK
ADDED from [androidx.work:work-runtime:2.9.0] /Users/x/.gradle/caches/transforms-4/ab/transformed/work-runtime-2.9.0/AndroidManifest.xml:25:5-68
`

export function fixtureFiles(): Files {
  const files: Files = new Map()
  const put = (path: string, text: string, mtimeMs = 1_000) => files.set(`${ROOT}/${path}`, { text, mtimeMs })
  put('settings.gradle.kts', 'include(":app", ":feature:detail", ":feature:settings")\n')
  put('gradle/libs.versions.toml', '[versions]\nkotlin = "2.1.0"\n')
  put('app/build.gradle.kts', 'plugins {\n    alias(libs.plugins.android.application)\n}\n')
  put('app/src/main/AndroidManifest.xml', APP_MANIFEST)
  put('app/src/main/kotlin/com/example/app/AppNavHost.kt', NAV_HOST)
  put('app/src/test/kotlin/com/example/app/NavTest.kt', '@Serializable data object TestOnlyRoute\n')
  put('app/build/intermediates/merged_manifest/debug/processDebugMainManifest/AndroidManifest.xml', MERGED, 5_000)
  put('app/build/outputs/logs/manifest-merger-debug-report.txt', MERGER_REPORT, 5_000)
  put('feature/detail/build.gradle.kts', 'plugins {\n    alias(libs.plugins.android.library)\n}\n')
  put('feature/detail/src/main/AndroidManifest.xml', DETAIL_MANIFEST)
  put('feature/detail/src/main/kotlin/com/example/detail/Routes.kt', ROUTES)
  put('feature/settings/build.gradle.kts', 'plugins {\n    alias(libs.plugins.android.library)\n}\n')
  put('feature/settings/src/main/kotlin/com/example/settings/SettingsEntries.kt', NAV3)
  return files
}

function missing(path: string) {
  return { deny: `ENOENT: no such file or directory, '${path}'` }
}

/**
 * Answers $.fs from `files` beneath the plugin, and the registrations and
 * log lines session.start makes.
 */
export function serveFixture(on: On, files: Files): void {
  const isDir = (path: string) => {
    const prefix = path.endsWith('/') ? path : path + '/'
    for (const k of files.keys()) if (k.startsWith(prefix)) return true
    return false
  }
  on('fs.read', ($, e) => {
    const f = files.get(e.path)
    if (f === undefined) return missing(e.path)
    return { value: f.text }
  })
  on('fs.exists', ($, e) => ({ value: files.has(e.path) || isDir(e.path) }))
  on('fs.stat', ($, e) => {
    const f = files.get(e.path)
    if (f !== undefined) return { value: { kind: 'file', size: f.text.length, mtimeMs: f.mtimeMs, isLink: false } }
    if (isDir(e.path)) return { value: { kind: 'dir', size: 0, mtimeMs: 0, isLink: false } }
    return missing(e.path)
  })
  on('fs.list', ($, e) => {
    const dir = e.path.endsWith('/') ? e.path : e.path + '/'
    if (!isDir(e.path)) return missing(e.path)
    const entries = new Map<string, { name: string; kind: 'file' | 'dir'; size: number; mtimeMs: number; isLink: boolean }>()
    for (const [k, f] of files) {
      if (!k.startsWith(dir)) continue
      const rest = k.slice(dir.length)
      const slash = rest.indexOf('/')
      const name = slash === -1 ? rest : rest.slice(0, slash)
      if (slash === -1) entries.set(name, { name, kind: 'file', size: f.text.length, mtimeMs: f.mtimeMs, isLink: false })
      else if (!entries.has(name)) entries.set(name, { name, kind: 'dir', size: 0, mtimeMs: 0, isLink: false })
    }
    return { value: [...entries.values()] }
  })
  on('tool.register', ($, e) => ({ value: { tool: `mcp__android-project-lens__${e.name}` } }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('ui.log', () => ({ value: undefined }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
}
