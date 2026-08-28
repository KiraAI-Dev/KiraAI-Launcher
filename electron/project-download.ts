import { net } from 'electron'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { inflateRawSync } from 'node:zlib'
import { getLocalProject } from './local-project.js'
import { registerProject } from './project-store.js'
import type { StoredProject } from './types.js'

const KIRAAI_RELEASES_API_URL = 'https://api.github.com/repos/KiraAI-Dev/KiraAI/releases/latest'
const DOWNLOAD_TIMEOUT_MS = 5 * 60 * 1000
const MAX_ARCHIVE_SIZE = 512 * 1024 * 1024
const MAX_EXTRACTED_SIZE = 1024 * 1024 * 1024

function downloadError(code: string): Error {
  return new Error(code)
}

function isDownloadError(error: unknown): boolean {
  return error instanceof Error && ['DOWNLOAD_DIRECTORY_EXISTS', 'DOWNLOAD_DIRECTORY_UNWRITABLE', 'DOWNLOAD_ARCHIVE_INVALID', 'RELEASE_LOOKUP_FAILED', 'DOWNLOAD_FAILED'].includes(error.message)
}

function isPermissionError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && ((error as NodeJS.ErrnoException).code === 'EACCES' || (error as NodeJS.ErrnoException).code === 'EPERM')
}

async function fetchWithTimeout(url: string, timeoutMs: number, init?: RequestInit): Promise<Response> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await net.fetch(url, { ...init, signal: controller.signal })
  } finally {
    clearTimeout(timeout)
  }
}

async function getLatestReleaseArchiveUrl(): Promise<string> {
  try {
    const response = await fetchWithTimeout(KIRAAI_RELEASES_API_URL, 15_000, { headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'KiraAI-Launcher' } })
    if (!response.ok) throw new Error('HTTP_ERROR')
    const payload = await response.json() as { tag_name?: unknown }
    if (typeof payload.tag_name !== 'string' || !payload.tag_name.trim()) throw new Error('INVALID_RESPONSE')
    return `https://github.com/KiraAI-Dev/KiraAI/archive/refs/tags/${encodeURIComponent(payload.tag_name)}.zip`
  } catch {
    throw downloadError('RELEASE_LOOKUP_FAILED')
  }
}

async function downloadArchive(url: string, archivePath: string): Promise<void> {
  let response: Response
  try {
    response = await fetchWithTimeout(url, DOWNLOAD_TIMEOUT_MS, { headers: { Accept: 'application/zip', 'User-Agent': 'KiraAI-Launcher' } })
  } catch {
    throw downloadError('DOWNLOAD_FAILED')
  }
  if (!response.ok || !response.body) throw downloadError('DOWNLOAD_FAILED')
  const contentLength = Number(response.headers.get('content-length'))
  if (Number.isFinite(contentLength) && contentLength > MAX_ARCHIVE_SIZE) throw downloadError('DOWNLOAD_FAILED')
  const archive = await fs.open(archivePath, 'wx')
  let received = 0
  try {
    for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
      received += chunk.byteLength
      if (received > MAX_ARCHIVE_SIZE) throw downloadError('DOWNLOAD_FAILED')
      await archive.write(chunk)
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

async function extractReleaseArchive(archivePath: string, extractRoot: string): Promise<void> {
  const archive = await fs.readFile(archivePath)
  if (archive.length < 22 || archive.length > MAX_ARCHIVE_SIZE) archiveError()
  const eocdOffset = findEndOfCentralDirectory(archive)
  const entries = archive.readUInt16LE(eocdOffset + 10)
  const centralDirectoryOffset = archive.readUInt32LE(eocdOffset + 16)
  if (entries === 0xffff || centralDirectoryOffset === 0xffffffff || centralDirectoryOffset >= archive.length) archiveError()
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
  }
}

async function findReleaseProjectRoot(extractRoot: string): Promise<string> {
  const entries = await fs.readdir(extractRoot, { withFileTypes: true })
  return entries.length === 1 && entries[0].isDirectory() ? path.join(extractRoot, entries[0].name) : extractRoot
}

export async function downloadAndRegisterProject(parentPath: string, name: string): Promise<StoredProject> {
  const destination = path.resolve(parentPath, name)
  if (path.dirname(destination) !== path.resolve(parentPath)) throw downloadError('DOWNLOAD_DIRECTORY_INVALID')
  const destinationExists = await fs.stat(destination).then(() => true, (error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return false
    throw error
  })
  if (destinationExists) {
    try {
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
    await downloadArchive(await getLatestReleaseArchiveUrl(), archivePath)
    await fs.mkdir(extractRoot)
    await extractReleaseArchive(archivePath, extractRoot)
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
