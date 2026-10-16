// POSIX path helpers: the module has no Node `path`.

export function join(...parts: string[]): string {
  const joined = parts.filter(part => part !== '').join('/')
  return normalize(joined)
}

/** `dir` resolved against `base` unless it is absolute. */
export function resolve(base: string, dir: string): string {
  return dir.startsWith('/') ? normalize(dir) : join(base, dir)
}

/** `path` relative to `base` when it lies under it, else as given. */
export function relativeTo(base: string, path: string): string {
  const root = base.endsWith('/') ? base : `${base}/`
  if (path === base) return ''
  return path.startsWith(root) ? path.slice(root.length) : path
}

function normalize(path: string): string {
  const isAbsolute = path.startsWith('/')
  const out: string[] = []
  for (const part of path.split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..' && out.length > 0 && out[out.length - 1] !== '..') out.pop()
    else out.push(part)
  }
  return (isAbsolute ? '/' : '') + out.join('/')
}
