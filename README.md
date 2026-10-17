# claude-android-mods

Four [Claude Code](https://claude.com/claude-code) mods for Android and Kotlin Multiplatform work. A mod is a plugin of function hooks: it changes what Claude Code shows and does, by drawing a band or pane, adding tools the model can call, or rewriting the model's tool calls before they run.

| Mod | What it gives you |
| --- | --- |
| [build-output-distiller](plugins/build-output-distiller) | Gradle output becomes a short digest: Kotlin, KSP, Hilt/Dagger, Room, AAPT, R8 and test failures as `file:line` lists with fix hints. Repeat failures are flagged. `/build` opens the errors in a pane. |
| [android-logcat](plugins/android-logcat) | Bare `adb logcat` calls get a bound (`-d -t 800`, or `-t 200 --pid=<pid>`) so they can't hang. Secrets are redacted from adb output. A pid-scoped buffer feeds a `logcat_grep` tool and a `/logcat` pane. |
| [android-device-console](plugins/android-device-console) | A band of live toggles above the prompt: dark mode, font scale, density, RTL, layout bounds, animations. `/device` adds Doze, standby bucket and scheduled jobs with Run buttons. Tools: `set_device_state`, `set_doze`, `run_worker`. The system prompt states the current device state. |
| [android-project-lens](plugins/android-project-lens) | A `nav_graph` tool that indexes `@Serializable` routes and where nav hosts register them. `/stability` gives Compose stability reports on demand. The system prompt gets the real targetSdk, minSdk and permissions. Claude asks before adding Play-declaration permissions. |

The mods don't overlap: only build-output-distiller hooks Gradle commands, and only android-logcat hooks `adb logcat`.

## Requirements

- Claude Code **2.1.299 or newer**. Function-hook mods are early access, and older builds reject some of the events these mods use. Check with `claude --version`.
- The Android SDK's `adb` on your `PATH`, or `ANDROID_HOME` / `ANDROID_SDK_ROOT` set, for the three mods that talk to a device.
- An Android or KMP project as the session's working directory.

## Install

Install from a terminal session. Each mod installs on its own, so install only the ones you want.

At the Claude Code prompt:

```
/plugin install android-device-console --marketplace NathanWA/claude-android-mods
/plugin install android-logcat --marketplace NathanWA/claude-android-mods
/plugin install build-output-distiller --marketplace NathanWA/claude-android-mods
/plugin install android-project-lens --marketplace NathanWA/claude-android-mods
```

The first install asks `Add marketplace?`: answer `y`. Then choose a scope; the user scope is first and is the usual choice. The mod is active in that session right away and in every session you start after.

From a shell:

```bash
claude plugin install android-device-console --marketplace NathanWA/claude-android-mods
```

In the Claude desktop app, `/plugin` doesn't run in the Code tab. Click **+** next to the prompt box, then **Plugins**, then **Add marketplace** with `NathanWA/claude-android-mods`, then **Add plugin**. A mod you install from a terminal at user scope also loads in the desktop app's local sessions.

To update later:

```bash
claude plugin update android-device-console
```

## Run

There's nothing to start. Open Claude Code in your Android project and the mods work on their own:

- **build-output-distiller**: ask Claude to build or test (`./gradlew assembleDebug`, `testDebugUnitTest`). The model reads a digest instead of the raw log. Run `/build` to see the last build's errors in a pane.
- **android-logcat**: when Claude runs `adb logcat`, the call is bounded and redacted. The model can search the buffer with `logcat_grep`. Run `/logcat` to see the buffer.
- **android-device-console**: with a device or emulator connected, run `/device` to open the console. After the first read, the band of toggles stays above the prompt; press 1–6 once the band has focus. Ask Claude things like "screenshot the settings screen in dark mode at font scale 1.3": it calls `set_device_state` itself. `/device reset` restores the defaults.
- **android-project-lens**: ask about navigation ("which routes take an id?") and the model uses `nav_graph`. Run `/stability` to compile once with Compose compiler reports, or `/stability read` to read existing reports.

### Permission prompts in the desktop app

Several mods run `adb` through Claude Code's `$.process`, which is documented as CLI-only. Where it isn't available, as in the desktop app, they fall back to the Bash tool, and each call asks for permission. To stop the prompts, add this to `permissions.allow` in `~/.claude/settings.json`:

```json
"Bash(adb *)"
```

The mods never poll through the Bash tool. In the desktop app, device state is re-read only when you run a command, press a button, or the model calls a tool.

### Choosing a device

android-device-console picks its target in this order: `ANDROID_SERIAL`, then the device you picked in `/device`, then the only connected device. When several devices are connected and none is chosen, it asks rather than guesses.

### Options

android-device-console has two options, which you can set in `/config` or under `pluginConfigs` in settings:

- `package`: the applicationId. When empty, it is read from `app/build.gradle(.kts)`.
- `pollSeconds`: how often device state is refreshed when `$.process` works. The default is 15; 0 turns refreshing off.

## Status

These mods are early. Each passes `claude plugin validate` and its own `claude plugin test` suite, but they have had little use on real projects and devices. Known gaps:

- `dumpsys` output differs between API levels. The parsers read it defensively, but untested API levels may show `?`.
- Forced RTL uses a per-app Hebrew locale on API 33+ and needs the app's package. Below API 33 it falls back to `debug.force_rtl`, which may need a reboot. Layout bounds use a `service call` that some system images ignore.
- android-project-lens's `/stability` Gradle init script has not yet been run against every AGP and Kotlin version.

Issues and pull requests are welcome.

## Develop

Clone the repository and load a mod from disk for one session:

```bash
claude --plugin-dir plugins/android-device-console
```

Check and test a mod:

```bash
claude plugin validate plugins/android-device-console
```

```bash
claude plugin test plugins/android-device-console
```

Each mod's `tsconfig.json` extends the types Claude Code writes into `.claude-plugin/types/` when it loads the mod. After one load, `tsc -p plugins/<mod>` type-checks it.

## License

[MIT](LICENSE)
