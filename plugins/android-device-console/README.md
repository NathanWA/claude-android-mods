# android-device-console

A Claude Code mod that puts the attached Android device's live state in front of you and the model.

- **Band above the prompt** (terminal and desktop): six toggles with labels that show the live state. They are Dark, Font scale (1 → 1.15 → 1.3 → 2), Density (physical → ×1.15 → ×1.3 → ×0.85), forced RTL, layout bounds, and animations. Hotkeys 1–6 work once the band has focus. The band appears after the first successful device read.
- **`/device` pane**:
  - the same toggles, plus **Reset all**
  - a target picker when several devices are connected
  - Doze controls (**Force idle**, **Unforce**) and the app standby bucket
  - the app's scheduled JobScheduler/WorkManager jobs, each with a **Run** button and the constraints it is still waiting on

  `/device reset` restores the defaults and takes the device out of forced idle.
- **System prompt section** (`android-device-console:device`): says which device is targeted and its dark mode, font scale, density, RTL, layout-bounds, animation, Doze and standby state. The model then knows a screenshot was taken under, say, dark mode at font 1.3.
- **Model tools**:
  - `set_device_state`: dark, fontScale, density or `"reset"`, rtl, layoutBounds, animations, and restartApp.
  - `run_worker`: force-runs a job with `cmd jobscheduler run -f`, adding `-n <namespace>` for a job in a JobScheduler namespace. On API 34+ WorkManager 2.9+ schedules its jobs in `androidx.work.systemjobscheduler`. Give it a jobId, a workSpecId, or nothing when the app has exactly one job. WorkManager gives the work a new job id each time it is enqueued; when the id it was given is gone, `run_worker` lists the jobs again and runs the one that took its place, or asks when several could have.
  - `set_doze`: state `idle`/`off` and/or a standby bucket.
- **Command fixer**: when the model hand-types `cmd jobscheduler run` through Bash, the mod rewrites the command before it runs. It adds a missing `-f`, the package, the job id when exactly one job is known, and `-n <namespace>` when the console knows the job's namespace. It also puts the package before the id. When the device answers "Could not find job" to a run without `-n`, the model gets a note about WorkManager's namespace. Only a command that `adb shell` runs is touched; the same words in a script, a `grep` or a file being written are left alone. It refuses the command, listing the job ids, when it can't tell which job was meant. The model gets a note about each rewrite. The mod never hooks Gradle commands.

## Target device

The mod picks the target in this order:

1. `ANDROID_SERIAL`
2. the device you chose in `/device`
3. the only ready device

If several devices are connected and none was chosen, the tools refuse and ask you to pick one. They never guess. Every adb call passes `-s <serial>`.

## The app

The application id comes from the plugin option `package`. If that is empty, the mod reads `applicationId` from `app/build.gradle.kts` or `app/build.gradle`. You can also pass `package` to any tool.

## Desktop app: permission prompts

The mod runs adb through `$.process` when the host provides it. `$.process` is documented as CLI-only, so the mod checks for it at session start. If it is missing, every adb call goes through the **Bash tool**, and each call raises a permission prompt. Button presses pass `consent` so the prompt names what you pressed.

To stop the prompts, add this to the `permissions.allow` list in `~/.claude/settings.json`:

```json
"Bash(adb *)"
```

When the mod has to use the Bash tool, it never polls: state is re-read only on `/device`, **Refresh**, or after an action. With `$.process`, it re-reads the state every `pollSeconds` (15 by default; 0 turns polling off).

## Caveats

- `dumpsys` output differs between API levels. The parsers read defensively and show `?` for anything they can't tell.
- Forced RTL on API 33+ gives the app a per-app RTL locale (`cmd locale set-app-locales <pkg> --locales he`), so it needs the app's package. The app's activities recreate right-to-left at once; the system UI stays left-to-right. Hebrew is used because an app without `pseudoLocalesEnabled` drops the `ar-XB` pseudo-locale from its resources and stays left-to-right. Text stays in the default language unless the app ships Hebrew strings. RTL off, or `/device reset`, puts back the locales the app had before.
- Below API 33, or without the package, forced RTL falls back to `debug.force_rtl`. Current Android applies that setting only after a configuration change or a reboot, so the tool says when it used this fallback. Pass `restartApp: true` to relaunch the app.
- Layout bounds are set with `setprop debug.layout` plus `service call activity 1599295570`. The second command can fail silently on some images.
- Force idle also runs `dumpsys battery unplug`. **Unforce** or `/device reset` runs `dumpsys battery reset`.
- FCM testing is not part of this mod.

## Development

```bash
claude plugin validate .
```

```bash
claude plugin test .
```
