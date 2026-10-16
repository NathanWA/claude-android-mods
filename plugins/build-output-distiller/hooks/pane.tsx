// The /build command and its pane: the last Gradle run's errors, one Code
// element each, showing the lines around the error where the file is readable.

import { atom, read } from 'claude-code'
import type { EngineInterface, On } from 'claude-code'

import type { BuildError, LastBuild } from '../types'

import { resolve } from './paths'

const PANE = 'gradle-build'
const lastBuild = atom({ plugin: 'build-output-distiller', key: 'lastBuild' } as const, null as LastBuild | null)
const SHOWN = 30
const AROUND = 2

export function registerPane(on: On): void {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'build',
      description: "Show the last Gradle build's errors in a pane",
    })

    return next(e)
  })

  on('command.run', { command: 'build' }, async $ => {
    const build = await read($, lastBuild)
    const opened = await $.ui.open({ id: PANE, title: 'Gradle build' })
    const summary =
      build === null
        ? 'No Gradle build has run in this session yet.'
        : `${build.headline} — ${build.errors.length} error${build.errors.length === 1 ? '' : 's'}.`

    return { text: opened.isPlaced ? summary : `${summary} (The pane is not shown: ${opened.reason}.)` }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Code } = $.ui.resolve(e)
    const build = await read($, lastBuild)
    if (build === null) {
      return <Text dimColor>No Gradle build has run in this session yet.</Text>
    }

    const cwd = await $.session.cwd()
    const shown = build.errors.slice(0, SHOWN)
    const snippets = await Promise.all(shown.map(error => snippet($, cwd, error)))

    return (
      <Box flexDirection="column">
        <Text bold color={build.isFailed ? 'error' : 'success'}>
          {build.headline}
        </Text>
        <Text dimColor>{build.command}</Text>
        {shown.length === 0 && <Text dimColor>No errors with a location.</Text>}
        {shown.map((error, i) => (
          <Box key={`error-${i}`} flexDirection="column" marginTop={1}>
            <Text>
              <Text color="warning">{error.kind}</Text> {spot(error)}
              {error.message}
            </Text>
            <Code {...(snippets[i] ?? { source: error.message })} wrap="truncate-end" />
          </Box>
        ))}
        {build.errors.length > SHOWN && <Text dimColor>… and {build.errors.length - SHOWN} more</Text>}
      </Box>
    )
  })
}

type Snippet = { source: string; path?: string; startLine?: number }

/** The lines around the error, or its message and trace when the file is unreadable. */
async function snippet($: EngineInterface, cwd: string, error: BuildError): Promise<Snippet> {
  const fallback = { source: [error.message, ...(error.detail ?? [])].join('\n') }
  if (error.file === undefined || error.line === undefined) return fallback
  const text = await $.fs.read(resolve(cwd, error.file)).catch(() => undefined)
  if (typeof text !== 'string') return fallback
  const lines = text.split('\n')
  const from = Math.max(1, error.line - AROUND)
  const to = Math.min(lines.length, error.line + AROUND)
  if (from > to) return fallback

  return { source: lines.slice(from - 1, to).join('\n'), path: error.file, startLine: from }
}

function spot(error: BuildError): string {
  if (error.file === undefined) return ''
  return `${error.file}${error.line === undefined ? '' : `:${error.line}`} `
}
