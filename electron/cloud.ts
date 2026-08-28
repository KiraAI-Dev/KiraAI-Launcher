import { net, safeStorage } from 'electron'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { StoredProject } from './types.js'

type AuthConfigResponse = { auth_enabled?: unknown }
type AuthLoginResponse = { access_token?: unknown }
type InstanceOverviewResponse = { runtime_duration?: unknown }
type InstanceVersionResponse = { version?: unknown }

export function normalizeCloudUrl(value: string): string {
  const parsed = new URL(value.trim())
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) throw new Error('CLOUD_URL_INVALID')
  parsed.pathname = parsed.pathname.replace(/\/$/, '')
  parsed.search = ''
  parsed.hash = ''
  return parsed.toString().replace(/\/$/, '')
}

export async function requestWithTimeout(url: string, init?: RequestInit, timeoutMs = 8000) {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await net.fetch(url, { ...init, signal: controller.signal })
  } finally {
    clearTimeout(timeout)
  }
}

export async function verifyCloudProject(url: string): Promise<string> {
  const normalizedUrl = normalizeCloudUrl(url)
  let response: Response
  try {
    response = await requestWithTimeout(`${normalizedUrl}/api/health`)
  } catch {
    throw new Error('CLOUD_UNREACHABLE')
  }
  if (!response.ok) throw new Error('CLOUD_NOT_KIRAAI')
  const body = await response.json() as { status?: unknown }
  if (body.status !== 'ok') throw new Error('CLOUD_HEALTH_INVALID')
  return normalizedUrl
}

export async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json()
  } catch {
    return null
  }
}

export async function getWebuiSessionToken(url: string, accessToken?: string): Promise<string | undefined> {
  let configResponse: Response
  try {
    configResponse = await requestWithTimeout(`${url}/api/auth/config`)
  } catch {
    throw new Error('CLOUD_UNREACHABLE')
  }
  const authConfig = await readJson(configResponse) as AuthConfigResponse | null
  const authEnabled = authConfig?.auth_enabled
  if (authEnabled !== true && authEnabled !== false) throw new Error('CLOUD_AUTH_CONFIG_INVALID')
  if (authEnabled && !accessToken) return undefined

  let loginResponse: Response
  try {
    loginResponse = await requestWithTimeout(`${url}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ access_token: authEnabled ? accessToken : 'disabled' }),
    })
  } catch {
    throw new Error('CLOUD_UNREACHABLE')
  }
  if (!loginResponse.ok) {
    if (loginResponse.status === 401 || loginResponse.status === 403) throw new Error('CLOUD_ACCESS_TOKEN_INVALID')
    throw new Error('CLOUD_LOGIN_FAILED')
  }
  const login = await readJson(loginResponse) as AuthLoginResponse | null
  if (typeof login?.access_token !== 'string' || !login.access_token) throw new Error('CLOUD_LOGIN_FAILED')
  return login.access_token
}

export function encryptAccessToken(accessToken: string): string {
  if (!safeStorage.isEncryptionAvailable()) throw new Error('CLOUD_TOKEN_ENCRYPTION_UNAVAILABLE')
  return safeStorage.encryptString(accessToken).toString('base64')
}

export function decryptAccessToken(project: StoredProject): string | undefined {
  if (!project.encryptedAccessToken) return undefined
  if (!safeStorage.isEncryptionAvailable()) throw new Error('CLOUD_TOKEN_DECRYPT_FAILED')
  try {
    const accessToken = safeStorage.decryptString(Buffer.from(project.encryptedAccessToken, 'base64'))
    if (!accessToken) throw new Error('CLOUD_TOKEN_DECRYPT_FAILED')
    return accessToken
  } catch {
    throw new Error('CLOUD_TOKEN_DECRYPT_FAILED')
  }
}

export async function getInstanceRuntimeDuration(url: string, sessionToken: string): Promise<number> {
  let response: Response
  try {
    response = await requestWithTimeout(`${url}/api/overview`, { headers: { Authorization: `Bearer ${sessionToken}` } })
  } catch {
    throw new Error('CLOUD_UNREACHABLE')
  }
  if (!response.ok) throw new Error('CLOUD_OVERVIEW_UNAVAILABLE')
  const overview = await readJson(response) as InstanceOverviewResponse | null
  const runtimeDuration = overview?.runtime_duration
  if (typeof runtimeDuration !== 'number' || !Number.isFinite(runtimeDuration) || runtimeDuration < 0) throw new Error('CLOUD_OVERVIEW_INVALID')
  return Math.floor(runtimeDuration)
}

export async function getInstanceVersion(url: string, sessionToken: string): Promise<string> {
  let response: Response
  try {
    response = await requestWithTimeout(`${url}/api/version`, { headers: { Authorization: `Bearer ${sessionToken}` } })
  } catch {
    throw new Error('CLOUD_UNREACHABLE')
  }
  if (!response.ok) throw new Error('CLOUD_VERSION_UNAVAILABLE')
  const versionResponse = await readJson(response) as InstanceVersionResponse | null
  if (typeof versionResponse?.version !== 'string' || !versionResponse.version.trim()) throw new Error('CLOUD_VERSION_INVALID')
  return versionResponse.version.trim()
}

export async function getLocalAccessToken(projectPath: string): Promise<string | undefined> {
  try {
    const config = JSON.parse(await fs.readFile(path.join(projectPath, 'data', 'webui.json'), 'utf8')) as { access_token?: unknown }
    return typeof config.access_token === 'string' && config.access_token && config.access_token !== 'disabled' ? config.access_token : undefined
  } catch {
    return undefined
  }
}
