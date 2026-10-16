// Reads a Bash command line for a Gradle run: which tasks it asks for, where
// it runs, and whether its output is the answer the model wanted.

export type GradleCommand = {
  /** The task names asked for (`:app:assembleDebug`, `test`). */
  tasks: string[]
  flags: string[]
  /** A leading `cd <dir> &&`, then `-p <dir>`, joined; undefined for none. */
  workDir?: string
  /** True when the output is the answer (`dependencies`, `--version`) or
   * the run never ends (`--continuous`): leave the call untouched. */
  isPassthrough: boolean
  /** The command to run: the original, `--console=plain` appended when the
   * Gradle call ends the line and that cannot change what a rule matches. */
  rewritten: string
}

const GRADLE_BINARIES = new Set(['gradlew', 'gradlew.bat', 'gradle', 'gradle.bat'])
const WRAPPERS = new Set(['time', 'nohup', 'exec', 'command', 'env', 'sh', 'bash', 'zsh', 'caffeinate'])

/** Tasks whose printed output is what the model asked for. */
const ANSWER_TASKS = new Set([
  'dependencies',
  'dependencyInsight',
  'tasks',
  'signingReport',
  'properties',
  'help',
  'projects',
  'buildEnvironment',
  'outgoingVariants',
  'resolvableConfigurations',
  'javaToolchains',
  'androidDependencies',
  'sourceSets',
  'components',
  'model',
  'wrapper',
  'init',
])
const ANSWER_FLAGS = new Set(['--version', '-v', '--help', '-h', '-?', '--status', '--stop', '--dry-run', '-m'])
const ENDLESS_FLAGS = new Set(['--continuous', '-t'])

/** Options whose value is the next word, not a task. */
const VALUED_OPTIONS = new Set([
  '-p',
  '--project-dir',
  '-x',
  '--exclude-task',
  '--tests',
  '-I',
  '--init-script',
  '-c',
  '--settings-file',
  '-g',
  '--gradle-user-home',
  '--console',
  '--warning-mode',
  '--priority',
  '--include-build',
  '--configuration',
  '--dependency',
  '--task',
  '--max-workers',
])

const SEPARATOR = /\s*(?:&&|\|\||;|\||\n)\s*/

/** The Gradle call in a command line, or undefined when it runs none. */
export function analyzeCommand(command: string): GradleCommand | undefined {
  const segments = command.split(SEPARATOR).map(s => s.trim()).filter(Boolean)
  const index = segments.findIndex(segment => gradleWords(segment) !== undefined)
  if (index === -1) return undefined
  const segment = segments[index] ?? ''
  const words = gradleWords(segment) ?? []

  const tasks: string[] = []
  const flags: string[] = []
  let projectDir: string | undefined
  for (let i = 0; i < words.length; i++) {
    const word = words[i] ?? ''
    if (word.startsWith('-')) {
      flags.push(word)
      if (VALUED_OPTIONS.has(word)) {
        const value = words[i + 1]
        if (word === '-p' || word === '--project-dir') projectDir = value
        i++
      } else if (word.startsWith('--project-dir=')) {
        projectDir = word.slice('--project-dir='.length)
      }
    } else if (!/^\d*[<>]/.test(word) && !word.startsWith('&')) {
      tasks.push(word)
    }
  }

  const cdDirs = segments
    .slice(0, index)
    .map(s => /^cd\s+(\S+)$/.exec(s)?.[1])
    .filter((dir): dir is string => dir !== undefined)
  const workDir = [...cdDirs, ...(projectDir ? [projectDir] : [])].join('/') || undefined

  const isPassthrough =
    tasks.length === 0 ||
    tasks.some(task => ANSWER_TASKS.has(taskName(task))) ||
    flags.some(flag => ANSWER_FLAGS.has(flag) || ENDLESS_FLAGS.has(flag))

  const isLast = index === segments.length - 1
  const isRedirected = /(^|\s)\d*[<>]|&>|#/.test(segment)
  const isBackgrounded = /&\s*$/.test(command) && !/&&\s*$/.test(command)
  const hasConsoleFlag = flags.some(flag => flag === '--console' || flag.startsWith('--console='))
  const rewritten =
    isLast && !isRedirected && !isBackgrounded && !hasConsoleFlag
      ? `${command.trimEnd()} --console=plain`
      : command

  return { tasks, flags, workDir, isPassthrough, rewritten }
}

/** `:feature:home:testDebugUnitTest` -> `testDebugUnitTest`. */
export function taskName(task: string): string {
  return task.slice(task.lastIndexOf(':') + 1)
}

/** `:feature:home:testDebugUnitTest` -> `feature/home`; `test` -> undefined. */
export function taskModuleDir(task: string): string | undefined {
  const at = task.lastIndexOf(':')
  if (at === -1) return undefined
  return task
    .slice(0, at)
    .split(':')
    .filter(Boolean)
    .join('/')
}

const NOT_A_TEST_RUN =
  /^(assemble|package|bundle|compile|process|merge|generate|pre|install|uninstall|ksp|kapt|lint|copy|extract|map|write|validate|javaPreCompile|dexBuilder|desugar|strip|create|parse|sign|check\w)/

/** True for a task that runs tests: `test`, `testDebugUnitTest`, `jvmTest`,
 * `connectedDebugAndroidTest`, `allTests`; false for `compileDebugUnitTestKotlin`. */
export function isTestTask(task: string): boolean {
  const name = taskName(task)
  return /(^test|Tests?$)/.test(name) && !NOT_A_TEST_RUN.test(name) && name !== 'testClasses'
}

/** True for a task whose run includes tests (`check`, `build`). */
export function runsTests(task: string): boolean {
  const name = taskName(task)
  return isTestTask(task) || name === 'check' || name === 'build'
}

function gradleWords(segment: string): string[] | undefined {
  const words = segment.split(/\s+/).filter(Boolean)
  let i = 0
  while (i < words.length) {
    const word = words[i] ?? ''
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(word) || WRAPPERS.has(word)) i++
    else break
  }
  const binary = words[i]
  if (binary === undefined) return undefined
  const base = binary.replace(/^["']|["']$/g, '').split('/').pop() ?? ''
  return GRADLE_BINARIES.has(base) ? words.slice(i + 1) : undefined
}
