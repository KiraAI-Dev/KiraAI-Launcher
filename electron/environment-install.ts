import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { fetchWithTimeout } from './http.js'

const INSTALL_TIMEOUT_MS = 10 * 60 * 1000
const MAX_DOWNLOAD_BYTES = 150 * 1024 * 1024

export function runEnvironmentCommand(command: string, args: string[], timeout = 8000, env = process.env): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(command, args, { windowsHide: true, timeout, env }, (error, stdout, stderr) => {
      if (error) reject(error)
      else resolve({ stdout: stdout.trim(), stderr: stderr.trim() })
    })
  })
}

function powershell(): string {
  return path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
}

async function download(url: string, destination: string, limit = MAX_DOWNLOAD_BYTES): Promise<string> {
  try {
    return await fetchWithTimeout(url, INSTALL_TIMEOUT_MS, undefined, async (response) => {
      if (!response.ok || !response.body) throw new Error('ENVIRONMENT_DOWNLOAD_FAILED')
      const handle = await fs.open(destination, 'wx')
      const hash = createHash('sha256')
      const reader = response.body.getReader()
      let received = 0
      try {
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          received += value.byteLength
          if (received > limit) throw new Error('ENVIRONMENT_DOWNLOAD_FAILED')
          hash.update(value)
          // FileHandle.write may write fewer bytes than requested.
          let offset = 0
          while (offset < value.byteLength) {
            const { bytesWritten } = await handle.write(value, offset, value.byteLength - offset)
            if (!bytesWritten) throw new Error('ENVIRONMENT_DOWNLOAD_FAILED')
            offset += bytesWritten
          }
        }
        if (!received) throw new Error('ENVIRONMENT_DOWNLOAD_FAILED')
        return hash.digest('hex')
      } finally {
        await reader.cancel().catch(() => undefined)
        await handle.close()
      }
    })
  } catch {
    throw new Error('ENVIRONMENT_DOWNLOAD_FAILED')
  }
}

async function downloadText(url: string): Promise<string> {
  return fetchWithTimeout(url, 30_000, undefined, async (response) => {
    if (!response.ok) throw new Error('ENVIRONMENT_DOWNLOAD_FAILED')
    return response.text()
  }).catch(() => { throw new Error('ENVIRONMENT_DOWNLOAD_FAILED') })
}

/** Publish only a verified runtime; keep a previous runtime until replacement succeeds. */
async function stageRuntime(destination: string, install: (staging: string) => Promise<string>, executable: string): Promise<void> {
  const parent = path.dirname(destination)
  await fs.mkdir(parent, { recursive: true })
  const staging = await fs.mkdtemp(path.join(parent, '.install-'))
  const backup = path.join(staging, 'previous')
  let previous = false
  let keepBackup = false
  try {
    const source = await install(staging)
    try {
      await runEnvironmentCommand(path.join(source, executable), ['--version'])
    } catch {
      throw new Error('ENVIRONMENT_VERIFY_FAILED')
    }
    try {
      await fs.rename(destination, backup)
      previous = true
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    try {
      await fs.rename(source, destination)
    } catch (error) {
      if (previous) {
        keepBackup = true
        await fs.rename(backup, destination)
        keepBackup = false
      }
      throw error
    }
  } finally {
    if (!keepBackup) await fs.rm(staging, { recursive: true, force: true }).catch(() => undefined)
  }
}

async function extractArchive(archive: string, extracted: string): Promise<void> {
  await fs.mkdir(extracted)
  if (archive.endsWith('.zip')) {
    // Pass paths as data, so spaces, apostrophes and shell metacharacters remain literal.
    await runEnvironmentCommand(powershell(), ['-NoProfile', '-NonInteractive', '-Command',
      '$ErrorActionPreference = "Stop"; Expand-Archive -LiteralPath $env:KIRA_RUNTIME_ARCHIVE -DestinationPath $env:KIRA_RUNTIME_EXTRACT'],
    INSTALL_TIMEOUT_MS, { ...process.env, KIRA_RUNTIME_ARCHIVE: archive, KIRA_RUNTIME_EXTRACT: extracted })
  } else {
    await runEnvironmentCommand(tar(), ['-xzf', archive, '-C', extracted], INSTALL_TIMEOUT_MS)
  }
}

export async function installManagedUv(destination: string): Promise<void> {
  if (!['win32', 'darwin', 'linux'].includes(process.platform) || !['x64', 'arm64'].includes(process.arch)) {
    throw new Error('ENVIRONMENT_INSTALL_UNSUPPORTED')
  }
  const architecture = process.arch === 'arm64' ? 'aarch64' : 'x86_64'
  const target = `${architecture}-${process.platform === 'win32' ? 'pc-windows-msvc' : process.platform === 'darwin' ? 'apple-darwin' : 'unknown-linux-gnu'}`
  const archiveName = `uv-${target}.${process.platform === 'win32' ? 'zip' : 'tar.gz'}`
  const url = `https://github.com/astral-sh/uv/releases/latest/download/${archiveName}`
  const checksum = (await downloadText(`${url}.sha256`)).trim().split(/\s+/)[0]
  if (!/^[a-f\d]{64}$/i.test(checksum)) throw new Error('ENVIRONMENT_DOWNLOAD_FAILED')
  await stageRuntime(destination, async (staging) => {
    const archive = path.join(staging, archiveName)
    if (await download(url, archive) !== checksum.toLowerCase()) throw new Error('ENVIRONMENT_CHECKSUM_FAILED')
    const extracted = path.join(staging, 'extracted')
    await extractArchive(archive, extracted)
    return process.platform === 'win32' ? extracted : path.join(extracted, `uv-${target}`)
  }, process.platform === 'win32' ? 'uv.exe' : 'uv')
}

export async function installManagedNode(destination: string, requestedVersion: string): Promise<void> {
  if (!['win32', 'darwin', 'linux'].includes(process.platform) || !['x64', 'arm64'].includes(process.arch)) {
    throw new Error('ENVIRONMENT_INSTALL_UNSUPPORTED')
  }
  const releases: unknown = JSON.parse(await downloadText('https://nodejs.org/dist/index.json'))
  if (!Array.isArray(releases)) throw new Error('ENVIRONMENT_DOWNLOAD_FAILED')
  const major = requestedVersion === '22 LTS' ? 22 : requestedVersion === '24 LTS' ? 24 : undefined
  const release = releases.find((item) => typeof item?.version === 'string' && /^v\d+\.\d+\.\d+$/.test(item.version)
    && item.lts && Number(item.version.split('.')[0].slice(1)) >= 20
    && (major === undefined || item.version.startsWith(`v${major}.`)))
  if (!release) throw new Error('ENVIRONMENT_INSTALL_UNSUPPORTED')
  const platform = process.platform === 'win32' ? 'win' : process.platform
  const archiveName = `node-${release.version}-${platform}-${process.arch}.${process.platform === 'win32' ? 'zip' : 'tar.gz'}`
  const baseUrl = `https://nodejs.org/dist/${release.version}`
  const checksums = await downloadText(`${baseUrl}/SHASUMS256.txt`)
  const checksum = checksums.split(/\r?\n/).map((line) => line.trim().split(/\s+/)).find((parts) => parts[1] === archiveName)?.[0]
  if (!checksum || !/^[a-f\d]{64}$/i.test(checksum)) throw new Error('ENVIRONMENT_DOWNLOAD_FAILED')
  await stageRuntime(destination, async (staging) => {
    const archive = path.join(staging, archiveName)
    const actualChecksum = await download(`${baseUrl}/${archiveName}`, archive)
    if (actualChecksum !== checksum.toLowerCase()) throw new Error('ENVIRONMENT_CHECKSUM_FAILED')
    const extracted = path.join(staging, 'extracted')
    await extractArchive(archive, extracted)
    return path.join(extracted, `node-${release.version}-${platform}-${process.arch}`)
  }, process.platform === 'win32' ? 'node.exe' : 'bin/node')
}

function tar(): string {
  return process.platform === 'win32' ? path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe') : '/usr/bin/tar'
}

/** Install a complete, independent CPython distribution; uv is never invoked. */
export async function installManagedPython(destination: string, version: string): Promise<void> {
  if (!['win32', 'darwin', 'linux'].includes(process.platform) || !['x64', 'arm64'].includes(process.arch)) {
    throw new Error('ENVIRONMENT_INSTALL_UNSUPPORTED')
  }
  const architecture = process.arch === 'arm64' ? 'aarch64' : 'x86_64'
  const target = process.platform === 'win32' ? 'pc-windows-msvc' : process.platform === 'darwin' ? 'apple-darwin' : 'unknown-linux-gnu'
  const checksums = await downloadText(`https://github.com/astral-sh/python-build-standalone/releases/latest/download/SHA256SUMS`)
  const suffix = `-${architecture}-${target}-install_only_stripped.tar.gz`
  const entry = checksums.split(/\r?\n/).map((line) => line.trim().split(/\s+/))
    .find((parts) => /^[a-f\d]{64}$/i.test(parts[0]) && parts[1]?.startsWith(`cpython-${version}.`) && parts[1].endsWith(suffix))
  if (!entry) throw new Error('ENVIRONMENT_INSTALL_UNSUPPORTED')
  const [checksum, archiveName] = entry
  const match = /^cpython-(3\.\d+\.\d+)\+(\d{8})-/.exec(archiveName)
  if (!match || !/^[a-zA-Z\d_.+-]+$/.test(archiveName)) throw new Error('ENVIRONMENT_DOWNLOAD_FAILED')
  const baseUrl = `https://github.com/astral-sh/python-build-standalone/releases/download/${match[2]}`
  await stageRuntime(destination, async (staging) => {
    const archive = path.join(staging, archiveName)
    if (await download(`${baseUrl}/${archiveName}`, archive) !== checksum.toLowerCase()) throw new Error('ENVIRONMENT_CHECKSUM_FAILED')
    const extracted = path.join(staging, 'extracted')
    await extractArchive(archive, extracted)
    const runtime = path.join(extracted, 'python')
    await runEnvironmentCommand(path.join(runtime, process.platform === 'win32' ? 'python.exe' : 'bin/python3'),
      ['-I', '-c', 'import ensurepip, ssl, venv'])
    return runtime
  }, process.platform === 'win32' ? 'python.exe' : 'bin/python3')
}
