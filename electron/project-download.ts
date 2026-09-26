import { net } from 'electron'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { inflateRawSync } from 'node:zlib'
import { getLocalProject } from './local-project.js'
import { registerProject } from './project-store.js'
import type { ProjectProgressReporter, ProjectRelease, StoredProject } from './types.js'

const KIRAAI_RELEASES_API_URL = 'https://api.github.com/repos/KiraAI-Dev/KiraAI/releases/latest'
const DOWNLOAD_TIMEOUT_MS = 5 * 60 * 1000
const MAX_ARCHIVE_SIZE = 512 * 1024 * 1024
const MAX_EXTRACTED_SIZE = 1024 * 1024 * 1024

function downloadError(code: string): Error {
  return new Error(code)
}

function isDownloadError(error: unknown): boolean {
  return error instanceof Error && ['DOWNLOAD_DIRECTORY_EXISTS', 'DOWNLOAD_DIRECTORY_UNWRITABLE', 'DOWNLOAD_ARCHIVE_INVALID', 'RELEASE_LOOKUP_FAILED', 'RELEASE_RATE_LIMITED', 'DOWNLOAD_FAILED'].includes(error.message)
}

function isPermissionError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && ((error as NodeJS.ErrnoException).code === 'EACCES' || (error as NodeJS.ErrnoException).code === 'EPERM')
}

/** Keeps the abort deadline active until the optional response reader finishes. */
async function fetchWithTimeout(url: string, timeoutMs: number, init?: RequestInit): Promise<Response>
async function fetchWithTimeout<T>(url: string, timeoutMs: number, init: RequestInit | undefined, readResponse: (response: Response) => Promise<T>): Promise<T>
async function fetchWithTimeout<T>(url: string, timeoutMs: number, init?: RequestInit, readResponse?: (response: Response) => Promise<T>): Promise<Response | T> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await net.fetch(url, { ...init, signal: controller.signal })
    return readResponse ? await readResponse(response) : response
  } finally {
    clearTimeout(timeout)
  }
}

export async function listProjectReleases(): Promise<ProjectRelease[]> {
  try {
    const payload: unknown = await fetchWithTimeout('https://api.github.com/repos/KiraAI-Dev/KiraAI/releases?per_page=50', 15_000, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'KiraAI-Launcher' },
    }, async (response) => {
      const rateLimited = response.status === 429 || (response.status === 403 && (response.headers.get('x-ratelimit-remaining') === '0' || response.headers.has('retry-after')))
      if (!response.ok) {
        await response.body?.cancel()
        throw downloadError(rateLimited ? 'RELEASE_LIST_RATE_LIMITED' : 'RELEASE_LIST_FAILED')
      }
      return response.json()
    })
    if (!Array.isArray(payload)) throw downloadError('RELEASE_LIST_FAILED')
    const releases: ProjectRelease[] = []
    for (const release of payload.slice(0, 50)) {
      if (!release || release.draft || typeof release.tag_name !== 'string' || !release.tag_name.trim()) continue
      if (!releases.some(({ tag }) => tag === release.tag_name)) {
        releases.push({ tag: release.tag_name, prerelease: release.prerelease === true })
      }
    }
    return releases
  } catch (error) {
    if (error instanceof Error && error.message === 'RELEASE_LIST_RATE_LIMITED') throw error
    throw downloadError('RELEASE_LIST_FAILED')
  }
}

async function getLatestReleaseArchiveUrl(): Promise<string> {
  let rateLimited = false
  try {
    const payload = await fetchWithTimeout(KIRAAI_RELEASES_API_URL, 15_000, { headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'KiraAI-Launcher' } }, async (response) => {
      rateLimited = response.status === 429 || (response.status === 403 && (response.headers.get('x-ratelimit-remaining') === '0' || response.headers.has('retry-after')))
      if (!response.ok) {
        await response.body?.cancel()
        throw new Error('HTTP_ERROR')
      }
      return response.json() as Promise<{ tag_name?: unknown }>
    })
    if (typeof payload.tag_name !== 'string' || !payload.tag_name.trim()) throw new Error('INVALID_RESPONSE')
    return 'https://github.com/KiraAI-Dev/KiraAI/archive/refs/tags/' + encodeURIComponent(payload.tag_name) + '.zip'
  } catch {
    // The public release page remains usable when the REST API is unavailable.
    // Follow GitHub's canonical repository redirect, including repository transfers.
  }

  try {
    return await getReleasePageArchiveUrl()
  } catch {
    throw downloadError(rateLimited ? 'RELEASE_RATE_LIMITED' : 'RELEASE_LOOKUP_FAILED')
  }
}

function getReleasePageArchiveUrl(): Promise<string> {
  // Electron net.fetch does not expose the final Response.url reliably.
  return new Promise((resolve, reject) => {
    const request = net.request({ url: 'https://github.com/KiraAI-Dev/KiraAI/releases/latest', redirect: 'manual' })
    let settled = false
    let redirects = 0
    const finish = (archiveUrl?: string) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      request.abort()
      if (archiveUrl) resolve(archiveUrl)
      else reject(downloadError('RELEASE_LOOKUP_FAILED'))
    }
    const timeout = setTimeout(() => finish(), 15_000)
    request.on('redirect', (_statusCode, _method, target) => {
      try {
        const releaseUrl = new URL(target)
        if (++redirects > 5 || releaseUrl.origin !== 'https://github.com') return finish()
        const match = /^\/([^/]+\/KiraAI)\/releases\/tag\/(.+)$/i.exec(releaseUrl.pathname)
        if (match) {
          const tag = decodeURIComponent(match[2])
          if (!tag.trim()) return finish()
          return finish('https://github.com/' + match[1] + '/archive/refs/tags/' + encodeURIComponent(tag) + '.zip')
        }
        if (!/^\/[^/]+\/KiraAI\/releases\/latest$/i.test(releaseUrl.pathname)) return finish()
        request.followRedirect()
      } catch {
        finish()
      }
    })
    request.once('error', () => finish())
    request.once('response', (response) => {
      response.once('error', () => finish())
      finish()
    })
    try {
      request.setHeader('Accept', 'text/html')
      request.setHeader('User-Agent', 'KiraAI-Launcher')
      request.end()
    } catch {
      finish()
    }
  })
}

async function downloadArchive(url: string, archivePath: string, report: ProjectProgressReporter): Promise<void> {
  let response: Response
  try {
    response = await fetchWithTimeout(url, DOWNLOAD_TIMEOUT_MS, { headers: { Accept: 'application/zip', 'User-Agent': 'KiraAI-Launcher' } })
  } catch {
    throw downloadError('DOWNLOAD_FAILED')
  }
  if (!response.ok || !response.body) throw downloadError('DOWNLOAD_FAILED')
  const contentLength = Number(response.headers.get('content-length'))
  if (Number.isFinite(contentLength) && contentLength > MAX_ARCHIVE_SIZE) throw downloadError('DOWNLOAD_FAILED')
  const total = Number.isFinite(contentLength) && contentLength > 0 ? contentLength : undefined
  report({ stage: 'download', completed: 0, total })
  const archive = await fs.open(archivePath, 'wx')
  let received = 0
  try {
    for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
      received += chunk.byteLength
      if (received > MAX_ARCHIVE_SIZE) throw downloadError('DOWNLOAD_FAILED')
      await archive.write(chunk)
      report({ stage: 'download', completed: received, total })
    }
  } finally {
    await archive.close()
  }
}

function archiveError(): never {
  throw downloadError('DOWNLOAD_ARCHIVE_INVALID')
}

function findEndOfCentralDirectory(archive: Buffer): number {
  const minimumOffset = Math.max(0, archive.length - 65_557)
  for (let offset = archive.length - 22; offset >= minimumOffset; offset -= 1) if (archive.readUInt32LE(offset) === 0x06054b50) return offset
  return archiveError()
}

function safeArchivePath(extractRoot: string, memberName: string): string {
  const normalized = memberName.replace(/\\/g, '/')
  if (!normalized || normalized.startsWith('/') || /^[A-Za-z]:/.test(normalized)) archiveError()
  const segments = normalized.split('/')
  if (segments.some((segment) => !segment || segment === '.' || segment === '..')) archiveError()
  const target = path.resolve(extractRoot, ...segments)
  const relativeTarget = path.relative(extractRoot, target)
  if (relativeTarget.startsWith('..') || path.isAbsolute(relativeTarget)) archiveError()
  return target
}

async function extractReleaseArchive(archivePath: string, extractRoot: string, report: ProjectProgressReporter): Promise<void> {
  const archive = await fs.readFile(archivePath)
  if (archive.length < 22 || archive.length > MAX_ARCHIVE_SIZE) archiveError()
  const eocdOffset = findEndOfCentralDirectory(archive)
  const entries = archive.readUInt16LE(eocdOffset + 10)
  const centralDirectoryOffset = archive.readUInt32LE(eocdOffset + 16)
  if (entries === 0xffff || centralDirectoryOffset === 0xffffffff || centralDirectoryOffset >= archive.length) archiveError()
  report({ stage: 'extract', completed: 0, total: entries })
  let offset = centralDirectoryOffset
  let extractedSize = 0
  for (let index = 0; index < entries; index += 1) {
    if (offset + 46 > archive.length || archive.readUInt32LE(offset) !== 0x02014b50) archiveError()
    const flags = archive.readUInt16LE(offset + 8)
    const compression = archive.readUInt16LE(offset + 10)
    const compressedSize = archive.readUInt32LE(offset + 20)
    const uncompressedSize = archive.readUInt32LE(offset + 24)
    const nameLength = archive.readUInt16LE(offset + 28)
    const extraLength = archive.readUInt16LE(offset + 30)
    const commentLength = archive.readUInt16LE(offset + 32)
    const externalAttributes = archive.readUInt32LE(offset + 38)
    const localHeaderOffset = archive.readUInt32LE(offset + 42)
    const headerEnd = offset + 46 + nameLength + extraLength + commentLength
    if (headerEnd > archive.length || flags & 0x1 || localHeaderOffset >= archive.length) archiveError()
    const memberName = archive.subarray(offset + 46, offset + 46 + nameLength).toString('utf8')
    const unixMode = externalAttributes >>> 16
    if ((unixMode & 0o170000) === 0o120000) {
      offset = headerEnd
      report({ stage: 'extract', completed: index + 1, total: entries })
      continue
    }
    const isDirectory = memberName.endsWith('/')
    const targetPath = safeArchivePath(extractRoot, isDirectory ? memberName.slice(0, -1) : memberName)
    if (isDirectory) await fs.mkdir(targetPath, { recursive: true })
    else {
      extractedSize += uncompressedSize
      if (extractedSize > MAX_EXTRACTED_SIZE || (compression !== 0 && compression !== 8)) archiveError()
      if (localHeaderOffset + 30 > archive.length || archive.readUInt32LE(localHeaderOffset) !== 0x04034b50) archiveError()
      const localNameLength = archive.readUInt16LE(localHeaderOffset + 26)
      const localExtraLength = archive.readUInt16LE(localHeaderOffset + 28)
      const dataStart = localHeaderOffset + 30 + localNameLength + localExtraLength
      const dataEnd = dataStart + compressedSize
      if (dataEnd > archive.length) archiveError()
      const compressedData = archive.subarray(dataStart, dataEnd)
      let contents: Buffer
      try {
        contents = compression === 0 ? compressedData : inflateRawSync(compressedData)
      } catch {
        archiveError()
      }
      if (contents.length !== uncompressedSize) archiveError()
      await fs.mkdir(path.dirname(targetPath), { recursive: true })
      await fs.writeFile(targetPath, contents, { flag: 'wx', mode: (unixMode & 0o777) || 0o644 })
    }
    offset = headerEnd
    report({ stage: 'extract', completed: index + 1, total: entries })
  }
}

async function findReleaseProjectRoot(extractRoot: string): Promise<string> {
  const entries = await fs.readdir(extractRoot, { withFileTypes: true })
  return entries.length === 1 && entries[0].isDirectory() ? path.join(extractRoot, entries[0].name) : extractRoot
}

export async function downloadAndRegisterProject(parentPath: string, name: string, report: ProjectProgressReporter = () => {}, releaseTag?: string): Promise<StoredProject> {
  if (releaseTag !== undefined && (typeof releaseTag !== 'string' || !releaseTag || releaseTag.length > 256 || /[\s\x00-\x1f\x7f]/.test(releaseTag))) {
    throw downloadError('DOWNLOAD_INPUT_INVALID')
  }
  report({ stage: 'directory' })
  const destination = path.resolve(parentPath, name)
  if (path.dirname(destination) !== path.resolve(parentPath)) throw downloadError('DOWNLOAD_DIRECTORY_INVALID')
  const destinationExists = await fs.stat(destination).then(() => true, (error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return false
    throw error
  })
  if (destinationExists) {
    if (releaseTag !== undefined) throw downloadError('DOWNLOAD_DIRECTORY_EXISTS')
    try {
      report({ stage: 'register' })
      const project = await getLocalProject(destination)
      return await registerProject({ ...project, name, projectPath: destination })
    } catch {
      throw downloadError('DOWNLOAD_DIRECTORY_EXISTS')
    }
  }
  let stagingDirectory: string | undefined
  let movedToDestination = false
  try {
    stagingDirectory = await fs.mkdtemp(path.join(parentPath, `.${name}-download-`))
    const archivePath = path.join(stagingDirectory, 'kira-ai-release.zip')
    const extractRoot = path.join(stagingDirectory, 'extracted')
    report({ stage: 'release' })
    const archiveUrl = releaseTag === undefined
      ? await getLatestReleaseArchiveUrl()
      : 'https://github.com/KiraAI-Dev/KiraAI/archive/refs/tags/' + encodeURIComponent(releaseTag) + '.zip'
    report({ stage: 'download', completed: 0 })
    await downloadArchive(archiveUrl, archivePath, report)
    await fs.mkdir(extractRoot)
    report({ stage: 'extract' })
    await extractReleaseArchive(archivePath, extractRoot, report)
    report({ stage: 'register' })
    const sourceRoot = await findReleaseProjectRoot(extractRoot)
    const project = await getLocalProject(sourceRoot)
    await fs.rename(sourceRoot, destination)
    movedToDestination = true
    return await registerProject({ ...project, name, projectPath: destination })
  } catch (error) {
    if (movedToDestination) await fs.rm(destination, { recursive: true, force: true })
    if (isDownloadError(error)) throw error
    if (!stagingDirectory && isPermissionError(error)) throw downloadError('DOWNLOAD_DIRECTORY_UNWRITABLE')
    throw downloadError('DOWNLOAD_FAILED')
  } finally {
    if (stagingDirectory) await fs.rm(stagingDirectory, { recursive: true, force: true }).catch(() => undefined)
  }
}
