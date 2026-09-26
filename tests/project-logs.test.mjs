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

function logFixture({ type = 'cloud', sessionToken = 'session', status = 200, body = { logs: [] }, loginError, fetchError } = {}) {
  const calls = []
  const project = { id: 'instance', type, url: 'https://instance.test/prefix', projectPath: '/instance' }
  const { readProjectLog } = loadSource('electron/project-logs.ts', {
    electron: { net: { fetch: async (url, init) => {
      calls.push({ url, init })
      if (fetchError) throw fetchError
      return Response.json(body, { status })
    } } },
    './cloud.js': {
      decryptAccessToken: () => 'saved-token',
      getLocalAccessToken: async () => 'local-token',
      getWebuiSessionToken: async (url, token) => {
        calls.push({ login: url, token })
        if (loginError) throw loginError
        return sessionToken
      },
    },
    './local-project.js': {
      getLocalProject: async () => ({ host: '0.0.0.0', port: 6000 }),
      getLocalWebuiUrl: (_host, port) => `http://127.0.0.1:${port}`,
    },
    './project-store.js': { loadProjects: async () => [project] },
  }, { Error })
  return { calls, read: readProjectLog }
}

test('cloud and local logs use their own endpoint and credentials', async () => {
  for (const type of ['local', 'cloud']) {
    const fixture = logFixture({ type, body: { logs: [{ time: '12:00', level: 'WARNING', name: 'test', message: 'warning\ndetail' }, { time: '12:01', level: 'CRITICAL', name: 'test', message: 'failure' }] } })
    const log = await fixture.read('instance')
    const base = type === 'local' ? 'http://127.0.0.1:6000' : 'https://instance.test/prefix'
    assert.equal(fixture.calls[0].login, base)
    assert.equal(fixture.calls[0].token, type === 'local' ? 'local-token' : 'saved-token')
    assert.equal(fixture.calls[1].url, base + '/api/log-history?limit=100')
    assert.equal(fixture.calls[1].init.headers.Authorization, 'Bearer session')
    assert.equal(fixture.calls[1].init.redirect, 'error')
    assert.equal(log.entries[0].level, 'WARN')
    assert.equal(log.entries[1].level, 'ERROR')
    assert.match(log.entries[0].content, /warning\ndetail/)
    assert.equal(log.content, log.entries.map((entry) => entry.content).join('\n'))
  }
})

test('empty instance history is valid', async () => {
  const result = await logFixture().read('instance')
  assert.equal(result.content, '')
  assert.equal(result.entries.length, 0)
})

test('invalid or removed sources fail before making network requests', async () => {
  const fixture = logFixture()
  for (const id of [null, 123, '', ' ']) await assert.rejects(fixture.read(id), /PROJECT_ID_INVALID/)
  await assert.rejects(fixture.read('removed'), /PROJECT_NOT_FOUND/)
  assert.equal(fixture.calls.length, 0)
})

test('missing and rejected credentials produce actionable errors', async () => {
  for (const options of [{ sessionToken: null }, { loginError: new Error('CLOUD_ACCESS_TOKEN_INVALID') }, { status: 401 }, { status: 403 }]) {
    await assert.rejects(logFixture(options).read('instance'), /INSTANCE_LOG_AUTH_REQUIRED/)
  }
})

test('unreachable and unsupported instances do not expose response details', async () => {
  for (const options of [{ status: 404 }, { status: 500 }, { fetchError: new Error('private detail') }, { loginError: new Error('private detail') }, { body: {} }, { body: { logs: [null] } }, { body: { logs: [{ message: 'incomplete' }] } }]) {
    await assert.rejects(logFixture(options).read('instance'), /^Error: INSTANCE_LOG_READ_FAILED$/)
  }
})

function refreshFixture() {
  const pending = []
  const state = {
    selectedLogSource: { value: 'launcher' }, logRequestId: 0,
    logsLoading: { value: false }, logsError: { value: '' }, currentLog: { value: { content: 'old' } },
    requireLauncherBridge: () => ({ logs: { read: (id) => new Promise((resolve, reject) => pending.push({ id, resolve, reject })) } }),
    getErrorMessage: () => 'read failed',
  }
  const { refreshLogs } = loadSource('src/App.vue', {}, state, ['refreshLogs'])
  return { state, pending, refresh: refreshLogs }
}

test('source switch clears old content and ignores late results and failures', async () => {
  for (const failOld of [false, true]) {
    const { state, pending, refresh } = refreshFixture()
    const first = refresh()
    assert.equal(pending[0].id, undefined)
    assert.equal(state.currentLog.value.content, '')
    state.selectedLogSource.value = 'instance'
    const second = refresh()
    assert.equal(pending[1].id, 'instance')
    if (failOld) pending[0].reject(new Error('old failure'))
    else pending[0].resolve({ content: 'old source' })
    await first
    assert.equal(state.logsLoading.value, true)
    assert.equal(state.currentLog.value.content, '')
    assert.equal(state.logsError.value, '')
    pending[1].resolve({ content: 'new source' })
    await second
    assert.equal(state.logsLoading.value, false)
    assert.equal(state.currentLog.value.content, 'new source')
  }
})

test('failed refresh removes stale content and displays the error', async () => {
  const { state, pending, refresh } = refreshFixture()
  const request = refresh()
  pending[0].reject(new Error('failure'))
  await request
  assert.equal(state.currentLog.value.content, '')
  assert.equal(state.logsError.value, 'read failed')
  assert.equal(state.logsLoading.value, false)
})

test('log filtering preserves instance stack traces and launcher filtering', () => {
  const source = readFileSync(new URL('../src/App.vue', import.meta.url), 'utf8').split('<script setup lang="ts">')[1].split('</script>')[0]
  const ast = ts.createSourceFile('App.ts', source, ts.ScriptTarget.Latest, true)
  const statement = ast.statements.find((node) => ts.isVariableStatement(node) && node.declarationList.declarations.some((declaration) => declaration.name.getText(ast) === 'filteredLog'))
  const state = { selectedLogLevel: { value: 'ERROR' }, currentLog: { value: { content: 'all', entries: [{ level: 'ERROR', content: 'failure\nstack trace' }, { level: 'INFO', content: 'info' }] } }, computed: (fn) => ({ get value() { return fn() } }) }
  const code = ts.transpileModule(statement.getText(ast) + '\nresult = filteredLog', { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText
  vm.runInNewContext(code, state)
  assert.equal(state.result.value, 'failure\nstack trace')
  state.selectedLogLevel.value = 'ALL'
  assert.equal(state.result.value, 'all')
  state.currentLog.value = { content: '[time] [INFO] info\n[time] [WARN] warning' }
  state.selectedLogLevel.value = 'WARN'
  assert.equal(state.result.value, '[time] [WARN] warning')
})

test('all locales have matching keys and placeholders', () => {
  const { messages } = loadSource('src/i18n/messages.ts')
  function flatten(value, prefix = '') {
    return Object.entries(value).flatMap(([key, text]) => typeof text === 'object' ? flatten(text, prefix + key + '.') : [[prefix + key, [...text.matchAll(/\{([^}]+)\}/g)].map((match) => match[1]).sort()]])
  }
  assert.deepEqual(flatten(messages['zh-CN']), flatten(messages['en-US']))
})
