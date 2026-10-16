import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { LensManifest, LensNavIndex, LensStability } from '../types'

import { addedPermissions, describeManifest, playDeclaration } from './manifest'
import { describeGraph, routeKey, unregisteredRoutes } from './nav'
import { absolute, gatherManifest, indexNav, join, loadStability, refreshNav, relative, reportIndexPath, scanProject } from './project'
import type { Project } from './project'
import { EMPTY_STABILITY, describeStability, factsForEdit } from './stability'

const PLUGIN = 'android-project-lens'

const rootA = atom({ plugin: 'android-project-lens', key: 'root' } as const, '')
const navA = atom({ plugin: 'android-project-lens', key: 'nav' } as const, { files: {}, indexedAt: 0 } as LensNavIndex)
const dirtyA = atom({ plugin: 'android-project-lens', key: 'dirtyKt' } as const, [] as string[])
const reportedA = atom({ plugin: 'android-project-lens', key: 'reportedUnregistered' } as const, [] as string[])
const stabilityA = atom({ plugin: 'android-project-lens', key: 'stability' } as const, EMPTY_STABILITY as LensStability)
const manifestA = atom({ plugin: 'android-project-lens', key: 'manifest' } as const, null as LensManifest | null)

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`
}

// The walk's result, for re-reading manifests; session.start runs again on a reload.
let project: Project | null = null

/** The route index with every .kt file edited since the last read parsed again. */
async function freshNav($: EngineInterface): Promise<LensNavIndex> {
  const root = await read($, rootA)
  const dirty = await read($, dirtyA)
  const nav = await read($, navA)
  if (dirty.length === 0) return nav
  const next = await refreshNav($, root, nav, dirty, await $.clock.now())
  await update($, navA, () => next)
  await update($, dirtyA, list => list.filter(p => !dirty.includes(p)))
  return next
}

async function refreshManifest($: EngineInterface): Promise<void> {
  const root = await read($, rootA)
  if (root.length === 0) return
  project = project ?? (await scanProject($, root))
  const facts = await gatherManifest($, project)
  await update($, manifestA, () => facts)
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    const root = e.cwd
    const settings = await Promise.all(
      ['settings.gradle.kts', 'settings.gradle'].map(n => $.fs.exists(join(root, n)).catch(() => false)),
    )
    if (!settings.some(Boolean)) return started

    await update($, rootA, () => root)
    try {
      await $.tool.register({
        name: 'nav_graph',
        description:
          "This Android project's navigation routes, read from the source: every @Serializable route type, its constructor arguments, " +
          'where it is declared and where a nav host registers it (Navigation 2 composable<X>/dialog<X>/navigation<X>, Navigation 3 entry<X>). ' +
          'Use it instead of grepping for routes. Pass `route` (any part of a route name) for one route; leave it out for the whole graph, ' +
          'which also flags routes no nav host registers.',
        inputSchema: {
          type: 'object',
          properties: { route: { type: 'string', description: 'Part of a route name, such as "Detail" or "Route.Settings".' } },
        },
        isDeferred: false,
      })
    } catch (err) {
      $.ui.log(`${PLUGIN}: nav_graph tool not registered: ${String(err)}`, { to: 'debug' })
    }
    try {
      await $.command.register({
        name: 'stability',
        description: 'Compile once with Compose compiler reports and list composables with unstable parameters',
        argumentHint: '[gradle task, default compileDebugKotlin | read]',
      })
    } catch (err) {
      $.ui.log(`${PLUGIN}: /stability not registered: ${String(err)}`, { to: 'debug' })
    }

    const now = await $.clock.now()
    project = await scanProject($, root)
    const nav = await indexNav($, project, now)
    await update($, navA, () => nav)
    await update($, dirtyA, () => [])
    // Routes already unregistered are the baseline: a turn reports only new ones.
    await update($, reportedA, () => unregisteredRoutes(nav).map(routeKey))
    const facts = await gatherManifest($, project)
    await update($, manifestA, () => facts)
    const { table } = await loadStability($, root, await read($, stabilityA))
    await update($, stabilityA, () => table)
    return started
  })

  // ---- Nav --------------------------------------------------------------

  on('tool.call', { tool: 'mcp__android-project-lens__nav_graph' }, async ($, e) => {
    const nav = await freshNav($)
    const route = typeof e['route'] === 'string' && e['route'].length > 0 ? e['route'] : undefined
    return { result: describeGraph(nav, route) }
  }).catch(() => ({ result: `${PLUGIN}: the route index could not be read this time; search the sources for @Serializable routes instead.` }))

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    if (e.agentId !== undefined) return done
    const root = await read($, rootA)
    if (root.length === 0) return done

    const nav = await freshNav($)
    const unregistered = unregisteredRoutes(nav)
    const before = await read($, reportedA)
    const fresh = unregistered.filter(r => !before.includes(routeKey(r)))
    await update($, reportedA, () => unregistered.map(routeKey))
    await refreshManifest($)

    if (fresh.length > 0) {
      const text =
        `${PLUGIN}: ${fresh.length === 1 ? 'a route is' : `${fresh.length} routes are`} declared but no nav host registers ` +
        `${fresh.length === 1 ? 'it' : 'them'} (no composable<X>, dialog<X>, navigation<X> or entry<X>): ` +
        `${fresh.map(r => `${r.qualified} (${r.file}:${r.line})`).join(', ')}. Navigating to an unregistered route crashes at runtime.`
      $.ui.log(text)
      try {
        await $.session.append({ message: { type: 'user', content: [{ type: 'text', text }] } })
      } catch {
        // the log line above still tells the person
      }
    }
    return done
  })

  // ---- Edits of Kotlin files: nav refresh and stability facts ------------

  on('tool.call', { tool: ['Edit', 'Write'], file_path: /\.kt$/ }, async ($, e, next) => {
    const ran = await next(e)
    if (ran.deny !== undefined || ran.isError === true) return ran
    const root = await read($, rootA)
    if (root.length === 0) return ran

    const path = relative(root, absolute(root, e.file_path))
    await update($, dirtyA, list => (list.includes(path) ? list : [...list, path]))

    let table = await read($, stabilityA)
    try {
      const st = await $.fs.stat(reportIndexPath(root))
      if (st.mtimeMs !== table.indexMtime) {
        table = (await loadStability($, root, table)).table
        await update($, stabilityA, () => table)
      }
    } catch {
      // no /stability run in this project yet
    }
    const facts = factsForEdit(table, e.tool === 'Edit' ? e.new_string : e.content)
    if (facts.length === 0) return ran
    return { ...ran, context: [...(ran.context ?? []), ...facts] }
  }).catch(($, e, next) => next(e))

  // ---- Stability --------------------------------------------------------

  on('command.run', { command: 'stability' }, async ($, e) => {
    const root = await read($, rootA)
    if (root.length === 0) return { text: 'android-project-lens: this session is not in a Gradle project.' }
    const args = e.args.trim()
    const notes: string[] = []

    if (args !== 'read') {
      const tasks = args.length > 0 ? args : 'compileDebugKotlin'
      if (!/^[\w:.\- ]+$/.test(tasks)) return { text: `Not a Gradle task list: ${tasks}` }
      const init = `${$.plugin.root}/gradle/compose-reports.init.gradle`
      const command =
        `cd ${shellQuote(root)} && ./gradlew ${tasks} --init-script ${shellQuote(init)} ` +
        '-Pkotlin.incremental=false -Pkotlin.incremental.multiplatform=false --no-configuration-cache --console=plain'
      let ran
      try {
        ran = await $.tool.call({ tool: 'Bash', command, description: 'Compile with Compose compiler reports (/stability)', timeout: 600_000 })
      } catch (err) {
        ran = { deny: String(err) }
      }
      if (ran.deny !== undefined) {
        return { text: `The build did not run (${ran.deny}). Run it yourself, then /stability read:\n${command}` }
      }
      if (ran.isError === true) notes.push('The build reported an error; the reports cover what compiled.')
    }

    const { table, reportFiles } = await loadStability($, root, await read($, stabilityA))
    await update($, stabilityA, () => table)
    if (reportFiles === 0) {
      return {
        text:
          'No Compose compiler reports found. /stability needs the Kotlin Compose compiler Gradle plugin (Kotlin 2.0+) ' +
          'and a task that compiles Compose code; pass one, such as `/stability :app:compileDebugKotlin` or `compileDebugKotlinAndroid` for KMP.',
      }
    }
    return { text: [...notes, describeStability(table)].join('\n') }
  })

  // ---- Manifest ---------------------------------------------------------

  on('prompt.compose', async ($, e, next) => {
    const composed = await next(e)
    const facts = await read($, manifestA)
    if (facts === null) return composed
    return {
      sections: [...composed.sections, { id: `${PLUGIN}:manifest`, text: describeManifest(facts), scope: 'session' as const }],
    }
  })

  // Judged before next: a deny after the edit ran would undo nothing.
  on('tool.call', { tool: ['Edit', 'Write'], file_path: /(^|\/)AndroidManifest\.xml$/ }, async ($, e, next) => {
    let before = ''
    let after: string
    if (e.tool === 'Write') {
      before = await $.fs.read(e.file_path).then(t => (typeof t === 'string' ? t : ''), () => '')
      after = e.content
    } else {
      const text = await $.fs.read(e.file_path).then(t => (typeof t === 'string' ? t : null), () => null)
      if (text === null || !text.includes(e.old_string)) return next(e) // the Edit fails on its own
      before = text
      after = e.replace_all === true ? text.split(e.old_string).join(e.new_string) : text.replace(e.old_string, () => e.new_string)
    }

    const needsDeclaration = addedPermissions(before, after).filter(p => playDeclaration(p) !== undefined)
    if (needsDeclaration.length > 0) {
      const names = needsDeclaration.map(p => p.replace(/^android\.permission\./, ''))
      const why = needsDeclaration.map(p => `${p.replace(/^android\.permission\./, '')}: ${playDeclaration(p)}`).join('; ')
      let answer: string
      try {
        answer = await $.ui.ask(
          `This edit adds ${names.join(', ')} to ${relative(await read($, rootA), e.file_path)}. Google Play needs a Play Console declaration for ${names.length === 1 ? 'it' : 'them'} (${why}). Add ${names.length === 1 ? 'it' : 'them'}?`,
          { options: ['Add it', 'Leave it out'], header: 'Permission' },
        )
      } catch {
        return { deny: `${PLUGIN}: adding ${names.join(', ')} needs a Play Console declaration and the question was dismissed; ask the person before adding it.` }
      }
      if (answer !== 'Add it') {
        return {
          deny: `${PLUGIN}: the person chose not to add ${names.join(', ')} (answer: ${answer}). Find an approach that does not need ${names.length === 1 ? 'it' : 'them'}.`,
        }
      }
    }

    const ran = await next(e)
    if (ran.deny === undefined && ran.isError !== true) await refreshManifest($)
    return ran
  }).catch(($, e, next) =>
    next.called ? next(e) : { deny: `${PLUGIN}: its manifest permission check failed, so this manifest edit was held back. Try again, or edit it by hand.` },
  )
}
