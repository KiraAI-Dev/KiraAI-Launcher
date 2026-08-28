import { app } from 'electron'
import { randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { getLocalProject } from './local-project.js'
import type { ManagedProject, StoredProject } from './types.js'

function projectsPath() {
  return path.join(app.getPath('userData'), 'projects.json')
}

function sanitizeProject(value: unknown): StoredProject | null {
  if (typeof value !== 'object' || value === null) return null
  const candidate = value as Partial<StoredProject>
  const type = candidate.type
  if (typeof candidate.id !== 'string' || typeof candidate.name !== 'string' || (type !== 'local' && type !== 'cloud')) return null
  if (type === 'local' && typeof candidate.projectPath !== 'string') return null
  if (type === 'cloud' && typeof candidate.url !== 'string') return null
  const launchArgs = sanitizeLaunchArgs(candidate.launchArgs)
  const environmentVariables = sanitizeEnvironmentVariables(candidate.environmentVariables)
  if (launchArgs === null || environmentVariables === null) return null
  return { id: candidate.id, name: candidate.name, type, projectPath: candidate.projectPath, url: candidate.url, port: typeof candidate.port === 'number' ? candidate.port : undefined, launchArgs, environmentVariables, encryptedAccessToken: typeof candidate.encryptedAccessToken === 'string' ? candidate.encryptedAccessToken : undefined, createdAt: typeof candidate.createdAt === 'string' ? candidate.createdAt : new Date().toISOString() }
}

export function sanitizeLaunchArgs(value: unknown): string[] | null {
  if (typeof value === 'undefined') return []
  if (!Array.isArray(value) || value.length > 128) return null
  if (value.some((argument) => typeof argument !== 'string' || argument.length > 4_096 || argument.includes('\0'))) return null
  return [...value]
}

export function sanitizeEnvironmentVariables(value: unknown): Record<string, string> | null {
  if (typeof value === 'undefined') return {}
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const entries = Object.entries(value)
  if (entries.length > 128 || entries.some(([key, variableValue]) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || typeof variableValue !== 'string' || variableValue.length > 16_384 || variableValue.includes('\0'))) return null
  return Object.fromEntries(entries)
}

export function toManagedProject(project: StoredProject): ManagedProject {
  const { encryptedAccessToken: _encryptedAccessToken, ...managedProject } = project
  return managedProject
}

export async function loadProjects(): Promise<StoredProject[]> {
  try {
    const value = JSON.parse(await fs.readFile(projectsPath(), 'utf8'))
    const projects = Array.isArray(value) ? value.map(sanitizeProject).filter((project): project is StoredProject => project !== null) : []
    const needsRuntimeDataCleanup = Array.isArray(value) && value.some((project) => typeof project === 'object' && project !== null && ('version' in project || 'runtimeStartedAt' in project || 'runtimeDuration' in project))
    if (needsRuntimeDataCleanup) await saveProjects(projects)
    return Promise.all(projects.map(async (project) => {
      if (project.type !== 'local' || !project.projectPath) return project
      try {
        const detected = await getLocalProject(project.projectPath)
        return { ...project, port: detected.port }
      } catch {
        return project
      }
    }))
  } catch {
    return []
  }
}

export async function saveProjects(projects: StoredProject[]): Promise<StoredProject[]> {
  const filePath = projectsPath()
  const temporaryPath = `${filePath}.tmp`
  await fs.mkdir(path.dirname(filePath), { recursive: true })
  await fs.writeFile(temporaryPath, `${JSON.stringify(projects, null, 2)}\n`, 'utf8')
  await fs.rename(temporaryPath, filePath)
  return projects
}

export async function registerProject(project: Omit<StoredProject, 'id' | 'createdAt'>): Promise<StoredProject> {
  const projects = await loadProjects()
  const duplicate = projects.find((item) => item.type === project.type && (project.type === 'local' ? item.projectPath === project.projectPath : item.url === project.url))
  if (duplicate) {
    const updatedProject: StoredProject = { ...duplicate, ...project, id: duplicate.id, createdAt: duplicate.createdAt }
    if (JSON.stringify(updatedProject) !== JSON.stringify(duplicate)) await saveProjects(projects.map((item) => item.id === duplicate.id ? updatedProject : item))
    return updatedProject
  }
  const savedProject: StoredProject = { ...project, id: randomUUID(), createdAt: new Date().toISOString() }
  await saveProjects([...projects, savedProject])
  return savedProject
}
