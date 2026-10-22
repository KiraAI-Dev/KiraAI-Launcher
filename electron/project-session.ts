import { app } from 'electron'
import { promises as fs } from 'node:fs'
import path from 'node:path'

function sessionPath(): string {
  return path.join(app.getPath('userData'), 'project-session.json')
}

export async function loadProjectSession(): Promise<string[]> {
  let value: unknown
  try {
    value = JSON.parse(await fs.readFile(sessionPath(), 'utf8'))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
  return Array.isArray(value)
    ? [...new Set(value.filter((id): id is string => typeof id === 'string' && id.length > 0))]
    : []
}

export async function saveProjectSession(ids: string[]): Promise<void> {
  const file = sessionPath()
  const temporaryFile = file + '.tmp'
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(temporaryFile, JSON.stringify([...new Set(ids)]) + '\n', { encoding: 'utf8', mode: 0o600 })
  await fs.rename(temporaryFile, file)
}
