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
    const fixture = logFixture({ type, body: { logs: [{ time: '12:00', level: 'WARNING', name: 'test', message: 'warning\ndetail', color: 'cyan' }, { time: '12:01', level: 'CRITICAL', name: 'test', message: 'failure' }] } })
    const log = await fixture.read('instance')
    const base = type === 'local' ? 'http://127.0.0.1:6000' : 'https://instance.test/prefix'
    assert.equal(fixture.calls[0].login, base)
    assert.equal(fixture.calls[0].token, type === 'local' ? 'local-token' : 'saved-token')
    assert.equal(fixture.calls[1].url, base + '/api/log-history?limit=100')
    assert.equal(fixture.calls[1].init.headers.Authorization, 'Bearer session')
    assert.equal(fixture.calls[1].init.redirect, 'error')
    assert.equal(log.entries[0].level, 'WARN')
    assert.equal(log.entries[0].color, 'cyan')
    assert.equal(log.entries[0].displayLevel, 'WARNING')
    assert.equal(log.entries[0].message, 'warning\ndetail')
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
  const subscriptions = []
  const state = {
    selectedLogSource: { value: 'launcher' }, logRequestId: 0, removeLogListener: undefined,
    logsLoading: { value: false }, logsError: { value: '' }, currentLog: { value: { content: 'old' } },
    requireLauncherBridge: () => ({ logs: {
      read: (id) => new Promise((resolve, reject) => pending.push({ id, resolve, reject })),
      watch: (id, listener) => {
        const subscription = { id, listener, stopped: false }
        subscriptions.push(subscription)
        return () => { subscription.stopped = true }
      },
    } }),
    getErrorMessage: () => 'read failed',
  }
  const { refreshLogs, stopLogStream } = loadSource('src/App.vue', {}, state, ['refreshLogs', 'stopLogStream'])
  return { state, pending, subscriptions, refresh: refreshLogs, stop: stopLogStream }
}

test('source switch clears old content and ignores late results and failures', async () => {
  for (const failOld of [false, true]) {
    const { state, pending, subscriptions, refresh } = refreshFixture()
    const first = refresh()
    assert.equal(pending[0].id, undefined)
    assert.equal(state.currentLog.value.content, '')
    state.selectedLogSource.value = 'instance'
    const second = refresh()
    assert.equal(subscriptions[0].id, 'instance')
    if (failOld) pending[0].reject(new Error('old failure'))
    else pending[0].resolve({ content: 'old source' })
    await first
    assert.equal(state.logsLoading.value, true)
    assert.equal(state.currentLog.value.content, '')
    assert.equal(state.logsError.value, '')
    subscriptions[0].listener({ log: { content: 'new source' } })
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
  const statements = ast.statements.filter((node) => ts.isVariableStatement(node) && node.declarationList.declarations.some((declaration) => ['filteredLogEntries', 'filteredLog'].includes(declaration.name.getText(ast))))
  const { getLogEntries } = loadSource('src/components/log-format.ts')
  const state = { getLogEntries, selectedLogLevel: { value: 'ERROR' }, currentLog: { value: { content: 'all', entries: [{ level: 'ERROR', content: 'failure\nstack trace' }, { level: 'INFO', content: 'info' }] } }, computed: (fn) => ({ get value() { return fn() } }) }
  const code = ts.transpileModule(statements.map((statement) => statement.getText(ast)).join('\n') + '\nresult = filteredLog', { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText
  vm.runInNewContext(code, state)
  assert.equal(state.result.value, 'failure\nstack trace')
  state.selectedLogLevel.value = 'ALL'
  assert.equal(state.result.value, 'failure\nstack trace\ninfo')
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

test('color formatting retains structured messages and safely maps known colors', () => {
  const { getLogEntries, logColor } = loadSource('src/components/log-format.ts')
  const entries = [{ level: 'ERROR', content: 'formatted', time: 'now', name: 'module', message: '<script>example</script>\ntrace', color: 'red' }]
  assert.equal(getLogEntries({ content: 'formatted', entries }), entries)
  const [entry] = getLogEntries({ content: '[time] [ERROR] <img src=x onerror=alert(1)>' })
  assert.equal(entry.message, '<img src=x onerror=alert(1)>')
  assert.equal(entry.level, 'ERROR')
  assert.equal(logColor('bold_light_blue'), 'var(--log-blue)')
  assert.equal(logColor('cyan'), 'var(--log-cyan)')
  assert.equal(logColor('white'), 'var(--log-neutral)')
  for (const color of [undefined, 'unknown', '__proto__', 'constructor', 'red; background: url(example)']) assert.equal(logColor(color), undefined)
  assert.equal(getLogEntries({ content: 'unstructured text' })[0].content, 'unstructured text')
})
test('live updates preserve content on disconnect and ignore a stopped source', async () => {
  const { state, subscriptions, refresh, stop } = refreshFixture()
  state.selectedLogSource.value = 'instance'
  await refresh()
  assert.equal(state.logsLoading.value, true)
  subscriptions[0].listener({ log: { content: 'live' } })
  subscriptions[0].listener({ error: 'INSTANCE_LOG_READ_FAILED' })
  assert.equal(state.currentLog.value.content, 'live')
  assert.equal(state.logsError.value, 'read failed')
  subscriptions[0].listener({ log: { content: 'reconnected' } })
  assert.equal(state.logsError.value, '')
  state.selectedLogSource.value = 'second'
  await refresh()
  assert.equal(subscriptions[0].stopped, true)
  subscriptions[0].listener({ log: { content: 'stale' } })
  assert.equal(state.currentLog.value.content, '')
  subscriptions[1].listener({ log: { content: 'second' } })
  stop()
  assert.equal(subscriptions[1].stopped, true)
  subscriptions[1].listener({ log: { content: 'after leaving' } })
  assert.equal(state.currentLog.value.content, 'second')
  assert.equal(state.logsLoading.value, false)
})

const tick = () => new Promise((resolve) => setImmediate(resolve))
const entry = (message) => ({ time: '12:00', level: 'INFO', name: 'test', message, color: 'cyan' })

function streamFixture({ history = [], status = 200, contentType = 'text/event-stream', type = 'cloud' } = {}) {
  const calls = [], updates = [], errors = [], retries = [], connections = []
  let resolveHistory
  const historyResponse = new Promise((resolve) => { resolveHistory = resolve })
  const { watchProjectLog } = loadSource('electron/project-logs.ts', {
    electron: { net: { fetch: async (url, init) => {
      calls.push({ url, init })
      if (url.endsWith('/api/log-history?limit=100')) return historyResponse.then((response) => response.clone())
      const body = new ReadableStream({ start(controller) {
        connections.push(controller)
        init.signal.addEventListener('abort', () => { try { controller.error(new Error('aborted')) } catch {} }, { once: true })
      } })
      return new Response(body, { status, headers: { 'content-type': contentType } })
    } } },
    './cloud.js': {
      decryptAccessToken: () => 'saved-token', getLocalAccessToken: async () => 'local-token',
      getWebuiSessionToken: async () => 'session',
    },
    './local-project.js': { getLocalProject: async () => ({ port: 6000 }), getLocalWebuiUrl: () => 'http://127.0.0.1:6000' },
    './project-store.js': { loadProjects: async () => [{ id: 'instance', type, projectPath: '/instance', url: 'https://instance.test/prefix' }] },
  }, {
    Error, TextDecoder,
    setTimeout: (fn, ms) => { const timer = { fn, ms, cleared: false }; retries.push(timer); return timer },
    clearTimeout: (timer) => { if (timer) timer.cleared = true },
  })
  const stop = watchProjectLog('instance', (log) => updates.push(log), (error) => errors.push(error))
  return {
    calls, updates, errors, retries, connections, stop,
    resolveHistory: () => resolveHistory(Response.json({ logs: history })),
    send: (text) => connections.at(-1).enqueue(new TextEncoder().encode(text)),
  }
}

test('SSE handles split UTF-8, CRLF, multiline data, history overlap and identical new messages', async () => {
  for (const type of ['cloud', 'local']) {
    const f = streamFixture({ type, history: [entry('older'), entry('重叠')] })
    try {
      await tick()
      assert.match(f.calls[0].url, type === 'cloud' ? /^https:\/\/instance.test\/prefix\/api\/live-log$/ : /^http:\/\/127.0.0.1:6000\/api\/live-log$/)
      assert.equal(f.calls[0].init.headers.Authorization, 'Bearer session')
      assert.equal(f.calls[0].init.redirect, 'error')
      const bytes = new TextEncoder().encode(': heartbeat\r\ndata: ' + JSON.stringify(entry('重叠')) + '\r\n\r\n')
      for (const byte of bytes) f.connections[0].enqueue(new Uint8Array([byte]))
      await tick()
      f.resolveHistory()
      await tick()
      assert.deepEqual(Array.from(f.updates.at(-1).entries, (item) => item.message), ['older', '重叠'])
      f.send('data: ' + JSON.stringify(entry('重叠')) + '\n\n')
      f.send('data: {"time":"12:01","level":"WARNING",\r\ndata: "name":"test","message":"line\\ntrace","color":"red"}\r\n\r\n')
      await tick()
      assert.deepEqual(Array.from(f.updates.at(-1).entries, (item) => item.message), ['older', '重叠', '重叠', 'line\ntrace'])
      assert.equal(f.updates.at(-1).entries.at(-1).level, 'WARN')
      assert.equal(f.updates.at(-1).entries.at(-1).color, 'red')
      assert.equal(f.errors.length, 0)
    } finally { f.stop() }
    await tick()
    assert.equal(f.calls[0].init.signal.aborted, true)
    assert.equal(f.retries.filter((timer) => timer.ms === 3000 && !timer.cleared).length, 0)
  }
})

test('disconnect schedules one retry, reauthenticates and replaces the history snapshot', async () => {
  const f = streamFixture({ history: [entry('history')] })
  try {
    await tick()
    f.resolveHistory()
    await tick()
    f.connections[0].close()
    await tick()
    assert.deepEqual(f.errors, ['INSTANCE_LOG_READ_FAILED'])
    const retry = f.retries.find((timer) => timer.ms === 3000 && !timer.cleared)
    assert.ok(retry)
    retry.fn()
    await tick()
    assert.equal(f.connections.length, 2)
    assert.equal(f.updates.length, 2)
    assert.equal(f.updates[1].entries.length, 1)
    f.send('data: ' + JSON.stringify(entry('after reconnect')) + '\n\n')
    await tick()
    assert.equal(f.updates.at(-1).entries.at(-1).message, 'after reconnect')
  } finally { f.stop() }
})

test('stream errors are sanitized and retries can be cancelled', async () => {
  for (const options of [{ status: 401 }, { status: 403 }, { status: 404 }, { contentType: 'text/html' }]) {
    const f = streamFixture(options)
    await tick()
    assert.deepEqual(f.errors, [options.status === 401 || options.status === 403 ? 'INSTANCE_LOG_AUTH_REQUIRED' : 'INSTANCE_LOG_READ_FAILED'])
    f.stop()
    assert.ok(f.retries.every((timer) => timer.cleared))
    assert.equal(f.calls[0].init.signal.aborted, true)
  }
})

test('logs produced during history fetch are retained and live history is bounded', async () => {
  const f = streamFixture({ history: [entry('history')] })
  try {
    await tick()
    f.send('data: ' + JSON.stringify(entry('during history')) + '\n\n')
    await tick()
    f.resolveHistory()
    await tick()
    assert.deepEqual(Array.from(f.updates.at(-1).entries, (item) => item.message), ['history', 'during history'])
    f.send(Array.from({ length: 1005 }, (_, i) => 'data: ' + JSON.stringify(entry(String(i))) + '\n\n').join(''))
    await tick()
    assert.equal(f.updates.at(-1).entries.length, 1000)
    assert.equal(f.updates.at(-1).entries[0].message, '5')
    assert.equal(f.updates.at(-1).entries.at(-1).message, '1004')
  } finally { f.stop() }
})

test('cancellation during history loading suppresses stale snapshots and retry', async () => {
  const f = streamFixture()
  await tick()
  f.stop()
  f.resolveHistory()
  await tick()
  assert.equal(f.updates.length, 0)
  assert.equal(f.errors.length, 0)
  assert.ok(f.retries.every((timer) => timer.cleared))
})

test('IPC subscriptions belong to their window and close on replacement, navigation or destruction', () => {
  const ipc = new EventEmitter()
  const streams = []
  const { registerProjectLogSubscriptions } = loadSource('electron/project-log-subscriptions.ts', {
    './project-logs.js': { watchProjectLog: (id, onLog, onError) => {
      const stream = { id, onLog, onError, stopped: false }
      streams.push(stream)
      return () => { stream.stopped = true }
    } },
  })
  registerProjectLogSubscriptions(ipc)
  const sender = new EventEmitter(), other = new EventEmitter(), sent = []
  sender.isDestroyed = () => false
  sender.send = (...args) => sent.push(args)
  ipc.emit('logs:watch', { sender }, 1, 'first')
  streams[0].onLog({ content: 'first' })
  assert.equal(sent.length, 1)
  ipc.emit('logs:unwatch', { sender: other }, 1)
  assert.equal(streams[0].stopped, false)
  ipc.emit('logs:watch', { sender }, 2, 'second')
  assert.equal(streams[0].stopped, true)
  streams[0].onLog({ content: 'late' })
  assert.equal(sent.length, 1)
  ipc.emit('logs:unwatch', { sender }, 1)
  assert.equal(streams[1].stopped, false)
  sender.emit('did-start-navigation')
  assert.equal(streams[1].stopped, true)
  assert.equal(sender.listenerCount('destroyed'), 0)
  ipc.emit('logs:watch', { sender }, 3, 'third')
  sender.emit('destroyed')
  assert.equal(streams[2].stopped, true)
  assert.equal(sender.listenerCount('did-start-navigation'), 0)
})

test('authentication keeps existing behavior and forwards cancellation through response bodies', async () => {
  for (const authEnabled of [true, false]) {
    const calls = []
    const { getWebuiSessionToken } = loadSource('electron/cloud.ts', {
      electron: { net: { fetch: async (url, init) => {
        calls.push({ url, init })
        return Response.json(url.endsWith('/config') ? { auth_enabled: authEnabled } : { access_token: 'session' })
      } }, safeStorage: {} },
      'node:fs': { promises: {} }, 'node:path': path,
    }, { AbortSignal, Error })
    const controller = new AbortController()
    assert.equal(await getWebuiSessionToken('https://instance.test', 'saved-token', controller.signal), 'session')
    assert.equal(calls.length, 2)
    assert.equal(JSON.parse(calls[1].init.body).access_token, authEnabled ? 'saved-token' : 'disabled')
    controller.abort()
    assert.ok(calls.every(({ init }) => init.signal.aborted))
  }
  let bodySignal
  const { getWebuiSessionToken } = loadSource('electron/cloud.ts', {
    electron: { net: { fetch: async (_url, init) => {
      bodySignal = init.signal
      return new Response(new ReadableStream({ start(controller) {
        init.signal.addEventListener('abort', () => controller.error(new Error('aborted')))
      } }))
    } }, safeStorage: {} },
    'node:fs': { promises: {} }, 'node:path': path,
  }, { AbortSignal, Error })
  const controller = new AbortController()
  const auth = getWebuiSessionToken('https://instance.test', 'saved-token', controller.signal)
  await tick()
  controller.abort()
  await assert.rejects(auth, /CLOUD_AUTH_CONFIG_INVALID/)
  assert.equal(bodySignal.aborted, true)
})

test('cancelling log authentication aborts it without opening a stream or retrying', async () => {
  let authSignal
  const errors = [], timers = []
  const { watchProjectLog } = loadSource('electron/project-logs.ts', {
    electron: { net: { fetch: () => assert.fail('must not open stream after cancellation') } },
    './cloud.js': {
      decryptAccessToken: () => undefined,
      getWebuiSessionToken: (_url, _token, signal) => new Promise((_resolve, reject) => {
        authSignal = signal
        signal.addEventListener('abort', () => reject(new Error('aborted')))
      }),
    },
    './local-project.js': {},
    './project-store.js': { loadProjects: async () => [{ id: 'instance', type: 'cloud', url: 'https://instance.test' }] },
  }, {
    Error, TextDecoder,
    setTimeout: (fn, ms) => { const timer = { fn, ms, cleared: false }; timers.push(timer); return timer },
    clearTimeout: (timer) => { if (timer) timer.cleared = true },
  })
  const stop = watchProjectLog('instance', () => assert.fail('must not update'), (error) => errors.push(error))
  await tick()
  stop()
  await tick()
  assert.equal(authSignal.aborted, true)
  assert.deepEqual(errors, [])
  assert.ok(timers.every((timer) => timer.cleared))
})
