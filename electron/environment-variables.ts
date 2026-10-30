/** Validate stored overrides; optionally reject case-only collisions on Windows saves. */
export function sanitizeEnvironmentVariables(value: unknown, caseInsensitive = false): Record<string, string> | null {
  if (typeof value === 'undefined') return {}
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const entries = Object.entries(value)
  if (entries.length > 128 || entries.some(([key, variableValue]) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || typeof variableValue !== 'string' || variableValue.length > 16_384 || variableValue.includes('\0'))) return null
  const names = entries.map(([key]) => caseInsensitive ? key.toUpperCase() : key)
  if (new Set(names).size !== names.length) return null
  return Object.fromEntries(entries)
}

/** Keep ordinary KEY=VALUE literal; KEY:=JSON-string encodes existing multiline values. */
export function formatEnvironmentVariables(variables: Record<string, string>): string {
  return Object.entries(variables).map(([key, value]) => /[\r\n]/.test(value)
    ? `${key}:=${JSON.stringify(value)}` : `${key}=${value}`).join('\n')
}

/** Parse the editor without changing literal quotes, backslashes or embedded equals signs. */
export function parseEnvironmentVariables(text: string, caseInsensitive = false): Record<string, string> {
  const entries: [string, string][] = []
  const keys = new Set<string>()
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue
    const separator = line.indexOf('=')
    const encoded = line.slice(0, separator).trimEnd().endsWith(':')
    const name = line.slice(0, separator).trim()
    const key = (encoded ? name.slice(0, -1) : name).trim()
    const normalizedKey = caseInsensitive ? key.toUpperCase() : key
    if (separator <= 0 || keys.has(normalizedKey)) throw new Error('ENVIRONMENT_VARIABLES_INVALID')
    keys.add(normalizedKey)
    let value: unknown = line.slice(separator + 1)
    if (encoded) {
      try { value = JSON.parse(value as string) } catch { throw new Error('ENVIRONMENT_VARIABLES_INVALID') }
    }
    if (typeof value !== 'string') throw new Error('ENVIRONMENT_VARIABLES_INVALID')
    entries.push([key, value])
  }
  const variables = sanitizeEnvironmentVariables(Object.fromEntries(entries), caseInsensitive)
  if (!variables) throw new Error('ENVIRONMENT_VARIABLES_INVALID')
  return variables
}

/** Windows treats environment names case-insensitively, including Path/PATH. */
export function mergeEnvironmentVariables(base: Record<string, string | undefined>, global: Record<string, string>, project: Record<string, string> = {}, platform = process.platform): Record<string, string | undefined> {
  const entries = new Map<string, [string, string | undefined]>()
  for (const source of [base, global, project]) {
    for (const [key, value] of Object.entries(source)) entries.set(platform === 'win32' ? key.toUpperCase() : key, [key, value])
  }
  return Object.fromEntries(entries.values())
}
