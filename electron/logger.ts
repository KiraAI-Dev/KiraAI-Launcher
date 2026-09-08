import { app } from 'electron'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { LauncherLog } from './types.js'

type LogLevel = 'INFO' | 'WARN' | 'ERROR'

const MAX_LOG_READ_BYTES = 512 * 1024
let writeQueue = Promise.resolve()

function launcherLogPath(): string {
  return path.join(app.getPath('userData'), 'logs', 'launcher.log')
}

function singleLine(value: unknown): string {
  return String(value).replace(/[\r\n]+/g, ' ').trim()
}

export function writeLauncherLog(level: LogLevel, message: string, details?: Record<string, unknown>): Promise<void> {
  const metadata = details
    ? Object.entries(details)
        .filter(([, value]) => value !== undefined && value !== null && value !== '')
        .map(([key, value]) => `${key}=${singleLine(value)}`)
        .join(' ')
    : ''
  const line = `[${new Date().toISOString()}] [${level}] ${singleLine(message)}${metadata ? ` ${metadata}` : ''}\n`
  const logPath = launcherLogPath()
  writeQueue = writeQueue
    .catch(() => undefined)
    .then(async () => {
      await fs.mkdir(path.dirname(logPath), { recursive: true })
      await fs.appendFile(logPath, line, 'utf8')
    })
    .catch(() => undefined)
  return writeQueue
}

export async function initializeLauncherLog(): Promise<void> {
  await writeLauncherLog('INFO', 'KiraAI Launcher started', {
    version: app.getVersion(),
    platform: process.platform,
    arch: process.arch,
  })
}

export async function readLauncherLog(): Promise<LauncherLog> {
  await writeQueue
  const logPath = launcherLogPath()
  try {
    const stat = await fs.stat(logPath)
    const bytesToRead = Math.min(stat.size, MAX_LOG_READ_BYTES)
    const buffer = Buffer.alloc(bytesToRead)
    const handle = await fs.open(logPath, 'r')
    let bytesRead = 0
    try {
      const result = await handle.read(buffer, 0, bytesToRead, stat.size - bytesToRead)
      bytesRead = result.bytesRead
    } finally {
      await handle.close()
    }
    let content = buffer.toString('utf8', 0, bytesRead)
    if (stat.size > bytesToRead) {
      const firstNewline = content.indexOf('\n')
      if (firstNewline >= 0) content = content.slice(firstNewline + 1)
    }
    return { path: logPath, content }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { path: logPath, content: '' }
    throw new Error('LOG_READ_FAILED')
  }
}
