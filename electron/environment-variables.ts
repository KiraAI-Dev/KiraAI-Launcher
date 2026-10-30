/** Validate both launcher-wide and per-project environment overrides. */
export function sanitizeEnvironmentVariables(value: unknown): Record<string, string> | null {
  if (typeof value === 'undefined') return {}
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const entries = Object.entries(value)
  if (entries.length > 128 || entries.some(([key, variableValue]) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || typeof variableValue !== 'string' || variableValue.length > 16_384 || variableValue.includes('\0'))) return null
  return Object.fromEntries(entries)
}

export function parseEnvironmentVariables(text: string): Record<string, string> {
  const entries: [string, string][] = []
  const keys = new Set<string>()
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue
    const separator = line.indexOf('=')
    const key = line.slice(0, separator).trim()
    if (separator <= 0 || keys.has(key)) throw new Error('ENVIRONMENT_VARIABLES_INVALID')
    keys.add(key)
    entries.push([key, line.slice(separator + 1)])
  }
  const variables = sanitizeEnvironmentVariables(Object.fromEntries(entries))
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
