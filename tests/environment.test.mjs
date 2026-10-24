import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync, promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import vm from 'node:vm'
import test from 'node:test'
import ts from 'typescript'

function load(file, dependencies, globals) {
  const source = readFileSync(new URL('../' + file, import.meta.url), 'utf8')
  const { outputText } = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } })
  const exports = {}
  vm.runInNewContext(outputText, { exports, require: id => {
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
    electron: { app: { getPath: () => root } }, 'node:path': path, './environment-install.js': installer,
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
  assert.ok(f.commands.every(item => !/^(uv|winget|brew|pkexec|apt-get)$/.test(item.command)))
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
