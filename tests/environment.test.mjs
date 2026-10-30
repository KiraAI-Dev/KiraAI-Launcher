import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { readFileSync, promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import vm from 'node:vm'
import test from 'node:test'
import ts from 'typescript'

function load(file, dependencies, globals, names) {
  let source = readFileSync(new URL('../' + file, import.meta.url), 'utf8')
  if (file.endsWith('.vue')) source = source.split('<script setup lang="ts">')[1].split('</script>')[0]
  if (names) {
    const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true)
    source = ast.statements.filter(node => ts.isFunctionDeclaration(node) && names.includes(node.name?.text)).map(node => node.getText(ast)).join('\n') + '\nexport { ' + names.join(', ') + ' }'
  }
  const { outputText } = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } })
  const exports = {}
  vm.runInNewContext(outputText, { exports, require: id => {
    if (id === './environment-variables.js') return load('electron/environment-variables.ts', {}, {})
    assert.ok(id in dependencies, 'Unexpected dependency: ' + id)
    return dependencies[id]
  }, Error, ...globals })
  return exports
}

async function fixture(t, { platform = 'win32', arch = 'x64', pythonVersion = '3.11' } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'kira-env-test-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const requests = [], commands = []
  const state = { corrupt: false, downloadFailed: false, verifyFailed: false, extractFailed: false, systemUv: false, homebrew: false }
  const env = { PATH: '/existing/system', SystemRoot: 'C:\\Windows' }
  const payload = Buffer.from('verified test runtime archive')
  const checksum = createHash('sha256').update(payload).digest('hex')
  const windows = platform === 'win32'
  const nodeName = `node-v24.10.0-${windows ? 'win' : platform}-${arch}.${windows ? 'zip' : 'tar.gz'}`
  const pythonName = `cpython-${pythonVersion}.17+20261021-${arch === 'arm64' ? 'aarch64' : 'x86_64'}-${windows ? 'pc-windows-msvc' : platform === 'darwin' ? 'apple-darwin' : 'unknown-linux-gnu'}-install_only_stripped.tar.gz`
  async function executable(file) {
    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.writeFile(file, 'test runtime')
  }
  async function exec(command, args, options) {
    commands.push({ command, args: [...args], env: { ...options.env } })
    if (args.includes('-Command') || args[0] === '-xzf') {
      if (state.extractFailed) throw new Error('private extraction failure')
      const archive = options.env.KIRA_RUNTIME_ARCHIVE ?? args[1]
      const extracted = options.env.KIRA_RUNTIME_EXTRACT ?? args[3]
      if (archive.includes('uv-')) {
        const uvRoot = windows ? extracted : path.join(extracted, path.basename(archive).replace(/\.tar\.gz$/, ''))
        await executable(path.join(uvRoot, windows ? 'uv.exe' : 'uv'))
      } else if (archive.includes('cpython-')) {
        await executable(path.join(extracted, 'python', windows ? 'python.exe' : 'bin/python3'))
      } else {
        await executable(path.join(extracted, nodeName.replace(/\.(zip|tar.gz)$/, ''), windows ? 'node.exe' : 'bin/node'))
      }
      return ''
    }
    if (!path.isAbsolute(command)) {
      if (command === 'brew' && state.homebrew) return path.join(root, 'homebrew', args[1])
      if (command === 'uv' && state.systemUv) return 'uv 0.13.5'
      if ((command === 'where' || command === 'which') && state.systemUv && args[0] === 'uv') return '/system/uv'
      throw new Error('not installed')
    }
    await fs.access(command)
    if (state.verifyFailed) throw new Error('private runtime failure')
    return command.includes('python') ? 'Python ' + pythonVersion + '.17' : command.includes('node') ? 'v24.10.0' : 'uv 0.13.5'
  }
  const installer = load('electron/environment-install.ts', {
    'node:child_process': { execFile: (command, args, options, callback) => {
      exec(command, args, options).then(stdout => callback(null, stdout, ''), error => callback(error, '', 'private stderr'))
    } },
    'node:crypto': { createHash }, 'node:fs': { promises: fs }, 'node:path': path,
    './http.js': { fetchWithTimeout: async (url, timeout, init, read) => {
      requests.push({ url, timeout })
      if (state.downloadFailed) throw new Error('private proxy credentials')
      let body
      if (url.endsWith('index.json')) body = JSON.stringify([{ version: 'v26.0.0', lts: false }, { version: 'v24.10.0', lts: 'Krypton' }])
      else if (url.endsWith('.sha256')) body = checksum
      else if (url.endsWith('SHASUMS256.txt')) body = `${checksum}  ${nodeName}\n`
      else if (url.endsWith('SHA256SUMS')) body = `${checksum}  ${pythonName}\n`
      else body = state.corrupt ? Buffer.from('corrupted') : payload
      return read(new Response(body))
    } },
  }, { process: { platform, arch, env } })
  const environment = load('electron/environment.ts', {
    electron: { app: { getPath: () => root } }, 'node:path': path, 'node:fs': { promises: fs }, './environment-install.js': installer,
  }, { process: { platform, arch, env } })
  return { root, env, requests, commands, state, installer, environment }
}

test('Python installs independently without uv or a system package manager and survives a fresh environment check', async t => {
  const f = await fixture(t)
  await f.environment.initializeEnvironment()
  const result = await f.environment.installEnvironmentTool({ name: 'Python', version: '3.11' })
  assert.equal(result.installed, true)
  assert.equal(result.source, 'managed')
  assert.equal(result.path, path.join(f.root, 'environments', 'python', '3.11', 'python.exe'))
  assert.ok(f.requests.every(item => item.url.includes('python-build-standalone')))
  assert.ok(f.commands.every(item => !/^(winget|brew|pkexec|apt-get)$/.test(item.command) && (item.command !== 'uv' || item.args[0] === '--version')))
  assert.ok(f.commands.some(item => item.args.includes('import ensurepip, ssl, venv')))
  assert.equal((await f.environment.checkEnvironment()).find(item => item.name === 'uv').installed, false)
  f.env.PATH = '/existing/system'
  await f.environment.initializeEnvironment()
  assert.ok(f.env.PATH.split(path.delimiter).includes(path.dirname(result.path)))
  assert.equal((await f.environment.checkEnvironment())[0].path, result.path)
})

test('uv installs locally without winget and immediately becomes available to child processes', async t => {
  const f = await fixture(t)
  const result = await f.environment.installEnvironmentTool({ name: 'uv', version: 'latest' })
  assert.equal(result.path, path.join(f.root, 'environments', 'uv', 'uv.exe'))
  assert.equal(result.source, 'managed')
  assert.ok(f.requests.some(item => item.url.endsWith('uv-x86_64-pc-windows-msvc.zip.sha256')))
  assert.equal(f.env.PATH.split(path.delimiter)[0], path.dirname(result.path))
  assert.ok(!f.commands.some(item => item.command === 'winget'))
  assert.deepEqual((await fs.readdir(path.join(f.root, 'environments'))).filter(name => name.startsWith('.install-')), [])
})

test('existing system installations remain usable and do not trigger downloads', async t => {
  const f = await fixture(t)
  f.state.systemUv = true
  const result = await f.environment.installEnvironmentTool({ name: 'uv', version: 'latest' })
  assert.equal(result.path, '/system/uv')
  assert.equal(result.source, 'system')
  assert.equal(f.requests.length, 0)
})

test('managed tools take precedence over existing system installations', async t => {
  const f = await fixture(t)
  const managed = await f.environment.installEnvironmentTool({ name: 'uv', version: 'latest' })
  f.state.systemUv = true
  const result = (await f.environment.checkEnvironment()).find(item => item.name === 'uv')
  assert.equal(result.path, managed.path)
  assert.equal(result.source, 'managed')
})

test('Windows Node uses the official LTS ZIP, validates it, and passes special paths as environment data', async t => {
  const f = await fixture(t)
  const result = await f.environment.installEnvironmentTool({ name: 'Node.js', version: 'LTS' })
  assert.equal(result.path, path.join(f.root, 'environments', 'node', 'lts', 'node.exe'))
  assert.ok(f.requests.some(item => item.url === 'https://nodejs.org/dist/v24.10.0/node-v24.10.0-win-x64.zip'))
  const extraction = f.commands.find(item => item.args.includes('-Command'))
  assert.ok(extraction.args.at(-1).includes('-LiteralPath $env:KIRA_RUNTIME_ARCHIVE'))
  assert.ok(!extraction.args.at(-1).includes(f.root))
})

test('checksum failures never extract or publish, expose a safe error, and can be retried', async t => {
  const f = await fixture(t)
  f.state.corrupt = true
  await assert.rejects(f.environment.installEnvironmentTool({ name: 'Node.js', version: 'LTS' }), /ENVIRONMENT_CHECKSUM_FAILED/)
  assert.ok(!f.commands.some(item => item.args.includes('-Command')))
  assert.equal((await f.environment.checkEnvironment()).find(item => item.name === 'Node.js').installed, false)
  f.state.corrupt = false
  assert.equal((await f.environment.installEnvironmentTool({ name: 'Node.js', version: 'LTS' })).installed, true)
})

test('download failures are sanitized and a subsequent installation can proceed', async t => {
  const f = await fixture(t)
  f.state.downloadFailed = true
  await assert.rejects(f.environment.installEnvironmentTool({ name: 'uv', version: 'latest' }), error => error.message === 'ENVIRONMENT_DOWNLOAD_FAILED')
  f.state.downloadFailed = false
  assert.equal((await f.environment.installEnvironmentTool({ name: 'uv', version: 'latest' })).installed, true)
})

test('an unusable downloaded runtime is never published', async t => {
  const f = await fixture(t)
  f.state.verifyFailed = true
  await assert.rejects(f.environment.installEnvironmentTool({ name: 'uv', version: 'latest' }), /ENVIRONMENT_VERIFY_FAILED/)
  await assert.rejects(fs.access(path.join(f.root, 'environments', 'uv')))
  assert.ok(!(await fs.readdir(path.join(f.root, 'environments'))).some(name => name.startsWith('.install-')))
})

test('failed extraction preserves a previous runtime', async t => {
  const f = await fixture(t)
  const destination = path.join(f.root, 'environments', 'node', 'lts')
  await fs.mkdir(destination, { recursive: true })
  await fs.writeFile(path.join(destination, 'keep.txt'), 'previous runtime')
  f.state.extractFailed = true
  await assert.rejects(f.installer.installManagedNode(destination, 'LTS'))
  assert.equal(await fs.readFile(path.join(destination, 'keep.txt'), 'utf8'), 'previous runtime')
})

test('simultaneous installation requests share the first successfully published runtime', async t => {
  const f = await fixture(t)
  const [first, second] = await Promise.all([1, 2].map(() => f.environment.installEnvironmentTool({ name: 'uv', version: 'latest' })))
  assert.equal(first.path, second.path)
  assert.equal(f.requests.filter(item => item.url.endsWith('uv-x86_64-pc-windows-msvc.zip')).length, 1)
})

for (const platform of ['darwin', 'linux']) {
  test(`${platform} arm64 downloads the matching independent Python and Node archives`, async t => {
    const f = await fixture(t, { platform, arch: 'arm64' })
    assert.equal((await f.environment.installEnvironmentTool({ name: 'Python', version: '3.11' })).installed, true)
    assert.equal((await f.environment.installEnvironmentTool({ name: 'Node.js', version: platform === 'darwin' ? '24 LTS' : 'LTS' })).installed, true)
    assert.ok(f.requests.some(item => item.url.includes(platform === 'darwin' ? 'aarch64-apple-darwin' : 'aarch64-unknown-linux-gnu')))
    assert.ok(f.requests.some(item => item.url.includes(`-${platform}-arm64.tar.gz`)))
  })
}

test('invalid requests and unsupported architectures fail before downloading', async t => {
  const f = await fixture(t, { arch: 'ia32' })
  await assert.rejects(f.environment.installEnvironmentTool({ name: 'Python', version: '../outside' }), /ENVIRONMENT_INSTALL_INVALID/)
  await assert.rejects(f.environment.installEnvironmentTool({ name: 'Python', version: '3.10' }), /ENVIRONMENT_INSTALL_INVALID/)
  await assert.rejects(f.environment.installEnvironmentTool({ name: 'uv', version: 'latest' }), /ENVIRONMENT_INSTALL_UNSUPPORTED/)
  assert.equal(f.requests.length, 0)
})

for (const pythonVersion of ['3.12']) {
  test(`Python ${pythonVersion} retains its versioned independent installation directory`, async t => {
    const f = await fixture(t, { pythonVersion })
    const installed = await f.environment.installEnvironmentTool({ name: 'Python', version: pythonVersion })
    assert.equal(installed.path, path.join(f.root, 'environments', 'python', pythonVersion, 'python.exe'))
    assert.ok(installed.version.startsWith('Python ' + pythonVersion + '.'))
    assert.ok(f.requests.some(item => item.url.includes('/latest/download/SHA256SUMS')))
  })
}

test('Homebrew environments are labeled system and missing tools have no source', async t => {
  const f = await fixture(t, { platform: 'darwin' })
  f.state.homebrew = true
  const executable = path.join(f.root, 'homebrew', 'python@3.12', 'bin', 'python3.12')
  await fs.mkdir(path.dirname(executable), { recursive: true })
  await fs.writeFile(executable, 'existing Homebrew Python')
  const tools = await f.environment.checkEnvironment()
  const python = tools.find(tool => tool.name === 'Python')
  assert.equal(python.source, 'system')
  assert.equal(python.path, executable)
  const uv = tools.find(tool => tool.name === 'uv')
  assert.equal(uv.installed, false)
  assert.equal(uv.source, undefined)
})

test('automatic selection is per tool, and global mode excludes launcher paths and restores UV variables', async t => {
  const f = await fixture(t)
  await f.environment.installEnvironmentTool({ name: 'uv', version: 'latest' })
  f.state.systemUv = true
  await f.environment.initializeEnvironment('auto')
  let tools = await f.environment.checkEnvironment()
  assert.equal(tools.find(tool => tool.name === 'uv').source, 'managed')
  await f.environment.initializeEnvironment('system')
  tools = await f.environment.checkEnvironment()
  assert.equal(tools.find(tool => tool.name === 'uv').source, 'system')
  assert.equal(tools.find(tool => tool.name === 'uv').managedInstalled, true)
  assert.ok(!f.env.PATH.includes(path.join(f.root, 'environments')))
  assert.equal(f.env.UV_PYTHON_INSTALL_DIR, undefined)
  assert.ok(f.commands.filter(item => item.command === 'uv').every(item => !item.env.PATH.includes(path.join(f.root, 'environments'))))
  await f.environment.initializeEnvironment('managed')
  assert.equal((await f.environment.checkEnvironment()).find(tool => tool.name === 'uv').source, 'managed')
  assert.equal(f.env.UV_PYTHON_INSTALL_DIR, path.join(f.root, 'environments', 'uv-python'))
})

test('launcher mode never uses global tools and can install its own copy alongside them', async t => {
  const f = await fixture(t)
  f.state.systemUv = true
  await f.environment.initializeEnvironment('managed')
  let uv = (await f.environment.checkEnvironment()).find(tool => tool.name === 'uv')
  assert.equal(uv.installed, false)
  assert.equal((await f.environment.resolveProjectEnvironment()).uv, undefined)
  uv = await f.environment.installEnvironmentTool({ name: 'uv', version: 'latest' })
  assert.equal(uv.source, 'managed')
  assert.equal(uv.managedInstalled, true)
})

test('global mode never uses a launcher copy or installs a new tool', async t => {
  const f = await fixture(t)
  await f.environment.installEnvironmentTool({ name: 'uv', version: 'latest' })
  const previousRequests = f.requests.length
  await f.environment.initializeEnvironment('system')
  const uv = (await f.environment.checkEnvironment()).find(tool => tool.name === 'uv')
  assert.equal(uv.installed, false)
  assert.equal(uv.managedInstalled, true)
  assert.equal((await f.environment.resolveProjectEnvironment()).uv, undefined)
  await assert.rejects(f.environment.installEnvironmentTool({ name: 'uv', version: 'latest' }), /ENVIRONMENT_GLOBAL_INSTALL_UNSUPPORTED/)
  assert.equal(f.requests.length, previousRequests)
})

test('auto mode can mix a managed Python and global uv in one deployment snapshot', async t => {
  const f = await fixture(t)
  await f.environment.installEnvironmentTool({ name: 'Python', version: '3.11' })
  f.state.systemUv = true
  const runtime = await f.environment.resolveProjectEnvironment()
  assert.equal(runtime.python, path.join(f.root, 'environments', 'python', '3.11', 'python.exe'))
  assert.equal(runtime.uv, '/system/uv')
  assert.equal(runtime.env.UV_PYTHON_DOWNLOADS, 'never')
  await f.environment.initializeEnvironment('system')
  assert.ok(runtime.env.PATH.includes(path.join(f.root, 'environments', 'python', '3.11')))
})

test('uninstall deletes only the named managed tool and auto mode falls back to a global copy', async t => {
  const f = await fixture(t)
  await f.environment.installEnvironmentTool({ name: 'Python', version: '3.11' })
  const uv = await f.environment.installEnvironmentTool({ name: 'uv', version: 'latest' })
  const globalFile = path.join(f.root, 'global-tool.txt')
  const projectFile = path.join(f.root, 'project', 'venv', 'keep.txt')
  await fs.writeFile(globalFile, 'global tool')
  await fs.mkdir(path.dirname(projectFile), { recursive: true })
  await fs.writeFile(projectFile, 'project virtual environment')
  f.state.systemUv = true
  const result = await f.environment.uninstallEnvironmentTool({ name: 'uv', path: globalFile })
  const selected = result.find(tool => tool.name === 'uv')
  assert.equal(selected.source, 'system')
  assert.equal(selected.managedInstalled, false)
  await assert.rejects(fs.access(uv.path))
  assert.equal(await fs.readFile(globalFile, 'utf8'), 'global tool')
  assert.equal(await fs.readFile(projectFile, 'utf8'), 'project virtual environment')
  assert.equal(result.find(tool => tool.name === 'Python').source, 'managed')
  assert.ok(!f.env.PATH.split(path.delimiter).includes(path.dirname(uv.path)))
})

test('uninstall removes all managed Python versions, remains missing in managed mode, and permits reinstall', async t => {
  const f = await fixture(t)
  await f.environment.initializeEnvironment('managed')
  await f.environment.installEnvironmentTool({ name: 'Python', version: '3.11' })
  const other = path.join(f.root, 'environments', 'python', '3.12')
  await fs.mkdir(other, { recursive: true })
  await fs.writeFile(path.join(other, 'python.exe'), 'another managed version')
  const result = await f.environment.uninstallEnvironmentTool({ name: 'Python' })
  assert.equal(result.find(tool => tool.name === 'Python').installed, false)
  await assert.rejects(fs.access(other))
  assert.equal((await f.environment.installEnvironmentTool({ name: 'Python', version: '3.11' })).source, 'managed')
})

test('uninstall rejects arbitrary names and refuses junctions outside the managed root', async t => {
  const f = await fixture(t)
  await assert.rejects(f.environment.uninstallEnvironmentTool({ name: '../outside' }), /ENVIRONMENT_INSTALL_INVALID/)
  const external = path.join(f.root, 'external')
  const target = path.join(f.root, 'environments', 'uv')
  await fs.mkdir(external)
  await fs.writeFile(path.join(external, 'keep.txt'), 'untouched')
  await fs.mkdir(path.dirname(target))
  await fs.symlink(external, target, 'junction')
  await assert.rejects(f.environment.uninstallEnvironmentTool({ name: 'uv' }), /ENVIRONMENT_UNINSTALL_FAILED/)
  assert.equal(await fs.readFile(path.join(external, 'keep.txt'), 'utf8'), 'untouched')
})

test('install and uninstall are serialized so a queued removal cannot be undone by a late install', async t => {
  const f = await fixture(t)
  await Promise.all([
    f.environment.installEnvironmentTool({ name: 'uv', version: 'latest' }),
    f.environment.uninstallEnvironmentTool({ name: 'uv' }),
  ])
  assert.equal((await f.environment.checkEnvironment()).find(tool => tool.name === 'uv').managedInstalled, false)
})

test('environment mode defaults to auto, rejects invalid settings, and persists all choices', async t => {
  const f = await fixture(t)
  const settings = load('electron/settings.ts', { electron: { app: { getPath: () => f.root } }, 'node:fs': { promises: fs }, 'node:path': path }, {})
  assert.equal(settings.sanitizeSettings({}).environmentMode, 'auto')
  assert.equal(settings.sanitizeSettings({ environmentMode: 'invalid' }).environmentMode, 'auto')
  for (const environmentMode of ['auto', 'system', 'managed']) {
    await settings.saveSettings({ environmentMode })
    assert.equal((await settings.loadSettings()).environmentMode, environmentMode)
  }
})

test('runtime uninstall refuses active deployments, blocks new starts until complete, and releases the guard on failure', async () => {
  let finish
  const running = new Map([['project', {}]])
  const globals = {
    environmentUninstalling: false, launchedProjects: running, startingProjects: new Map(), stoppingLocalProjects: false,
    uninstallEnvironmentTool: () => new Promise(resolve => { finish = resolve }),
  }
  const api = load('electron/main.ts', {}, globals, ['uninstallLauncherEnvironment', 'startLocalProject'])
  await assert.rejects(api.uninstallLauncherEnvironment({ name: 'Python' }), /ENVIRONMENT_IN_USE/)
  running.clear()
  const pending = api.uninstallLauncherEnvironment({ name: 'Python' })
  await assert.rejects(api.startLocalProject('project', () => {}), /ENVIRONMENT_IN_USE/)
  finish([])
  await pending
  const failure = load('electron/main.ts', {}, { ...globals, uninstallEnvironmentTool: async () => { throw new Error('ENVIRONMENT_UNINSTALL_FAILED') } }, ['uninstallLauncherEnvironment'])
  await assert.rejects(failure.uninstallLauncherEnvironment({ name: 'Python' }), /ENVIRONMENT_UNINSTALL_FAILED/)
  // A second attempt reaches the backend again instead of being trapped by the busy flag.
  await assert.rejects(failure.uninstallLauncherEnvironment({ name: 'Python' }), /ENVIRONMENT_UNINSTALL_FAILED/)
})

test('project virtual environments are reused only with the selected Python base', async () => {
  for (const [existing, selected, expected] of [['/managed/python', '/managed/python', true], ['/managed/python', '/system/python', false]]) {
    const environments = []
    const api = load('electron/main.ts', {}, {
      fs: { access: async () => {} }, path, process: { platform: 'linux' },
      runCommand: async (command, args, timeout, env) => { environments.push(env); return { stdout: command === '/venv/python' ? existing : selected } },
    }, ['projectVenvMatchesPython'])
    const env = { PATH: '/chosen/bin' }
    assert.equal(await api.projectVenvMatchesPython('/venv/python', '/selected/python', env), expected)
    assert.ok(environments.every(value => value === env))
  }
})

test('saving a mode applies it before persistence and restores the previous mode when persistence fails', async () => {
  for (const diskFails of [false, true]) {
    const events = []
    const api = load('electron/main.ts', {}, {
      currentSettings: { environmentMode: 'auto', launchAtLogin: false }, sanitizeSettings: value => value,
      initializeEnvironment: async mode => events.push(mode),
      saveSettings: async value => { events.push('persist'); if (diskFails) throw new Error('private disk error'); return value },
      applyLauncherUpdateSettings: () => {}, updateTrayMenu: () => {},
    }, ['saveLauncherSettings'])
    const pending = api.saveLauncherSettings({ environmentMode: 'managed', launchAtLogin: false })
    if (diskFails) {
      await assert.rejects(pending, /SETTINGS_SAVE_FAILED/)
      assert.deepEqual(events, ['managed', 'persist', 'auto'])
    } else {
      assert.equal((await pending).environmentMode, 'managed')
      assert.deepEqual(events, ['managed', 'persist'])
    }
  }
})

test('missing selected Python cannot silently use an existing project venv from another source', async () => {
  const api = load('electron/main.ts', {}, {
    launchedProjects: new Map(), loadProjects: async () => [{ id: 'local', name: 'Project', type: 'local', projectPath: '/project' }],
    writeLauncherLog: () => {}, getLocalProject: async () => ({ port: 5267 }), getLocalWebuiUrl: () => '', ensureLocalPortAvailable: async () => {},
    path, process: { platform: 'linux' }, DEFAULT_PYTHON_PACKAGE_INDEX_URL: 'https://pypi.org/simple/', selectFastestPackageIndex: async () => undefined,
    resolveProjectEnvironment: async () => ({ python: undefined, uv: undefined, env: {} }),
  }, ['launchLocalProject'])
  await assert.rejects(api.launchLocalProject('local', () => {}), /PYTHON_UNAVAILABLE/)
})

test('venv creation and dependency installation use the selected executable paths and a single environment snapshot', async () => {
  for (const uv of ['/selected/uv', undefined]) {
    const commands = []
    const env = { PATH: '/selected/bin', UV_PYTHON_DOWNLOADS: 'never' }
    const api = load('electron/main.ts', {}, {
      launchedProjects: new Map(), loadProjects: async () => [{ id: 'local', name: 'Project', type: 'local', projectPath: '/project' }],
      writeLauncherLog: () => {}, getLocalProject: async () => ({ port: 5267 }), getLocalWebuiUrl: () => '', ensureLocalPortAvailable: async () => {},
      path: path.posix, process: { platform: 'linux' }, selectFastestPackageIndex: async () => 'https://pypi.org/simple/',
      resolveProjectEnvironment: async () => ({ python: '/selected/python', uv, env }), projectVenvMatchesPython: async () => false,
      runProjectCommand: async (command, args, cwd, error, childEnv) => {
        commands.push({ command, args: [...args], env: childEnv })
        if (args.includes('pip')) throw new Error('STOP_AFTER_SETUP')
      },
    }, ['launchLocalProject'])
    await assert.rejects(api.launchLocalProject('local', () => {}), /STOP_AFTER_SETUP/)
    assert.equal(commands[0].command, uv ?? '/selected/python')
    assert.ok(commands[0].args.includes('--clear'))
    if (uv) {
      assert.equal(commands[0].args[commands[0].args.indexOf('--python') + 1], '/selected/python')
      assert.ok(commands[0].args.includes('--no-python-downloads'))
    }
    assert.ok(commands.every(command => command.env === env))
  }
})

for (const [name, version, directory] of [['Python', '3.11', 'python'], ['Node.js', 'LTS', 'node']]) {
  for (const failure of ['corrupt', 'extractFailed', 'verifyFailed']) {
    test(`${name} ${failure} does not expose uninstall for the empty parent left after installation fails`, async t => {
      const f = await fixture(t)
      f.state[failure] = true
      await assert.rejects(f.environment.installEnvironmentTool({ name, version }))
      assert.deepEqual(await fs.readdir(path.join(f.root, 'environments', directory)), [])
      const tool = (await f.environment.checkEnvironment()).find(item => item.name === name)
      assert.equal(tool.installed, false)
      assert.equal(tool.managedInstalled, false)
    })
  }
}

test('empty and staging-only roots are not managed installations, while broken installed content can still be removed', async t => {
  const f = await fixture(t)
  const root = path.join(f.root, 'environments', 'python')
  await fs.mkdir(root, { recursive: true })
  assert.equal((await f.environment.checkEnvironment())[0].managedInstalled, false)
  await fs.mkdir(path.join(root, '.install-incomplete'))
  assert.equal((await f.environment.checkEnvironment())[0].managedInstalled, false)
  await fs.mkdir(path.join(root, '3.11'))
  await fs.writeFile(path.join(root, '3.11', 'damaged-runtime.txt'), 'broken installation')
  const python = (await f.environment.checkEnvironment())[0]
  assert.equal(python.installed, false)
  assert.equal(python.managedInstalled, true)
  assert.equal((await f.environment.uninstallEnvironmentTool({ name: 'Python' }))[0].managedInstalled, false)
})

async function stoppingProjectFixture() {
  const child = Object.assign(new EventEmitter(), { pid: 123, exitCode: null, signalCode: null })
  const running = new Map(), timers = new Map()
  const state = { graceful: true, forceFails: false, forceStops: 0, uninstalls: 0 }
  const api = load('electron/main.ts', {}, {
    environmentUninstalling: false, stoppingLocalProjects: false, launchedProjects: running, startingProjects: new Map(), pendingProjectRestores: new Set(),
    path: path.posix, process: { platform: 'win32', cwd: () => '/launcher' },
    loadProjects: async () => [{ id: 'project', name: 'Project', type: 'local', projectPath: '/project' }],
    getLocalProject: async () => ({ port: 5267 }), getLocalWebuiUrl: () => 'http://localhost:5267',
    writeLauncherLog: () => {}, publishProjectChange: () => {}, ensureLocalPortAvailable: async () => {},
    selectFastestPackageIndex: async () => 'https://pypi.org/simple/',
    resolveProjectEnvironment: async () => ({ python: '/managed/python', env: {} }), projectVenvMatchesPython: async () => true,
    currentSettings: { environmentVariables: {} }, mergeEnvironmentVariables: load('electron/environment-variables.ts', {}, { process }).mergeEnvironmentVariables,
    spawn: () => child, waitForSpawn: async () => {}, waitForLocalWebui: async () => {},
    requestGracefulLocalShutdown: async () => state.graceful,
    LOCAL_GRACEFUL_SHUTDOWN_TIMEOUT_MS: 100, LOCAL_FORCE_STOP_TIMEOUT_MS: 50,
    setTimeout: callback => { const token = {}; timers.set(token, callback); return token }, clearTimeout: token => timers.delete(token),
    runProjectCommand: async command => {
      if (command !== 'taskkill') return
      state.forceStops++
      if (state.forceFails) {
        child.emit('error', new Error('termination failed'))
        throw new Error('LOCAL_STOP_FAILED')
      }
    },
    uninstallEnvironmentTool: async () => { state.uninstalls++; return [] },
  }, ['launchLocalProject', 'stopLocalProject', 'waitForProcessExit', 'uninstallLauncherEnvironment'])
  await api.launchLocalProject('project', () => {})
  return { api, child, running, timers, state, exit() { child.exitCode = 0; child.emit('exit', 0, null) } }
}

test('runtime uninstall stays blocked from the first stop await through actual graceful process exit', async () => {
  const f = await stoppingProjectFixture()
  const stop = f.api.stopLocalProject('project')
  await assert.rejects(f.api.uninstallLauncherEnvironment({ name: 'Python' }), /ENVIRONMENT_IN_USE/)
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(f.timers.size, 1)
  assert.equal(f.running.has('project'), true)
  await assert.rejects(f.api.uninstallLauncherEnvironment({ name: 'Python' }), /ENVIRONMENT_IN_USE/)
  assert.equal(f.state.uninstalls, 0)
  f.exit()
  await stop
  await f.api.uninstallLauncherEnvironment({ name: 'Python' })
  assert.equal(f.state.uninstalls, 1)
  assert.equal(f.running.size, 0)
  assert.equal(f.timers.size, 0)
})

test('a failed termination keeps the live process in use until a later exit', async () => {
  const f = await stoppingProjectFixture()
  f.state.graceful = false
  f.state.forceFails = true
  await assert.rejects(f.api.stopLocalProject('project'), /LOCAL_STOP_FAILED/)
  assert.equal(f.running.has('project'), true)
  await assert.rejects(f.api.uninstallLauncherEnvironment({ name: 'Python' }), /ENVIRONMENT_IN_USE/)
  await assert.rejects(f.api.stopLocalProject('project'), /LOCAL_STOP_FAILED/)
  await assert.rejects(f.api.uninstallLauncherEnvironment({ name: 'Python' }), /ENVIRONMENT_IN_USE/)
  f.exit()
  await f.api.uninstallLauncherEnvironment({ name: 'Python' })
  assert.equal(f.state.uninstalls, 1)
})

test('graceful and forced stop timeouts keep runtime removal blocked until the process exits', async () => {
  const f = await stoppingProjectFixture()
  const stop = f.api.stopLocalProject('project')
  const failed = assert.rejects(stop, /LOCAL_STOP_TIMEOUT/)
  await new Promise(resolve => setImmediate(resolve))
  f.timers.values().next().value()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(f.state.forceStops, 1)
  f.timers.values().next().value()
  await failed
  assert.equal(f.running.has('project'), true)
  await assert.rejects(f.api.uninstallLauncherEnvironment({ name: 'Python' }), /ENVIRONMENT_IN_USE/)
  f.exit()
  await f.api.uninstallLauncherEnvironment({ name: 'Python' })
  assert.equal(f.state.uninstalls, 1)
})

test('a signal exit before shutdown reaches its wait does not leave the stop pending', async () => {
  const f = await stoppingProjectFixture()
  const stop = f.api.stopLocalProject('project')
  f.child.signalCode = 'SIGTERM'
  f.child.emit('exit', null, 'SIGTERM')
  await stop
  assert.equal(f.timers.size, 0)
  assert.equal(f.state.forceStops, 0)
  await f.api.uninstallLauncherEnvironment({ name: 'Python' })
  assert.equal(f.state.uninstalls, 1)
})
