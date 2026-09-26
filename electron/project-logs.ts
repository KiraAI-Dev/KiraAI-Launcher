import { net } from 'electron'
import { decryptAccessToken, getLocalAccessToken, getWebuiSessionToken } from './cloud.js'
import { getLocalProject, getLocalWebuiUrl } from './local-project.js'
import { loadProjects } from './project-store.js'
import type { LauncherLog } from './types.js'

export async function readProjectLog(id: unknown): Promise<LauncherLog> {
  if (typeof id !== 'string' || !id.trim()) throw new Error('PROJECT_ID_INVALID')
  const project = (await loadProjects()).find((item) => item.id === id)
  if (!project) throw new Error('PROJECT_NOT_FOUND')

  let target: string | undefined
  let accessToken: string | undefined
  if (project.type === 'local') {
    if (!project.projectPath) throw new Error('PROJECT_PATH_INVALID')
    const local = await getLocalProject(project.projectPath)
    target = getLocalWebuiUrl(local.host, local.port ?? 5267)
    accessToken = await getLocalAccessToken(project.projectPath)
  } else {
    target = project.url
    accessToken = decryptAccessToken(project)
  }
  if (!target) throw new Error('PROJECT_URL_UNAVAILABLE')

  let sessionToken: string | undefined
  try {
    sessionToken = await getWebuiSessionToken(target, accessToken)
  } catch (error) {
    if (error instanceof Error && error.message === 'CLOUD_ACCESS_TOKEN_INVALID') throw new Error('INSTANCE_LOG_AUTH_REQUIRED')
    throw new Error('INSTANCE_LOG_READ_FAILED')
  }
  if (!sessionToken) throw new Error('INSTANCE_LOG_AUTH_REQUIRED')

  // Keep the timeout active while reading the body as well as the headers.
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 8000)
  try {
    const response = await net.fetch(`${target}/api/log-history?limit=100`, {
      headers: { Authorization: `Bearer ${sessionToken}` },
      signal: controller.signal,
      redirect: 'error',
    })
    if (response.status === 401 || response.status === 403) throw new Error('INSTANCE_LOG_AUTH_REQUIRED')
    if (!response.ok) throw new Error('INSTANCE_LOG_READ_FAILED')
    const body: unknown = await response.json()
    if (!body || typeof body !== 'object' || !('logs' in body) || !Array.isArray(body.logs)) throw new Error('INSTANCE_LOG_READ_FAILED')
    const entries = body.logs.map((entry: unknown) => {
      if (!entry || typeof entry !== 'object'
        || !('time' in entry) || typeof entry.time !== 'string'
        || !('level' in entry) || typeof entry.level !== 'string'
        || !('name' in entry) || typeof entry.name !== 'string'
        || !('message' in entry) || typeof entry.message !== 'string') throw new Error('INSTANCE_LOG_READ_FAILED')
      const level = entry.level === 'WARNING' ? 'WARN' : entry.level === 'CRITICAL' ? 'ERROR' : entry.level
      return { level, content: `[${entry.time}] [${entry.level}] [${entry.name}] ${entry.message}` }
    })
    return { content: entries.map((entry) => entry.content).join('\n'), entries }
  } catch (error) {
    if (error instanceof Error && error.message === 'INSTANCE_LOG_AUTH_REQUIRED') throw error
    throw new Error('INSTANCE_LOG_READ_FAILED')
  } finally {
    clearTimeout(timeout)
  }
}
