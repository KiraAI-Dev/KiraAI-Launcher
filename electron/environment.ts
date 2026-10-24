import { app } from 'electron'
import path from 'node:path'
import { installManagedNode, installManagedPython, installManagedUv, runEnvironmentCommand as runCommand } from './environment-install.js'
import type { EnvironmentTool, EnvironmentToolDefinition, EnvironmentToolName, EnvironmentToolProbe } from './types.js'

const MINIMUM_NODE_MAJOR_VERSION = 20
let installationQueue: Promise<unknown> = Promise.resolve()

function firstLine(value: string): string | undefined {
  return value.split(/\r?\n/).map((line) => line.trim()).find(Boolean)
}

async function findExecutablePath(probe: EnvironmentToolProbe): Promise<string | undefined> {
  if (probe.pathArgs) {
    try {
      const result = await runCommand(probe.command, probe.pathArgs)
      const executablePath = firstLine(result.stdout)
      if (executablePath) return executablePath
    } catch {
      // Fall back to the platform command lookup below.
    }
  }
  try {
    const lookup = await runCommand(process.platform === 'win32' ? 'where' : 'which', [probe.command])
    return firstLine(lookup.stdout)
  } catch {
    return undefined
  }
}

async function detectTool(definition: EnvironmentToolDefinition): Promise<EnvironmentTool> {
  const managed = await detectManagedTool(definition)
  if (managed) return managed
  for (const probe of definition.probes) {
    try {
      const versionResult = await runCommand(probe.command, probe.versionArgs)
      const version = firstLine(versionResult.stdout) ?? firstLine(versionResult.stderr)
      if (definition.name === 'Node.js' && !hasSupportedNodeVersion(version)) continue
      return { name: definition.name, installed: true, source: 'system', version, path: await findExecutablePath(probe), installVersions: definition.installVersions, defaultInstallVersion: definition.defaultInstallVersion }
    } catch {
      // Keep trying alternate commands, such as the Windows Python Launcher.
    }
  }
  const homebrewTool = await detectHomebrewTool(definition)
  if (homebrewTool) return homebrewTool
  return { name: definition.name, installed: false, installVersions: definition.installVersions, defaultInstallVersion: definition.defaultInstallVersion }
}

export function environmentToolDefinitions(): EnvironmentToolDefinition[] {
  const pythonProbes: EnvironmentToolProbe[] = process.platform === 'win32'
    ? [{ command: 'python', versionArgs: ['--version'], pathArgs: ['-c', 'import sys; print(sys.executable)'] }, { command: 'py', versionArgs: ['-3', '--version'], pathArgs: ['-3', '-c', 'import sys; print(sys.executable)'] }]
    : [{ command: 'python3', versionArgs: ['--version'], pathArgs: ['-c', 'import sys; print(sys.executable)'] }, { command: 'python', versionArgs: ['--version'], pathArgs: ['-c', 'import sys; print(sys.executable)'] }]
  const nodeInstallVersions = process.platform === 'darwin' ? ['22 LTS', '24 LTS'] : ['LTS']
  return [
    { name: 'Python', probes: pythonProbes, installVersions: ['3.11', '3.12'], defaultInstallVersion: '3.11' },
    { name: 'uv', probes: [{ command: 'uv', versionArgs: ['--version'] }], installVersions: ['latest'], defaultInstallVersion: 'latest' },
    { name: 'Node.js', probes: [{ command: 'node', versionArgs: ['--version'], pathArgs: ['-p', 'process.execPath'] }], installVersions: nodeInstallVersions, defaultInstallVersion: nodeInstallVersions.at(-1) ?? 'LTS' },
  ]
}

function hasSupportedNodeVersion(version: string | undefined): boolean {
  const majorVersion = /^v?(\d+)/.exec(version ?? '')?.[1]
  return typeof majorVersion === 'string' && Number(majorVersion) >= MINIMUM_NODE_MAJOR_VERSION
}

function macOSPackageName(name: EnvironmentToolName, version: string): string {
  if (name === 'Python') return `python@${version}`
  if (name === 'uv') return 'uv'
  return version === '22 LTS' ? 'node@22' : 'node@24'
}

function prependProcessPath(directory: string): void {
  const currentPath = process.env.PATH ?? ''
  const entries = currentPath.split(path.delimiter).filter(Boolean)
  if (entries.includes(directory)) return
  process.env.PATH = [directory, ...entries].join(path.delimiter)
}

async function detectHomebrewTool(definition: EnvironmentToolDefinition): Promise<EnvironmentTool | undefined> {
  if (process.platform !== 'darwin' || (definition.name !== 'Python' && definition.name !== 'Node.js')) return undefined
  for (const version of [...definition.installVersions].reverse()) {
    try {
      const packageName = macOSPackageName(definition.name, version)
      const prefix = (await runCommand('brew', ['--prefix', packageName])).stdout
      const executable = path.join(prefix, 'bin', definition.name === 'Python' ? `python${version}` : 'node')
      const versionResult = await runCommand(executable, ['--version'])
      const detectedVersion = firstLine(versionResult.stdout) ?? firstLine(versionResult.stderr)
      if (definition.name === 'Node.js' && !hasSupportedNodeVersion(detectedVersion)) continue
      prependProcessPath(definition.name === 'Python' ? path.join(prefix, 'libexec', 'bin') : path.join(prefix, 'bin'))
      return { name: definition.name, installed: true, source: 'system', version: detectedVersion, path: executable, installVersions: definition.installVersions, defaultInstallVersion: definition.defaultInstallVersion }
    } catch {
      // Try another versioned Homebrew formula.
    }
  }
  return undefined
}

function environmentRoot(): string {
  return path.join(app.getPath('userData'), 'environments')
}

function managedToolDirectory(name: EnvironmentToolName, version?: string): string {
  const root = environmentRoot()
  if (name === 'Python') return path.join(root, 'python', version ?? '3.11')
  if (name === 'Node.js') return path.join(root, 'node', version?.startsWith('22') ? '22' : version?.startsWith('24') ? '24' : 'lts')
  return path.join(root, 'uv')
}

function managedProbes(definition: EnvironmentToolDefinition): EnvironmentToolProbe[] {
  const windows = process.platform === 'win32'
  if (definition.name === 'uv') return [{ command: path.join(managedToolDirectory('uv'), windows ? 'uv.exe' : 'uv'), versionArgs: ['--version'] }]
  const versions = definition.name === 'Python'
    ? [definition.defaultInstallVersion, ...definition.installVersions.filter((version) => version !== definition.defaultInstallVersion).reverse()]
    : [...definition.installVersions].reverse()
  return versions.map((version) => ({
    command: path.join(managedToolDirectory(definition.name, version), definition.name === 'Python'
      ? windows ? 'python.exe' : 'bin/python3'
      : windows ? 'node.exe' : 'bin/node'),
    versionArgs: ['--version'],
  }))
}

async function detectManagedTool(definition: EnvironmentToolDefinition): Promise<EnvironmentTool | undefined> {
  for (const probe of managedProbes(definition)) {
    try {
      const result = await runCommand(probe.command, probe.versionArgs)
      const version = firstLine(result.stdout) ?? firstLine(result.stderr)
      if (definition.name === 'Node.js' && !hasSupportedNodeVersion(version)) continue
      prependProcessPath(path.dirname(probe.command))
      if (definition.name === 'Python' && process.platform === 'win32') prependProcessPath(path.join(path.dirname(probe.command), 'Scripts'))
      return { name: definition.name, installed: true, source: 'managed', version, path: probe.command, installVersions: definition.installVersions, defaultInstallVersion: definition.defaultInstallVersion }
    } catch {
      // A missing or broken managed runtime must not hide an existing system installation.
    }
  }
  return undefined
}

/** Restore launcher-local command paths before automatic project restoration. */
export async function initializeEnvironment(): Promise<void> {
  const root = environmentRoot()
  process.env.UV_CACHE_DIR = path.join(root, 'cache', 'uv')
  // uv may download Python while creating project venvs. Keep those separate from the Environment page's Python.
  process.env.UV_PYTHON_INSTALL_DIR = path.join(root, 'uv-python')
  process.env.UV_PYTHON_BIN_DIR = path.join(root, 'uv-python-bin')
  for (const definition of environmentToolDefinitions()) await detectManagedTool(definition)
}

export async function checkEnvironment(): Promise<EnvironmentTool[]> {
  return Promise.all(environmentToolDefinitions().map(detectTool))
}

async function installTool(definition: EnvironmentToolDefinition, version: string): Promise<EnvironmentTool> {
  const currentTool = await detectTool(definition)
  if (currentTool.installed) return currentTool
  try {
    const destination = managedToolDirectory(definition.name, version)
    if (definition.name === 'Python') await installManagedPython(destination, version)
    else if (definition.name === 'uv') await installManagedUv(destination)
    else await installManagedNode(destination, version)
    const installedTool = await detectManagedTool(definition)
    if (!installedTool) throw new Error('ENVIRONMENT_VERIFY_FAILED')
    return installedTool
  } catch (error) {
    const code = error instanceof Error ? error.message : ''
    if (['ENVIRONMENT_INSTALL_UNSUPPORTED', 'ENVIRONMENT_DOWNLOAD_FAILED', 'ENVIRONMENT_CHECKSUM_FAILED', 'ENVIRONMENT_VERIFY_FAILED'].includes(code)) throw error
    throw new Error('ENVIRONMENT_INSTALL_FAILED')
  }
}

export async function installEnvironmentTool(value: unknown): Promise<EnvironmentTool> {
  if (typeof value !== 'object' || value === null) throw new Error('ENVIRONMENT_INSTALL_INVALID')
  const { name, version } = value as { name?: unknown; version?: unknown }
  if (typeof name !== 'string' || typeof version !== 'string') throw new Error('ENVIRONMENT_INSTALL_INVALID')
  const definition = environmentToolDefinitions().find((item) => item.name === name)
  if (!definition || !definition.installVersions.includes(version)) throw new Error('ENVIRONMENT_INSTALL_INVALID')
  const task = installationQueue.then(() => installTool(definition, version))
  installationQueue = task.catch(() => undefined)
  return task
}
