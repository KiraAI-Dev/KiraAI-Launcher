import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { ManagedProject } from './types.js'

const defaultHost = '0.0.0.0'

export function normalizeLocalWebuiHost(value: string): string | undefined {
  const host = value.trim()
  if (!host || host.length > 253 || /[\s/@?#\\]/.test(host)) return undefined
  if (host.includes(':')) return /^[0-9a-fA-F:]+$/.test(host) ? host : undefined
  return /^[a-zA-Z0-9](?:[a-zA-Z0-9.-]*[a-zA-Z0-9])?$/.test(host) && !host.includes('..') ? host : undefined
}

export function getLocalWebuiUrl(host: string | undefined, port: number): string {
  const configuredHost = host || defaultHost
  const urlHost = configuredHost === '0.0.0.0' ? '127.0.0.1' : configuredHost === '::' ? '[::1]' : configuredHost.includes(':') ? `[${configuredHost}]` : configuredHost
  return `http://${urlHost}:${port}`
}

export async function getLocalProject(projectPath: string): Promise<Omit<ManagedProject, 'id' | 'createdAt'>> {
  const mainPath = path.join(projectPath, 'main.py')
  const requirementsPath = path.join(projectPath, 'requirements.txt')
  try {
    await Promise.all([fs.access(mainPath), fs.access(requirementsPath)])
  } catch {
    throw new Error('LOCAL_PROJECT_INVALID')
  }
  let host = defaultHost
  let port = 5267
  try {
    const config = JSON.parse(await fs.readFile(path.join(projectPath, 'data', 'webui.json'), 'utf8')) as { host?: unknown; port?: unknown }
    if (typeof config.host === 'string') host = normalizeLocalWebuiHost(config.host) ?? defaultHost
    if (typeof config.port === 'number' && Number.isInteger(config.port) && config.port > 0 && config.port < 65536) port = config.port
  } catch {
    // KiraAI uses port 5267 when no webui.json exists yet.
  }
  let version: string | undefined
  try {
    const config = await fs.readFile(path.join(projectPath, 'core', 'config', 'default.py'), 'utf8')
    version = config.match(/^VERSION\s*=\s*["']([^"']+)["']/m)?.[1]
  } catch {
    // The project is still manageable when its version cannot be read.
  }
  return { name: path.basename(projectPath), type: 'local', projectPath, host, port, version }
}

export async function saveLocalWebuiSettings(projectPath: string, host: string, port: number): Promise<void> {
  const configPath = path.join(projectPath, 'data', 'webui.json')
  let config: Record<string, unknown> = {}
  try {
    const value = JSON.parse(await fs.readFile(configPath, 'utf8')) as unknown
    if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('PROJECT_SETTINGS_SAVE_FAILED')
    config = value as Record<string, unknown>
  } catch (error) {
    if (error instanceof Error && error.message === 'PROJECT_SETTINGS_SAVE_FAILED') throw error
    const errorCode = typeof error === 'object' && error !== null && 'code' in error ? (error as NodeJS.ErrnoException).code : undefined
    if (errorCode !== 'ENOENT') throw new Error('PROJECT_SETTINGS_SAVE_FAILED')
  }
  try {
    const temporaryPath = `${configPath}.tmp`
    await fs.mkdir(path.dirname(configPath), { recursive: true })
    await fs.writeFile(temporaryPath, `${JSON.stringify({ ...config, host, port }, null, 2)}\n`, 'utf8')
    await fs.rename(temporaryPath, configPath)
  } catch {
    throw new Error('PROJECT_SETTINGS_SAVE_FAILED')
  }
}
