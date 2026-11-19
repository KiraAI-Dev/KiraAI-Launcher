import { setTimeout as delay } from 'node:timers/promises'
import { getWebuiSessionToken, normalizeCloudUrl, readJson } from './cloud.js'
import { fetchWithTimeout } from './http.js'
import { listProjectReleases } from './project-releases.js'
import type { ProjectRelease, ProjectUpgradeCheck, ProjectUpgradeProgress } from './types.js'

type Instance = { url: string; accessToken?: string }
export type ProjectUpgradeTarget = (Instance & { processId?: number }) | { installedVersion: string | undefined }
type UpgradeCheckEntry = {
  target: ProjectUpgradeTarget
  pending?: Promise<ProjectUpgradeCheck>
  cached?: { value: ProjectUpgradeCheck; expiresAt: number }
}
type Version = { parts: number[]; prerelease: boolean }
type Release = { tag_name?: unknown; draft?: unknown; prerelease?: unknown }
type UpdateTask = { id: string; status: 'running' | 'restarting' | 'failed'; percentage: number; message?: string }

const requestTimeout = 20_000
const updateTimeout = 15 * 60_000
const restartTimeout = 2 * 60_000
const pollInterval = 1_000
const checkCacheTtl = 15 * 60_000
const activeUpgrades = new Set<string>()
const upgradeChecks = new Map<string, UpgradeCheckEntry>()

function parseVersion(value: unknown): Version | undefined {
  if (typeof value !== 'string') return undefined
  const match = /^v?(\d{1,9})\.(\d{1,9})\.(\d{1,9})(-[\w.-]+)?(?:\+[\w.-]+)?$/i.exec(value)
  if (!match) return undefined
  return { parts: match.slice(1, 4).map(Number), prerelease: Boolean(match[4]) }
}

function compareVersions(left: Version, right: Version): number {
  for (const [index, part] of left.parts.entries()) {
    if (part !== right.parts[index]) return part - right.parts[index]
  }
  return Number(right.prerelease) - Number(left.prerelease)
}

function upgradeError(code: string, detail?: string): Error {
  return new Error(detail ? `${code}\n${detail}` : code)
}

class UpgradeHttpError extends Error {
  constructor(readonly status: number, detail?: string) {
    const code = status === 401 || status === 403 ? 'PROJECT_UPGRADE_AUTH_REQUIRED'
      : [404, 405, 501].includes(status) ? 'PROJECT_UPGRADE_UNSUPPORTED' : 'PROJECT_UPGRADE_REQUEST_FAILED'
    super(`${code}\n${status}${detail ? `: ${detail}` : ''}`)
  }
}

async function requestJson<T>(url: string, route: string, token?: string, body?: object): Promise<T | null> {
  const headers: Record<string, string> = { Accept: 'application/json' }
  if (token) headers.Authorization = `Bearer ${token}`
  if (body) headers['Content-Type'] = 'application/json'
  return fetchWithTimeout(`${url}${route}`, requestTimeout, {
    method: body ? 'POST' : 'GET', headers, body: body && JSON.stringify(body), redirect: 'error',
  }, async (response) => {
    const payload = await readJson(response) as { detail?: unknown } | null
    if (!response.ok) {
      const detail = typeof payload?.detail === 'string' ? payload.detail : JSON.stringify(payload?.detail)
      throw new UpgradeHttpError(response.status, detail)
    }
    return payload as T | null
  })
}

async function getSession(instance: Instance): Promise<string> {
  const token = await getWebuiSessionToken(instance.url, instance.accessToken, AbortSignal.timeout(requestTimeout))
  if (!token) throw upgradeError('PROJECT_UPGRADE_AUTH_REQUIRED')
  return token
}

function checkStableRelease(currentVersion: string, current: Version, releases: ProjectRelease[]): ProjectUpgradeCheck {
  let latest: { tag: string; version: Version } | undefined
  for (const { tag, prerelease } of releases) {
    if (prerelease) continue
    const version = parseVersion(tag)
    if (version && !version.prerelease && (!latest || compareVersions(version, latest.version) > 0)) latest = { tag, version }
  }
  if (!latest) throw upgradeError('PROJECT_UPGRADE_NO_STABLE_RELEASE')
  return { currentVersion, targetVersion: latest.tag, updateAvailable: compareVersions(current, latest.version) < 0 }
}

async function checkRelease(url: string, token: string): Promise<ProjectUpgradeCheck> {
  const response = await requestJson<{ current_version?: unknown; releases?: unknown }>(url, '/api/releases', token)
  const currentVersion = response?.current_version
  const current = parseVersion(currentVersion)
  if (typeof currentVersion !== 'string' || !current || !Array.isArray(response?.releases)) throw upgradeError('PROJECT_UPGRADE_INVALID_RESPONSE')

  const releases = (response.releases as (Release | null)[]).flatMap((release) =>
    release && !release.draft && typeof release.tag_name === 'string' ? [{ tag: release.tag_name, prerelease: Boolean(release.prerelease) }] : [],
  )
  return checkStableRelease(currentVersion, current, releases)
}

export async function checkStoppedProjectUpgrade(installedVersion?: string): Promise<ProjectUpgradeCheck> {
  const currentVersion = installedVersion?.trim()
  const current = parseVersion(currentVersion)
  if (!currentVersion || !current) throw upgradeError('PROJECT_UPGRADE_LOCAL_VERSION_UNKNOWN')
  const check = checkStableRelease(currentVersion, current, await listProjectReleases())
  return check.updateAvailable ? { ...check, requiresStart: true } : check
}

export async function checkProjectUpgrade(instance: Instance): Promise<ProjectUpgradeCheck> {
  const url = normalizeCloudUrl(instance.url)
  return checkRelease(url, await getSession({ ...instance, url }))
}

function sameUpgradeTarget(left: ProjectUpgradeTarget, right: ProjectUpgradeTarget): boolean {
  if ('url' in left && 'url' in right) {
    return left.url === right.url && left.accessToken === right.accessToken && left.processId === right.processId
  }
  return 'installedVersion' in left && 'installedVersion' in right && left.installedVersion === right.installedVersion
}

export function checkManagedProjectUpgrade(id: string, target: ProjectUpgradeTarget, refresh = false): Promise<ProjectUpgradeCheck> {
  const existing = upgradeChecks.get(id)
  if (existing && sameUpgradeTarget(existing.target, target)) {
    if (existing.pending) return existing.pending
    if (!refresh && existing.cached && Date.now() < existing.cached.expiresAt) return Promise.resolve(existing.cached.value)
  }

  const request = 'url' in target ? checkProjectUpgrade(target) : checkStoppedProjectUpgrade(target.installedVersion)
  const entry: UpgradeCheckEntry = { target }
  entry.pending = request.then((value) => {
    entry.cached = { value, expiresAt: Date.now() + checkCacheTtl }
    entry.pending = undefined
    return value
  }, (error: unknown) => {
    if (upgradeChecks.get(id) === entry) upgradeChecks.delete(id)
    throw error
  })
  upgradeChecks.set(id, entry)
  return entry.pending
}

export function invalidateProjectUpgradeCheck(id: string): void {
  upgradeChecks.delete(id)
}

function readTask(payload: unknown, targetVersion: string, taskId?: string): UpdateTask {
  const task = payload as { id?: unknown; target_version?: unknown; status?: unknown; overall_percent?: unknown; message?: unknown } | null
  if (typeof task?.id !== 'string' || !task.id || (taskId !== undefined && task.id !== taskId)) throw upgradeError('PROJECT_UPGRADE_INVALID_RESPONSE')
  if (typeof task.target_version !== 'string') throw upgradeError('PROJECT_UPGRADE_INVALID_RESPONSE')
  if (task.target_version !== targetVersion) throw upgradeError('PROJECT_UPGRADE_BUSY', task.target_version)
  if (task.status !== 'running' && task.status !== 'restarting' && task.status !== 'failed') throw upgradeError('PROJECT_UPGRADE_INVALID_RESPONSE')
  const percentage = typeof task.overall_percent === 'number' && Number.isFinite(task.overall_percent) ? Math.max(0, Math.min(99, task.overall_percent)) : 0
  return { id: task.id, status: task.status, percentage, message: typeof task.message === 'string' ? task.message : undefined }
}

async function verifyVersion(instance: Instance, target: Version): Promise<boolean> {
  const health = await requestJson<{ status?: unknown }>(instance.url, '/api/health')
  if (health?.status !== 'ok') return false
  const token = await getSession(instance)
  const response = await requestJson<{ version?: unknown }>(instance.url, '/api/version', token)
  const version = parseVersion(response?.version)
  return Boolean(version && compareVersions(version, target) === 0)
}

async function waitForUpgrade(instance: Instance, token: string, initialTask: UpdateTask, targetVersion: string, target: Version, report: (progress: ProjectUpgradeProgress) => void) {
  const deadline = Date.now() + updateTimeout
  let task = initialTask
  let verifyingUntil = 0
  let lastError: string | undefined
  while (true) {
    if (task.status === 'failed') throw upgradeError('PROJECT_UPGRADE_FAILED', task.message)
    if (task.status === 'restarting' && !verifyingUntil) verifyingUntil = Date.now() + restartTimeout
    if (Date.now() >= (verifyingUntil || deadline)) throw upgradeError('PROJECT_UPGRADE_UNCONFIRMED', lastError)

    if (verifyingUntil) {
      report({ phase: 'verifying' })
      try {
        if (await verifyVersion(instance, target)) return
      } catch (error) {
        if (error instanceof Error) lastError = error.message
      }
      await delay(pollInterval)
      continue
    }

    report({ phase: 'updating', percentage: task.percentage })
    await delay(pollInterval)
    let payload: unknown
    try {
      payload = await requestJson(instance.url, `/api/releases/progress/${encodeURIComponent(task.id)}`, token)
    } catch (error) {
      if (error instanceof Error) lastError = error.message
      if (error instanceof UpgradeHttpError && error.status === 404) {
        verifyingUntil = Date.now() + restartTimeout
        continue
      }
      try {
        if (await verifyVersion(instance, target)) return
        if (error instanceof UpgradeHttpError && [401, 403].includes(error.status)) token = await getSession(instance)
      } catch (verificationError) {
        if (verificationError instanceof Error) lastError = verificationError.message
      }
      continue
    }
    task = readTask(payload, targetVersion, task.id)
    lastError = undefined
  }
}

export async function upgradeProject(instance: Instance, targetVersion: string, report: (progress: ProjectUpgradeProgress) => void): Promise<void> {
  const url = normalizeCloudUrl(instance.url)
  const target = parseVersion(targetVersion)
  if (!target || target.prerelease) throw upgradeError('PROJECT_UPGRADE_RECHECK')
  if (activeUpgrades.has(url)) throw upgradeError('PROJECT_UPGRADE_BUSY')
  activeUpgrades.add(url)
  try {
    const normalized = { ...instance, url }
    report({ phase: 'starting' })
    const token = await getSession(normalized)
    const checked = await checkRelease(url, token)
    if (checked.targetVersion !== targetVersion) throw upgradeError('PROJECT_UPGRADE_RECHECK')
    if (!checked.updateAvailable) {
      if (await verifyVersion(normalized, target)) return
      throw upgradeError('PROJECT_UPGRADE_RECHECK')
    }
    let payload: unknown
    try {
      payload = await requestJson(url, '/api/releases/download', token, { tag_name: targetVersion })
    } catch (error) {
      if (error instanceof UpgradeHttpError && error.status < 500) throw error
      throw upgradeError('PROJECT_UPGRADE_UNCONFIRMED', error instanceof Error ? error.message : undefined)
    }
    const task = readTask(payload, targetVersion)
    await waitForUpgrade(normalized, token, task, targetVersion, target, report)
  } finally {
    activeUpgrades.delete(url)
  }
}
