# android-screen

A Claude Code mod that lets the model see and drive the attached Android device, and shows you its screen.

- **Model tools**:
  - `screenshot`: the device screen as an image, with its size in device pixels and the path of the full-size PNG. The image is scaled to 1280 px on its long side; the reply gives the scale so the model can turn image coordinates into taps.
  - `ui_tree`: the view hierarchy from `uiautomator`, one line per node that has text, a content description, a resource id or a state flag, with the point to tap: `Button "Sign in" id=sign_in [clickable] @(200,230)`. Compose test tags show up as ids once the app sets `Modifier.semantics { testTagsAsResourceId = true }`. It is smaller and more exact than a screenshot for finding an element.
  - `input`: `tap` at x,y, `swipe`, type `text` into the focused field, or press a `key` (BACK, HOME, ENTER, TAB, DEL, APP_SWITCH, or a keycode).
  - `app`: `launch`, `restart` (force-stop, then launch, for a freshly installed build) or `stop` the app, or `open_url` to fire a deep link or App Link through an `ACTION_VIEW` intent.
- **`/mirror` pane**: the device screen, refreshed while the pane is shown, with **Back**, **Home**, **Recents** and **Refresh** buttons. In the terminal it draws the full PNG where the terminal shows images (kitty, Ghostty). In the desktop app it draws a downscaled JPEG.
- **`/deeplink <uri> [package]`**: opens a deep link on the device.
- **`/relaunch [package]`**: force-stops and launches the app.

The mod doesn't touch logcat, device settings or Gradle; android-logcat, android-device-console and build-output-distiller cover those.

## Target device

The mod picks the target in this order:

1. the `serial` passed to a tool
2. `ANDROID_SERIAL`
3. the only ready device

If several devices are connected and none was chosen, the tools refuse and list them. They never guess. The `/mirror` pane offers a button per device instead. Every adb call passes `-s <serial>`.

## The app

The application id comes from the plugin option `package`. If that is empty, the mod reads `applicationId` from the app module's `build.gradle.kts` or `build.gradle`, then asks the device for the installed package, so a `.debug` suffix is found. You can also pass `package` to the `app` tool and to `/relaunch`.

## Desktop app: permission prompts

The mod runs adb through `$.process` when the host provides it. `$.process` is documented as CLI-only, so the mod checks for it the first time it needs adb. If it is missing, every adb call goes through the **Bash tool**, and each call raises a permission prompt. A screenshot is one command line, so it asks once.

To stop the prompts, add this to the `permissions.allow` list in `~/.claude/settings.json`:

```json
"Bash(adb *)"
```

Screenshots also run `mkdir`, `mv` and `sips` in the same command line, so a rule for those may be needed too.

When the mod has to use the Bash tool, it never polls: the mirror refreshes only when you open it, press a button, or press **Refresh**. With `$.process`, it refreshes every `mirrorIntervalMs` (1500 by default) while the pane is shown.

## Requirements

- macOS for the desktop app's mirror and for the `screenshot` tool's image: the mod shrinks screenshots with the built-in `sips`. Without it, `screenshot` returns the PNG's path for the model to read, and the desktop mirror shows that path.
- A POSIX shell (`/bin/sh`): the mod runs its adb command lines through it.

## Caveats

- `uiautomator dump` can't read a screen that is animating or shows a secure window, and some apps report few labels. The tool falls back to dumping to a file on the device when `/dev/tty` doesn't work.
- `input text` sends text through the device's shell; characters outside ASCII may not type on older system images.
- The desktop mirror is an image inside an SVG, so it is limited to about 125,000 characters of JPEG. A screenshot that doesn't fit is shrunk once more, then left out.

## Development

```bash
claude plugin validate .
```

```bash
claude plugin test .
```
