import { app } from 'electron'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { installManagedNode, installManagedPython, installManagedUv, runEnvironmentCommand as runCommand } from './environment-install.js'
import type { EnvironmentMode, EnvironmentTool, EnvironmentToolDefinition, EnvironmentToolName, EnvironmentToolProbe } from './types.js'

const MINIMUM_NODE_MAJOR_VERSION = 20
const systemPath = process.env.PATH ?? ''
const uvEnvironmentKeys = ['UV_CACHE_DIR', 'UV_PYTHON_INSTALL_DIR', 'UV_PYTHON_BIN_DIR'] as const
const systemUvEnvironment = Object.fromEntries(uvEnvironmentKeys.map(key => [key, process.env[key]]))
let environmentMode: EnvironmentMode = 'auto'
let environmentQueue: Promise<unknown> = Promise.resolve()

function queueEnvironment<T>(action: () => Promise<T>): Promise<T> {
  const task = environmentQueue.then(action)
  environmentQueue = task.catch(() => undefined)
  return task
}

function firstLine(value: string): string | undefined {
  return value.split(/\r?\n/).map(line => line.trim()).find(Boolean)
}

function environmentRoot(): string {
  return path.resolve(app.getPath('userData'), 'environments')
}

function isManagedPath(directory: string): boolean {
  const relative = path.relative(environmentRoot(), path.resolve(directory))
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
}

function globalEnvironment(): NodeJS.ProcessEnv {
  const env = { ...process.env }
  for (const key of Object.keys(env)) if (key.toUpperCase() === 'PATH') delete env[key]
  env.PATH = systemPath.split(path.delimiter).filter(entry => entry && !isManagedPath(entry)).join(path.delimiter)
  for (const key of uvEnvironmentKeys) {
    if (systemUvEnvironment[key] === undefined) delete env[key]
    else env[key] = systemUvEnvironment[key]
  }
  return env
}

async function findExecutablePath(probe: EnvironmentToolProbe, env: NodeJS.ProcessEnv): Promise<string | undefined> {
  if (probe.pathArgs) {
    try {
      const result = await runCommand(probe.command, probe.pathArgs, 8000, env)
      const executable = firstLine(result.stdout)
      if (executable) return executable
    } catch { /* Try the platform lookup. */ }
  }
  try {
    const lookup = await runCommand(process.platform === 'win32' ? 'where' : 'which', [probe.command], 8000, env)
    return firstLine(lookup.stdout)
  } catch {
    return undefined
  }
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

function validVersion(definition: EnvironmentToolDefinition, version: string | undefined): boolean {
  return definition.name !== 'Node.js' || Number(/^v?(\d+)/.exec(version ?? '')?.[1]) >= MINIMUM_NODE_MAJOR_VERSION
}

async function detectGlobalTool(definition: EnvironmentToolDefinition): Promise<EnvironmentTool | undefined> {
  const env = globalEnvironment()
  for (const probe of definition.probes) {
    try {
      const executable = await findExecutablePath(probe, env)
      if (executable && isManagedPath(executable)) continue
      const result = await runCommand(probe.command, probe.versionArgs, 8000, env)
      const version = firstLine(result.stdout) ?? firstLine(result.stderr)
      if (!validVersion(definition, version)) continue
      return { ...definitionFields(definition), installed: true, source: 'system', version, path: executable }
    } catch { /* Try another system command. */ }
  }
  if (process.platform !== 'darwin' || definition.name === 'uv') return undefined
  for (const version of [...definition.installVersions].reverse()) {
    try {
      const packageName = definition.name === 'Python' ? `python@${version}` : version === '22 LTS' ? 'node@22' : 'node@24'
      const prefix = (await runCommand('brew', ['--prefix', packageName], 8000, env)).stdout
      const executable = path.join(prefix, 'bin', definition.name === 'Python' ? `python${version}` : 'node')
      if (isManagedPath(executable)) continue
      const result = await runCommand(executable, ['--version'], 8000, env)
      const detectedVersion = firstLine(result.stdout) ?? firstLine(result.stderr)
      if (!validVersion(definition, detectedVersion)) continue
      return { ...definitionFields(definition), installed: true, source: 'system', version: detectedVersion, path: executable }
    } catch { /* Try another existing Homebrew formula. */ }
  }
  return undefined
}

function definitionFields(definition: EnvironmentToolDefinition) {
  return { name: definition.name, managedInstalled: false, installVersions: definition.installVersions, defaultInstallVersion: definition.defaultInstallVersion }
}

function managedToolRoot(name: EnvironmentToolName): string {
  return path.join(environmentRoot(), name === 'Python' ? 'python' : name === 'Node.js' ? 'node' : 'uv')
}

function managedToolDirectory(name: EnvironmentToolName, version?: string): string {
  const root = managedToolRoot(name)
  if (name === 'Python') return path.join(root, version ?? '3.11')
  if (name === 'Node.js') return path.join(root, version?.startsWith('22') ? '22' : version?.startsWith('24') ? '24' : 'lts')
  return root
}

async function detectManagedTool(definition: EnvironmentToolDefinition): Promise<EnvironmentTool | undefined> {
  const versions = definition.name === 'Python'
    ? [definition.defaultInstallVersion, ...definition.installVersions.filter(version => version !== definition.defaultInstallVersion).reverse()]
    : [...definition.installVersions].reverse()
  for (const version of versions) {
    const executable = path.join(managedToolDirectory(definition.name, version), definition.name === 'Python'
      ? process.platform === 'win32' ? 'python.exe' : 'bin/python3'
      : definition.name === 'Node.js' ? process.platform === 'win32' ? 'node.exe' : 'bin/node'
        : process.platform === 'win32' ? 'uv.exe' : 'uv')
    try {
      const result = await runCommand(executable, ['--version'])
      const detectedVersion = firstLine(result.stdout) ?? firstLine(result.stderr)
      if (!validVersion(definition, detectedVersion)) continue
      return { ...definitionFields(definition), installed: true, source: 'managed', version: detectedVersion, path: executable }
    } catch { /* A broken local runtime must not hide an available global runtime in auto mode. */ }
  }
  return undefined
}

async function selectTools(): Promise<EnvironmentTool[]> {
  return Promise.all(environmentToolDefinitions().map(async definition => {
    const managedInstalled = await fs.readdir(managedToolRoot(definition.name))
      .then(entries => entries.some(entry => !entry.startsWith('.')), () => false)
    const managed = environmentMode !== 'system' ? await detectManagedTool(definition) : undefined
    const selected = managed ?? (environmentMode !== 'managed' ? await detectGlobalTool(definition) : undefined)
    return { ...(selected ?? { ...definitionFields(definition), installed: false }), managedInstalled }
  }))
}

function applySelection(tools: EnvironmentTool[]): void {
  const env = globalEnvironment()
  const directories = tools.flatMap(tool => tool.path ? [path.dirname(tool.path),
    ...(tool.name === 'Python' && process.platform === 'win32' ? [path.join(path.dirname(tool.path), 'Scripts')] : [])] : [])
  process.env.PATH = [...new Set([...directories, ...((env.PATH ?? '').split(path.delimiter))])].filter(Boolean).join(path.delimiter)
  for (const key of uvEnvironmentKeys) {
    if (environmentMode !== 'system') {
      process.env[key] = path.join(environmentRoot(), key === 'UV_CACHE_DIR' ? 'cache/uv' : key === 'UV_PYTHON_INSTALL_DIR' ? 'uv-python' : 'uv-python-bin')
    } else if (env[key] === undefined) delete process.env[key]
    else process.env[key] = env[key]
  }
}

async function refreshSelection(): Promise<EnvironmentTool[]> {
  const tools = await selectTools()
  applySelection(tools)
  return tools
}

export async function initializeEnvironment(mode: EnvironmentMode = 'auto'): Promise<void> {
  await queueEnvironment(async () => { environmentMode = mode; await refreshSelection() })
}

export function checkEnvironment(): Promise<EnvironmentTool[]> {
  return queueEnvironment(refreshSelection)
}

export function resolveProjectEnvironment(): Promise<{ python?: string; uv?: string; env: NodeJS.ProcessEnv }> {
  return queueEnvironment(async () => {
    const tools = await refreshSelection()
    return { python: tools.find(tool => tool.name === 'Python')?.path, uv: tools.find(tool => tool.name === 'uv')?.path,
      env: { ...process.env, UV_PYTHON_DOWNLOADS: 'never' } }
  })
}

function toolDefinition(value: unknown): EnvironmentToolDefinition {
  const name = typeof value === 'object' && value !== null && 'name' in value ? value.name : undefined
  const definition = environmentToolDefinitions().find(item => item.name === name)
  if (!definition) throw new Error('ENVIRONMENT_INSTALL_INVALID')
  return definition
}

export async function installEnvironmentTool(value: unknown): Promise<EnvironmentTool> {
  const definition = toolDefinition(value)
  const version = (value as { version?: unknown }).version
  if (typeof version !== 'string' || !definition.installVersions.includes(version)) throw new Error('ENVIRONMENT_INSTALL_INVALID')
  return queueEnvironment(async () => {
    if (environmentMode === 'system') throw new Error('ENVIRONMENT_GLOBAL_INSTALL_UNSUPPORTED')
    const current = await detectManagedTool(definition)
    if (!current && environmentMode === 'auto' && await detectGlobalTool(definition)) return (await refreshSelection()).find(tool => tool.name === definition.name)!
    if (!current) {
      try {
        const destination = managedToolDirectory(definition.name, version)
        if (definition.name === 'Python') await installManagedPython(destination, version)
        else if (definition.name === 'uv') await installManagedUv(destination)
        else await installManagedNode(destination, version)
        if (!await detectManagedTool(definition)) throw new Error('ENVIRONMENT_VERIFY_FAILED')
      } catch (error) {
        const code = error instanceof Error ? error.message : ''
        if (['ENVIRONMENT_INSTALL_UNSUPPORTED', 'ENVIRONMENT_DOWNLOAD_FAILED', 'ENVIRONMENT_CHECKSUM_FAILED', 'ENVIRONMENT_VERIFY_FAILED'].includes(code)) throw error
        throw new Error('ENVIRONMENT_INSTALL_FAILED')
      }
    }
    return (await refreshSelection()).find(tool => tool.name === definition.name)!
  })
}

export async function uninstallEnvironmentTool(value: unknown): Promise<EnvironmentTool[]> {
  const definition = toolDefinition(value)
  return queueEnvironment(async () => {
    try {
      const root = environmentRoot()
      const target = path.resolve(managedToolRoot(definition.name))
      // Only fixed, direct children of the launcher-owned environment root can be removed.
      if (path.dirname(target) !== root || !isManagedPath(target)) throw new Error('ENVIRONMENT_UNINSTALL_FAILED')
      const rootStat = await fs.lstat(root).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw error; return undefined })
      const targetStat = await fs.lstat(target).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw error; return undefined })
      if (rootStat?.isSymbolicLink() || targetStat?.isSymbolicLink()) throw new Error('ENVIRONMENT_UNINSTALL_FAILED')
      if (targetStat) await fs.rm(target, { recursive: true, force: true })
      return await refreshSelection()
    } catch {
      await refreshSelection().catch(() => undefined)
      throw new Error('ENVIRONMENT_UNINSTALL_FAILED')
    }
  })
}
