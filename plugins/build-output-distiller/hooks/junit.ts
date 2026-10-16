// Reads the JUnit XML Gradle writes under build/test-results/<task>/TEST-*.xml.

export type TestFailure = {
  className: string
  name: string
  message: string
  trace: string[]
  /** The test's own frame: `LoginViewModelTest.kt` and its line. */
  file?: string
  line?: number
}

export type SuiteCounts = {
  tests: number
  failed: number
  skipped: number
  failures: TestFailure[]
}

const SUITE = /<testsuite\b([^>]*)>/g
const CASE = /<testcase\b([^>]*?)(?:\/>|>([\s\S]*?)<\/testcase>)/g
const PROBLEM = /<(failure|error)\b([^>]*?)(?:\/>|>([\s\S]*?)<\/(?:failure|error)>)/
// Kotlin test names may hold spaces: `FooTest$emits error on bad input$1.invokeSuspend`.
const FRAME = /^at (.+?)\.([^.(]+)\(([\w$.-]+\.(?:kt|java)):(\d+)\)/

export function parseJUnit(xml: string): SuiteCounts {
  const counts: SuiteCounts = { tests: 0, failed: 0, skipped: 0, failures: [] }
  for (const suite of xml.matchAll(SUITE)) {
    const attrs = suite[1] ?? ''
    counts.tests += Number(attr(attrs, 'tests') ?? 0)
    counts.failed += Number(attr(attrs, 'failures') ?? 0) + Number(attr(attrs, 'errors') ?? 0)
    counts.skipped += Number(attr(attrs, 'skipped') ?? 0)
  }
  for (const testCase of xml.matchAll(CASE)) {
    const problem = PROBLEM.exec(testCase[2] ?? '')
    if (problem === null) continue
    const caseAttrs = testCase[1] ?? ''
    const className = decode(attr(caseAttrs, 'classname') ?? '')
    const body = decode(stripCdata(problem[3] ?? ''))
    const trace = body.split('\n').map(line => line.trim()).filter(Boolean)
    const message = decode(attr(problem[2] ?? '', 'message') ?? '') || trace[0] || problem[1] || 'failed'
    counts.failures.push({
      className,
      name: decode(attr(caseAttrs, 'name') ?? ''),
      message: (message.split('\n')[0] ?? '').slice(0, 300),
      trace: trace.slice(0, 12),
      ...ownFrame(className, trace),
    })
  }
  return counts
}

/** The first frame in the test class itself (or one of its lambdas). */
function ownFrame(className: string, trace: string[]): { file?: string; line?: number } {
  const simple = className.split('.').pop() ?? className
  let fallback: { file?: string; line?: number } = {}
  for (const line of trace) {
    const frame = FRAME.exec(line)
    if (frame === null) continue
    const frameClass = frame[1] ?? ''
    const found = { file: frame[3], line: Number(frame[4]) }
    if (frameClass === className || frameClass.startsWith(`${className}$`)) return found
    if (fallback.file === undefined && frame[3]?.startsWith(`${simple}.`)) fallback = found
  }
  return fallback
}

function attr(attrs: string, name: string): string | undefined {
  return new RegExp(`\\b${name}="([^"]*)"`).exec(attrs)?.[1]
}

function stripCdata(text: string): string {
  return text.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
}

function decode(text: string): string {
  return text
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code: string) => String.fromCodePoint(parseInt(code, 16)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
}
