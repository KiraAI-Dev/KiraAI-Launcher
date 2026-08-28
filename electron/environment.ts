import { execFile } from 'node:child_process'
import path from 'node:path'
import type { EnvironmentTool, EnvironmentToolDefinition, EnvironmentToolName, EnvironmentToolProbe } from './types.js'

const ENVIRONMENT_INSTALL_TIMEOUT_MS = 10 * 60 * 1000
const MINIMUM_NODE_MAJOR_VERSION = 20

function runCommand(command: string, args: string[], timeout = 8000): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(command, args, { windowsHide: true, timeout }, (error, stdout, stderr) => {
      if (error) reject(error)
      else resolve({ stdout: stdout.trim(), stderr: stderr.trim() })
    })
  })
}

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
  for (const probe of definition.probes) {
    try {
      const versionResult = await runCommand(probe.command, probe.versionArgs)
      const version = firstLine(versionResult.stdout) ?? firstLine(versionResult.stderr)
      if (definition.name === 'Node.js' && !hasSupportedNodeVersion(version)) continue
      return { name: definition.name, installed: true, version, path: await findExecutablePath(probe), installVersions: definition.installVersions, defaultInstallVersion: definition.defaultInstallVersion }
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
    { name: 'Python', probes: pythonProbes, installVersions: ['3.10', '3.11', '3.12'], defaultInstallVersion: '3.11' },
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
      return { name: definition.name, installed: true, version: detectedVersion, path: executable, installVersions: definition.installVersions, defaultInstallVersion: definition.defaultInstallVersion }
    } catch {
      // Try another versioned Homebrew formula.
    }
  }
  return undefined
}

function environmentInstallCommand(name: EnvironmentToolName, version: string): { command: string; args: string[] } {
  if (process.platform === 'win32') {
    const packageId = name === 'Python' ? `Python.Python.${version}` : name === 'uv' ? 'astral-sh.uv' : 'OpenJS.NodeJS.LTS'
    return { command: 'winget', args: ['install', '--id', packageId, '--exact', '--accept-package-agreements', '--accept-source-agreements', '--disable-interactivity'] }
  }
  if (process.platform === 'darwin') return { command: 'brew', args: ['install', macOSPackageName(name, version)] }
  if (process.platform === 'linux') {
    if (name === 'Node.js') throw new Error('ENVIRONMENT_INSTALL_UNSUPPORTED')
    return { command: 'pkexec', args: ['apt-get', 'install', '--yes', name === 'Python' ? `python${version}` : 'uv'] }
  }
  throw new Error('ENVIRONMENT_INSTALL_UNSUPPORTED')
}

export async function checkEnvironment(): Promise<EnvironmentTool[]> {
  return Promise.all(environmentToolDefinitions().map(detectTool))
}

export async function installEnvironmentTool(value: unknown): Promise<EnvironmentTool> {
  if (typeof value !== 'object' || value === null) throw new Error('ENVIRONMENT_INSTALL_INVALID')
  const { name, version } = value as { name?: unknown; version?: unknown }
  if (typeof name !== 'string' || typeof version !== 'string') throw new Error('ENVIRONMENT_INSTALL_INVALID')
  const definition = environmentToolDefinitions().find((item) => item.name === name)
  if (!definition || !definition.installVersions.includes(version)) throw new Error('ENVIRONMENT_INSTALL_INVALID')
  const currentTool = await detectTool(definition)
  if (currentTool.installed) return currentTool
  try {
    const command = environmentInstallCommand(definition.name, version)
    await runCommand(command.command, command.args, ENVIRONMENT_INSTALL_TIMEOUT_MS)
  } catch (error) {
    if (error instanceof Error && error.message === 'ENVIRONMENT_INSTALL_UNSUPPORTED') throw error
    throw new Error('ENVIRONMENT_INSTALL_FAILED')
  }
  const installedTool = await detectTool(definition)
  if (!installedTool.installed) throw new Error('ENVIRONMENT_INSTALL_FAILED')
  return installedTool
}
