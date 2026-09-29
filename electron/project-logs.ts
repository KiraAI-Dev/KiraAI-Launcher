import { net } from 'electron'
import { decryptAccessToken, getLocalAccessToken, getWebuiSessionToken } from './cloud.js'
import { getLocalProject, getLocalWebuiUrl } from './local-project.js'
import { loadProjects } from './project-store.js'
import type { LauncherLog, LogEntry } from './types.js'

const MAX_LOG_ENTRIES = 1000

async function resolveProjectLog(id: unknown, signal?: AbortSignal) {
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
  signal?.throwIfAborted()
  const controller = new AbortController()
  const abort = () => controller.abort()
  signal?.addEventListener('abort', abort, { once: true })
  const timeout = setTimeout(abort, 8000)
  let sessionToken: string | undefined
  try {
    sessionToken = await getWebuiSessionToken(target, accessToken, controller.signal)
  } catch (error) {
    if (error instanceof Error && error.message === 'CLOUD_ACCESS_TOKEN_INVALID') throw new Error('INSTANCE_LOG_AUTH_REQUIRED')
    throw new Error('INSTANCE_LOG_READ_FAILED')
  } finally {
    clearTimeout(timeout)
    signal?.removeEventListener('abort', abort)
  }
  if (!sessionToken) throw new Error('INSTANCE_LOG_AUTH_REQUIRED')
  return { target, headers: { Authorization: `Bearer ${sessionToken}` } }
}

function parseLogEntry(entry: unknown): LogEntry {
  if (!entry || typeof entry !== 'object'
    || !('time' in entry) || typeof entry.time !== 'string'
    || !('level' in entry) || typeof entry.level !== 'string'
    || !('name' in entry) || typeof entry.name !== 'string'
    || !('message' in entry) || typeof entry.message !== 'string') throw new Error('INSTANCE_LOG_READ_FAILED')
  const level = entry.level === 'WARNING' ? 'WARN' : entry.level === 'CRITICAL' ? 'ERROR' : entry.level
  return {
    level, content: `[${entry.time}] [${entry.level}] [${entry.name}] ${entry.message}`,
    time: entry.time, displayLevel: entry.level, name: entry.name, message: entry.message,
    color: 'color' in entry && typeof entry.color === 'string' ? entry.color : undefined,
  }
}

function checkResponse(response: Response) {
  if (response.status === 401 || response.status === 403) throw new Error('INSTANCE_LOG_AUTH_REQUIRED')
  if (!response.ok) throw new Error('INSTANCE_LOG_READ_FAILED')
}

function snapshot(entries: LogEntry[]): LauncherLog {
  return { content: entries.map((entry) => entry.content).join('\n'), entries }
}

async function readHistory(target: string, headers: Record<string, string>, signal?: AbortSignal): Promise<LauncherLog> {
  const controller = new AbortController()
  const abort = () => controller.abort()
  signal?.addEventListener('abort', abort, { once: true })
  if (signal?.aborted) controller.abort()
  const timeout = setTimeout(abort, 8000)
  try {
    const response = await net.fetch(`${target}/api/log-history?limit=100`, {
      headers, signal: controller.signal, redirect: 'error',
    })
    checkResponse(response)
    const body: unknown = await response.json()
    if (!body || typeof body !== 'object' || !('logs' in body) || !Array.isArray(body.logs)) throw new Error('INSTANCE_LOG_READ_FAILED')
    return snapshot(body.logs.map(parseLogEntry))
  } catch (error) {
    if (error instanceof Error && error.message === 'INSTANCE_LOG_AUTH_REQUIRED') throw error
    throw new Error('INSTANCE_LOG_READ_FAILED')
  } finally {
    clearTimeout(timeout)
    signal?.removeEventListener('abort', abort)
  }
}

export async function readProjectLog(id: unknown): Promise<LauncherLog> {
  const { target, headers } = await resolveProjectLog(id)
  return readHistory(target, headers)
}

// The instance emits SSE data records, which may span UTF-8 chunks or CRLF lines.
async function consumeLogStream(response: Response, onEntry: (entry: LogEntry) => void) {
  if (!response.body) throw new Error('INSTANCE_LOG_READ_FAILED')
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let data: string[] = []
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) throw new Error('INSTANCE_LOG_READ_FAILED')
      buffer += decoder.decode(value, { stream: true })
      let end: number
      while ((end = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, end).replace(/\r$/, '')
        buffer = buffer.slice(end + 1)
        if (!line) {
          if (data.length) onEntry(parseLogEntry(JSON.parse(data.join('\n'))))
          data = []
        } else if (line.startsWith('data:')) {
          data.push(line.slice(5).replace(/^ /, ''))
        }
      }
      if (buffer.length + data.reduce((size, line) => size + line.length, 0) > 1024 * 1024) throw new Error('INSTANCE_LOG_READ_FAILED')
    }
  } finally {
    await reader.cancel().catch(() => undefined)
    reader.releaseLock()
  }
}

async function streamProjectLog(id: unknown, signal: AbortSignal, onLog: (log: LauncherLog) => void) {
  const { target, headers } = await resolveProjectLog(id, signal)
  if (signal.aborted) return
  const controller = new AbortController()
  const abort = () => controller.abort()
  signal.addEventListener('abort', abort, { once: true })
  // Only connection setup has a deadline: a healthy stream may be quiet indefinitely.
  const timeout = setTimeout(abort, 8000)
  let stream: Promise<void> | undefined
  let streamError: unknown
  let historyReady = false
  let entries: LogEntry[] = []
  let pending: LogEntry[] = []
  try {
    const response = await net.fetch(`${target}/api/live-log`, {
      headers: { ...headers, Accept: 'text/event-stream' }, signal: controller.signal, redirect: 'error',
    })
    clearTimeout(timeout)
    checkResponse(response)
    if (!response.headers.get('content-type')?.includes('text/event-stream')) throw new Error('INSTANCE_LOG_READ_FAILED')
    stream = consumeLogStream(response, (entry) => {
      if (signal.aborted) return
      if (!historyReady) {
        pending.push(entry)
        if (pending.length > MAX_LOG_ENTRIES) throw new Error('INSTANCE_LOG_READ_FAILED')
        return
      }
      entries = [...entries, entry].slice(-MAX_LOG_ENTRIES)
      onLog(snapshot(entries))
    }).catch((error: unknown) => { streamError = error; controller.abort() })
    // Subscribe first so logs produced during the history request are not lost.
    const history = await readHistory(target, headers, controller.signal)
    if (signal.aborted) return
    if (streamError) throw streamError
    entries = history.entries ?? []
    // History can contain the beginning of the live stream. Remove only the overlap,
    // retaining repeated messages that arrive after the snapshot.
    let overlap = Math.min(entries.length, pending.length)
    while (overlap > 0 && !pending.slice(0, overlap).every((entry, index) => entry.content === entries[entries.length - overlap + index]?.content)) overlap--
    entries = [...entries, ...pending.slice(overlap)].slice(-MAX_LOG_ENTRIES)
    pending = []
    historyReady = true
    onLog(snapshot(entries))
    await stream
    if (streamError) throw streamError
  } finally {
    clearTimeout(timeout)
    signal.removeEventListener('abort', abort)
    controller.abort()
    await stream
  }
}

export function watchProjectLog(id: unknown, onLog: (log: LauncherLog) => void, onError: (code: string) => void): () => void {
  const controller = new AbortController()
  let retry: ReturnType<typeof setTimeout> | undefined
  const connect = async () => {
    try {
      await streamProjectLog(id, controller.signal, onLog)
    } catch (error) {
      if (controller.signal.aborted) return
      const code = error instanceof Error && error.message === 'INSTANCE_LOG_AUTH_REQUIRED' ? error.message : 'INSTANCE_LOG_READ_FAILED'
      onError(code)
    }
    if (!controller.signal.aborted) retry = setTimeout(() => { void connect() }, 3000)
  }
  void connect()
  return () => {
    controller.abort()
    clearTimeout(retry)
  }
}
