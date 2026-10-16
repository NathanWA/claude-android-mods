# build-output-distiller

A Claude Code mod for Android and KMP projects. When Claude runs Gradle through Bash, the mod swaps the console output for a short digest, so a build no longer floods the context window.

## What it does

- **Keeps builds in the foreground.** Commands that run `gradlew` or `gradle` get `timeout: 600000` and `run_in_background: false`. The mod also appends `--console=plain` when the Gradle call ends the command line, but only if `$.tool.check` gives the new command the same permission verdict as the original.
- **Digests the output.** The mod reads the whole output, including the file Bash saves when output is too large, and parses:
  - Kotlin compiler errors (`e: file:///…:L:C`, plus the 1.x format)
  - javac and kapt errors
  - KSP errors
  - Hilt/Dagger errors such as `[Dagger/MissingBinding]`, with their trace
  - Room query errors
  - AAPT resource errors
  - R8 `Missing class` errors
  - Manifest merger errors
  - `file:line` errors from lint, detekt and ktlint
  - Gradle's `* Where:` and `* What went wrong:` blocks

  The model reads the digest plus two context notes: the files to open, in order, and fix hints for each kind of error found.
- **Summarizes tests.** When the run included tests, the mod reads the new `build/test-results/**/TEST-*.xml` files and summarizes them per module, with each failure's assertion message and source line. If tests failed but no new XML appeared, the raw output passes through.
- **Flags repeat failures.** The mod hashes the failing task and its first error. When the next run fails the same way, the model gets a "the last fix did not take" note and the UI shows a toast.
- **Leaves some commands alone.** Commands whose output is the answer (`dependencies`, `tasks`, `signingReport`, `properties`, `--version`, `--continuous` and similar) pass through untouched. So do small passing builds and anything the mod doesn't recognize.
- **Adds a `/build` command.** It opens a pane with one `Code` element per error. Each element shows the lines around the error.
- **Asks the model only when needed.** `$.model.classify` runs only for a failure that no pattern explains.

When Bash didn't save the full output to a file, the mod writes a copy to `build/build-output-distiller/last-run.log` under the Gradle project. The digest names this file so the model can read the full output.

## Developing

```bash
claude plugin validate .
```

```bash
claude plugin test .
```

`tsc -p .` type-checks the mod once the engine has written `.claude-plugin/types/`.
