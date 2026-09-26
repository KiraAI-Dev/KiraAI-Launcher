import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import vm from 'node:vm'
import test from 'node:test'
import ts from 'typescript'

function loadSource(file, dependencies = {}, globals = {}, names) {
  let source = readFileSync(new URL('../' + file, import.meta.url), 'utf8')
  if (file.endsWith('.vue')) source = source.split('<script setup lang="ts">')[1].split('</script>')[0]
  if (names) {
    const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true)
    source = ast.statements.filter((node) => ts.isFunctionDeclaration(node) && names.includes(node.name?.text))
      .map((node) => node.getText(ast)).join('\n') + '\nexport { ' + names.join(', ') + ' }'
  }
  const { outputText } = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } })
  const exports = {}
  vm.runInNewContext(outputText, { exports, require: (id) => {
    assert.ok(id in dependencies, 'Unexpected dependency: ' + id)
    return dependencies[id]
  }, Buffer, Response, URL, AbortController, setTimeout, clearTimeout, ...globals })
  return exports
}

function archiveFixture() {
  const members = ['release/main.py', 'release/requirements.txt']
  const files = [], headers = []
  let offset = 0
  for (const member of members) {
    const name = Buffer.from(member), data = Buffer.from('test')
    const file = Buffer.alloc(30)
    file.writeUInt32LE(0x04034b50)
    file.writeUInt16LE(name.length, 26)
    files.push(file, name, data)
    const header = Buffer.alloc(46)
    header.writeUInt32LE(0x02014b50)
    header.writeUInt32LE(data.length, 20)
    header.writeUInt32LE(data.length, 24)
    header.writeUInt16LE(name.length, 28)
    header.writeUInt32LE(offset, 42)
    headers.push(header, name)
    offset += file.length + name.length + data.length
  }
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50)
  end.writeUInt16LE(members.length, 10)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...files, ...headers, end])
}

function downloadFixture({ knownSize = true, corrupt = false, existing = false, failFetch = false, rateLimited = false } = {}) {
  const archive = corrupt ? Buffer.from('invalid') : archiveFixture()
  const events = [], removed = [], writes = []
  let registered = false, fetched = false
  const fs = {
    stat: async () => { if (!existing) throw Object.assign(new Error(), { code: 'ENOENT' }); return {} },
    mkdtemp: async () => '/parent/staging',
    open: async () => ({ write: async (chunk) => writes.push(chunk.length), close: async () => {} }),
    mkdir: async () => {}, readFile: async () => archive, writeFile: async () => {},
    readdir: async () => [{ name: 'release', isDirectory: () => true }],
    rename: async () => {}, rm: async (target) => removed.push(target),
  }
  const { downloadAndRegisterProject } = loadSource('electron/project-download.ts', {
    electron: { net: { fetch: async (url) => {
      fetched = true
      if (failFetch) throw new Error('network')
      if (rateLimited) return new Response('', { status: 403, headers: { 'x-ratelimit-remaining': '0' } })
      if (url.includes('/releases/latest')) return Response.json({ tag_name: 'v1' })
      const body = new ReadableStream({ start(controller) {
        controller.enqueue(archive.subarray(0, 20)); controller.enqueue(archive.subarray(20)); controller.close()
      } })
      return new Response(body, { headers: knownSize ? { 'content-length': String(archive.length) } : {} })
    } } },
    'node:fs': { promises: fs }, 'node:path': path.posix, 'node:zlib': {},
    './local-project.js': { getLocalProject: async () => ({ type: 'local' }) },
    './project-store.js': { registerProject: async (project) => { registered = true; return project } },
  })
  return { events, removed, writes, archive, run: () => downloadAndRegisterProject('/parent', 'instance', (event) => events.push(event)),
    registered: () => registered, fetched: () => fetched }
}

test('download reports bytes, extraction entries, and registration in order', async () => {
  const fixture = downloadFixture()
  await fixture.run()
  assert.deepEqual([...new Set(fixture.events.map((event) => event.stage))], ['directory', 'release', 'download', 'extract', 'register'])
  const downloaded = fixture.events.filter((event) => event.stage === 'download').at(-1)
  assert.equal(downloaded.completed, fixture.archive.length)
  assert.equal(downloaded.total, fixture.archive.length)
  const extracted = fixture.events.filter((event) => event.stage === 'extract').at(-1)
  assert.equal(extracted.completed, 2)
  assert.equal(extracted.total, 2)
  assert.equal(fixture.registered(), true)
  assert.deepEqual(fixture.removed, ['/parent/staging'])
})

test('unknown download size keeps the total undefined while reporting received bytes', async () => {
  const fixture = downloadFixture({ knownSize: false })
  await fixture.run()
  const downloaded = fixture.events.filter((event) => event.stage === 'download').at(-1)
  assert.equal(downloaded.total, undefined)
  assert.equal(downloaded.completed, fixture.archive.length)
})

test('invalid archive retains extraction stage and cleans staging without registering', async () => {
  const fixture = downloadFixture({ corrupt: true })
  await assert.rejects(fixture.run(), /DOWNLOAD_ARCHIVE_INVALID/)
  assert.equal(fixture.events.at(-1).stage, 'extract')
  assert.equal(fixture.registered(), false)
  assert.deepEqual(fixture.removed, ['/parent/staging'])
})

test('release lookup failure retains release stage', async () => {
  const fixture = downloadFixture({ failFetch: true })
  await assert.rejects(fixture.run(), /RELEASE_LOOKUP_FAILED/)
  assert.equal(fixture.events.at(-1).stage, 'release')
  assert.equal(fixture.registered(), false)
})

test('existing local project is registered without downloading again', async () => {
  const fixture = downloadFixture({ existing: true })
  await fixture.run()
  assert.deepEqual(fixture.events.map((event) => event.stage), ['directory', 'register'])
  assert.equal(fixture.fetched(), false)
  assert.equal(fixture.registered(), true)
})

function deploymentFixture(failDependencies = false) {
  const events = [], commands = []
  let healthResolve
  const health = new Promise((resolve) => { healthResolve = resolve })
  const { startLocalProject } = loadSource('electron/main.ts', {}, {
    launchedProjects: new Map(), loadProjects: async () => [{ id: 'local', name: 'Test', type: 'local', projectPath: '/project' }],
    writeLauncherLog: () => {}, getLocalProject: async () => ({ port: 5267 }),
    getLocalWebuiUrl: () => 'http://localhost:5267', ensureLocalPortAvailable: async () => {},
    path: path.posix, process: { platform: 'linux', env: {} }, fs: { access: async () => {} },
    selectFastestPackageIndex: async () => 'https://pypi.org/simple/', hasUv: async () => true,
    runProjectCommand: async (_command, args) => { commands.push(args); if (failDependencies) throw new Error('DEPENDENCY_INSTALL_FAILED') },
    spawn: () => new EventEmitter(), waitForSpawn: async () => {}, waitForLocalWebui: () => health,
  }, ['startLocalProject'])
  return { events, commands, healthResolve, run: () => startLocalProject('local', (event) => events.push(event)) }
}

test('deployment reports setup steps and waits for readiness before resolving', async () => {
  const fixture = deploymentFixture()
  let finished = false
  const pending = fixture.run().then(() => { finished = true })
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(fixture.events.map((event) => event.stage), ['validate', 'packageIndex', 'venv', 'dependencies', 'launch', 'health'])
  assert.equal(finished, false)
  assert.equal(fixture.commands.length, 2)
  fixture.healthResolve()
  await pending
  assert.equal(finished, true)
})

test('dependency failure stops before process launch and preserves failed stage', async () => {
  const fixture = deploymentFixture(true)
  await assert.rejects(fixture.run(), /DEPENDENCY_INSTALL_FAILED/)
  assert.equal(fixture.events.at(-1).stage, 'dependencies')
})

test('IPC reporter throttles updates but always sends stage changes and final counts', () => {
  let now = 1000
  const sent = []
  let destroyed = false
  const { createProjectProgressReporter } = loadSource('electron/main.ts', {}, { Date: { now: () => now } }, ['createProjectProgressReporter'])
  const report = createProjectProgressReporter({ sender: { isDestroyed: () => destroyed, send: (channel, data) => sent.push({ channel, data }) } }, 'request')
  report({ stage: 'download', completed: 0 })
  report({ stage: 'download', completed: 10 })
  now += 100
  report({ stage: 'download', completed: 20, total: 30 })
  report({ stage: 'download', completed: 30, total: 30 })
  report({ stage: 'extract' })
  destroyed = true
  report({ stage: 'register' })
  assert.equal(sent.length, 4)
  assert.ok(sent.every(({ channel, data }) => channel === 'projects:progress' && data.requestId === 'request'))
})

test('renderer filters stale events, resets retries, and removes listeners after success and failure', async () => {
  const { projectOperationSteps } = loadSource('electron/types.ts')
  const progressStatus = { value: 'error' }, operationProgress = { value: null }
  let listener, removed = 0, sequence = 0
  const { trackProjectOperation } = loadSource('src/App.vue', {}, {
    projectOperationSteps, progressStatus, operationProgress, progressOperation: { value: 'download' },
    crypto: { randomUUID: () => String(++sequence) }, removeProjectProgressListener: undefined,
    requireLauncherBridge: () => ({ projects: { onProgress: (callback) => { listener = callback; return () => { removed++ } } } }),
  }, ['trackProjectOperation'])
  await trackProjectOperation('download', async (requestId) => {
    listener({ requestId: 'old', stage: 'extract' })
    assert.equal(operationProgress.value.stage, 'directory')
    listener({ requestId, stage: 'download', completed: 5 })
  })
  assert.equal(progressStatus.value, 'success')
  assert.equal(removed, 1)
  await assert.rejects(trackProjectOperation('deploy', async () => {
    assert.equal(progressStatus.value, 'running')
    assert.equal(operationProgress.value.stage, 'validate')
    throw new Error('failure')
  }), /failure/)
  assert.equal(progressStatus.value, 'error')
  assert.equal(removed, 2)
})

test('all locale keys and placeholders stay aligned', () => {
  const locales = loadSource('src/i18n/messages.ts')
  function flatten(value, prefix = '') {
    return Object.entries(value).flatMap(([key, item]) => typeof item === 'string'
      ? [[prefix + key, [...item.matchAll(/\{([^}]+)\}/g)].map((match) => match[1]).sort().join(',')]]
      : flatten(item, prefix + key + '.')).sort(([a], [b]) => a.localeCompare(b))
  }
  for (const table of Object.values(locales)) {
    if (table['zh-CN'] && table['en-US']) assert.deepEqual(flatten(table['zh-CN']), flatten(table['en-US']))
  }
})
test('renderer localizes IPC-wrapped errors without exposing unknown error text', () => {
  const { getErrorMessage } = loadSource('src/App.vue', {}, {
    t: { value: { operationFailed: 'generic failure' } },
    environmentActionsText: { value: { errors: {} } }, projectSettingsErrors: { value: {} },
    localizedErrors: { value: { DEPENDENCY_INSTALL_FAILED: 'dependency failure' } },
  }, ['getErrorMessage'])
  assert.equal(getErrorMessage({ message: "Error invoking remote method 'projects:start': Error: DEPENDENCY_INSTALL_FAILED" }), 'dependency failure')
  assert.equal(getErrorMessage({ message: 'DEPENDENCY_INSTALL_FAILED' }), 'dependency failure')
  assert.equal(getErrorMessage({ message: 'Unknown private details' }), 'generic failure')
})

function releaseLookupFixture(apiResponse, pageUrl = 'https://github.com/xxynet/KiraAI/releases/tag/v2.34.7', pageStatus = 302, redirects) {
  const requests = []
  const request = new EventEmitter()
  const targets = redirects ?? ['https://github.com/xxynet/KiraAI/releases/latest', pageUrl]
  let aborted = false
  const send = () => queueMicrotask(() => {
    if (aborted) return
    if (pageStatus === 302) request.emit('redirect', 302, 'GET', targets.shift() ?? pageUrl, {})
    else request.emit('response', new EventEmitter())
  })
  request.setHeader = () => {}
  request.abort = () => { aborted = true; request.emit('close') }
  // Electron 33 can close the request's writable stream before network redirects.
  request.end = () => { request.emit('close'); send() }
  request.followRedirect = send
  const { getLatestReleaseArchiveUrl } = loadSource('electron/project-download.ts', {}, {
    KIRAAI_RELEASES_API_URL: 'https://api.github.com/repos/KiraAI-Dev/KiraAI/releases/latest',
    net: { request: (options) => {
      assert.equal(options.redirect, 'manual')
      requests.push(options.url)
      return request
    } },
    fetchWithTimeout: async (url) => {
      requests.push(url)
      if (apiResponse instanceof Error) throw apiResponse
      return apiResponse
    },
  }, ['getLatestReleaseArchiveUrl', 'getReleasePageArchiveUrl', 'downloadError'])
  return { run: getLatestReleaseArchiveUrl, requests, aborted: () => aborted }
}

test('successful release API lookup does not request the fallback page', async () => {
  const fixture = releaseLookupFixture(Response.json({ tag_name: 'v3/preview' }))
  assert.equal(await fixture.run(), 'https://github.com/KiraAI-Dev/KiraAI/archive/refs/tags/v3%2Fpreview.zip')
  assert.equal(fixture.requests.length, 1)
})

test('API rate limit falls back to the canonical release page after repository transfer', async () => {
  const fixture = releaseLookupFixture(new Response('', { status: 403, headers: { 'x-ratelimit-remaining': '0' } }))
  assert.equal(await fixture.run(), 'https://github.com/xxynet/KiraAI/archive/refs/tags/v2.34.7.zip')
  assert.equal(fixture.requests.length, 2)
  assert.equal(fixture.aborted(), true)
})

test('API connection errors and invalid payloads can use the official release page', async () => {
  for (const response of [new Error('timeout'), Response.json({}), new Response('invalid json')]) {
    const fixture = releaseLookupFixture(response, 'https://github.com/KiraAI-Dev/KiraAI/releases/tag/v3%2Fpreview')
    assert.equal(await fixture.run(), 'https://github.com/KiraAI-Dev/KiraAI/archive/refs/tags/v3%2Fpreview.zip')
  }
})

test('failed fallback reports explicit rate limiting only when the API was rate limited', async () => {
  for (const response of [
    new Response('', { status: 429 }),
    new Response('', { status: 403, headers: { 'retry-after': '60' } }),
    new Response('', { status: 403, headers: { 'x-ratelimit-remaining': '0' } }),
  ]) {
    await assert.rejects(releaseLookupFixture(response, undefined, 503).run(), /RELEASE_RATE_LIMITED/)
  }
  await assert.rejects(releaseLookupFixture(new Response('', { status: 403 }), undefined, 503).run(), /RELEASE_LOOKUP_FAILED/)
})

test('fallback rejects unrelated hosts, repository pages, and malformed release tags', async () => {
  for (const url of [
    'https://example.com/xxynet/KiraAI/releases/tag/v1',
    'http://github.com/xxynet/KiraAI/releases/tag/v1',
    'https://github.com/xxynet/other/releases/tag/v1',
    'https://github.com/xxynet/KiraAI/releases',
    'https://github.com/xxynet/KiraAI/releases/tag/%XX',
  ]) {
    await assert.rejects(releaseLookupFixture(new Error('network'), url).run(), /RELEASE_LOOKUP_FAILED/)
  }
})

test('download preserves the rate-limit error and cleans staging when both release sources fail', async () => {
  const fixture = downloadFixture({ rateLimited: true })
  await assert.rejects(fixture.run(), /RELEASE_RATE_LIMITED/)
  assert.equal(fixture.events.at(-1).stage, 'release')
  assert.equal(fixture.registered(), false)
  assert.deepEqual(fixture.removed, ['/parent/staging'])
})
test('release page redirect loops stop at the redirect limit', async () => {
  const fixture = releaseLookupFixture(new Error('network'), 'https://github.com/xxynet/KiraAI/releases/latest')
  await assert.rejects(fixture.run(), /RELEASE_LOOKUP_FAILED/)
  assert.equal(fixture.aborted(), true)
})

test('release page without a tag redirect is not treated as a release', async () => {
  await assert.rejects(releaseLookupFixture(new Error('network'), undefined, 200).run(), /RELEASE_LOOKUP_FAILED/)
})
test('release page timeout aborts the pending request', async () => {
  const request = new EventEmitter()
  let onTimeout, aborted = false, cleared = false
  request.setHeader = () => {}
  request.end = () => {}
  request.abort = () => { aborted = true }
  const { getReleasePageArchiveUrl } = loadSource('electron/project-download.ts', {}, {
    net: { request: () => request },
    setTimeout: (callback, milliseconds) => { assert.equal(milliseconds, 15000); onTimeout = callback; return 1 },
    clearTimeout: () => { cleared = true },
  }, ['getReleasePageArchiveUrl', 'downloadError'])
  const pending = getReleasePageArchiveUrl()
  onTimeout()
  await assert.rejects(pending, /RELEASE_LOOKUP_FAILED/)
  assert.equal(aborted, true)
  assert.equal(cleared, true)
})