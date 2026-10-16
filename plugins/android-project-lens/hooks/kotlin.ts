// Small helpers for reading Kotlin source without a parser.

/**
 * Blanks comments and string contents with spaces, keeping every newline and
 * offset, so structural regexes do not match inside them and line numbers and
 * slices of the original still line up.
 */
export function blankCommentsAndStrings(src: string): string {
  const out = src.split('')
  const blank = (from: number, to: number) => {
    for (let i = from; i < to && i < out.length; i++) {
      if (out[i] !== '\n') out[i] = ' '
    }
  }
  let i = 0
  while (i < src.length) {
    const c = src[i]
    const d = src[i + 1]
    if (c === '/' && d === '/') {
      const end = src.indexOf('\n', i)
      const stop = end === -1 ? src.length : end
      blank(i, stop)
      i = stop
    } else if (c === '/' && d === '*') {
      const end = src.indexOf('*/', i + 2)
      const stop = end === -1 ? src.length : end + 2
      blank(i, stop)
      i = stop
    } else if (c === '"' && src.startsWith('"""', i)) {
      const end = src.indexOf('"""', i + 3)
      const stop = end === -1 ? src.length : end + 3
      blank(i + 3, stop - 3)
      i = stop
    } else if (c === '"') {
      let j = i + 1
      while (j < src.length && src[j] !== '"' && src[j] !== '\n') j += src[j] === '\\' ? 2 : 1
      blank(i + 1, j)
      i = j + 1
    } else if (c === "'") {
      let j = i + 1
      while (j < src.length && src[j] !== "'" && src[j] !== '\n' && j - i < 12) j += src[j] === '\\' ? 2 : 1
      blank(i + 1, j)
      i = j + 1
    } else {
      i++
    }
  }
  return out.join('')
}

/** The offsets at which each line starts, for offset-to-line lookups. */
export function lineStarts(src: string): number[] {
  const starts = [0]
  for (let i = 0; i < src.length; i++) if (src[i] === '\n') starts.push(i + 1)
  return starts
}

/** The 1-based line holding `offset`. */
export function lineAt(starts: readonly number[], offset: number): number {
  let lo = 0
  let hi = starts.length - 1
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if ((starts[mid] ?? 0) <= offset) lo = mid
    else hi = mid - 1
  }
  return lo + 1
}

/** The index just past the bracket that closes the one at `open`, or -1. */
export function closeOf(text: string, open: number): number {
  const pairs: Record<string, string> = { '(': ')', '<': '>', '[': ']', '{': '}' }
  const stack: string[] = []
  for (let i = open; i < text.length; i++) {
    const c = text[i] as string
    if (c in pairs) {
      // `->` and comparison `<` inside default values are not brackets.
      if (c === '<' && stack.length > 0 && stack[stack.length - 1] !== '>' && text[i + 1] === '=') continue
      stack.push(pairs[c] as string)
    } else if (c === stack[stack.length - 1]) {
      if (c === '>' && text[i - 1] === '-') continue
      stack.pop()
      if (stack.length === 0) return i + 1
    }
  }
  return -1
}

/** Splits `text` at commas that sit outside every bracket. */
export function splitTopLevel(text: string): string[] {
  const parts: string[] = []
  let depth = 0
  let from = 0
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (c === '(' || c === '[' || c === '{' || c === '<') depth++
    else if (c === ')' || c === ']' || c === '}' || (c === '>' && text[i - 1] !== '-')) depth = Math.max(0, depth - 1)
    else if (c === ',' && depth === 0) {
      parts.push(text.slice(from, i))
      from = i + 1
    }
  }
  parts.push(text.slice(from))
  return parts.map(p => p.trim()).filter(p => p.length > 0)
}
