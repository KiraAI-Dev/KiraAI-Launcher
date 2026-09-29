import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import test from 'node:test'
import ts from 'typescript'

function loadSource(file, dependencies = {}, globals = {}, names) {
  let source = readFileSync(new URL('../' + file, import.meta.url), 'utf8')
  if (names) {
    const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true)
    source = ast.statements.filter(node => ts.isFunctionDeclaration(node) && names.includes(node.name?.text))
      .map(node => node.getText(ast)).join('\n') + '\nexport { ' + names.join(', ') + ' }'
  }
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  })
  const exports = {}
  vm.runInNewContext(outputText, {
    exports, require: id => { assert.ok(id in dependencies, 'Unexpected dependency: ' + id); return dependencies[id] },
    Buffer, Response, URL, Error, AbortController, AbortSignal, setTimeout, clearTimeout, ...globals,
  })
  return exports
}

function fixture({ type = 'local', authEnabled = true, accessToken = 'local-access', staleToken,
  failCookie = false, failLoad = false, mode = 'launcher', beforeLoad } = {}) {
  const target = 'http://127.0.0.1:5267'
  const storage = new Map(staleToken ? [['jwt_token', staleToken]] : [])
  const cookies = new Map(), requests = [], windows = [], external = []
  const cloud = loadSource('electron/cloud.ts', {
    electron: { net: { fetch: async (url, init) => {
      requests.push({ url, init })
      if (url.endsWith('/api/health')) return Response.json({ status: 'ok' })
      if (url.endsWith('/api/auth/config')) return Response.json({ auth_enabled: authEnabled })
      assert.ok(url.endsWith('/api/auth/login'))
      assert.equal(JSON.parse(init.body).access_token, authEnabled ? accessToken : 'disabled')
      return Response.json({ access_token: 'fresh-session' })
    } }, safeStorage: {} },
    'node:fs': { promises: { readFile: async file => {
      assert.equal(file, path.join('/project', 'data', 'webui.json'))
      return JSON.stringify({ access_token: accessToken })
    } } },
    'node:path': path,
  })
  class BrowserWindow {
    constructor(options) {
      this.options = options
      this.destroyed = false
      const handlers = new Map()
      this.webContents = {
        mainFrame: { url: target },
        ipc: { on: (channel, handler) => handlers.set(channel, handler) },
        session: { cookies: { set: async cookie => {
          if (failCookie) throw new Error('COOKIE_FAILED')
          cookies.set(cookie.name, cookie)
        } } },
      }
      this.handshake = (overrides = {}) => {
        const event = { sender: this.webContents, senderFrame: this.webContents.mainFrame, ...overrides }
        let replies = 0, reply
        Object.defineProperty(event, 'returnValue', { set(value) { replies++; reply = value } })
        handlers.get('webui:initial-session')(event)
        assert.equal(replies, 1, 'A synchronous IPC request must receive exactly one reply')
        return reply
      }
      this.preload = (isMainFrame = true) => loadSource('electron/webui-preload.cts', {
        electron: { ipcRenderer: { sendSync: channel => {
          assert.equal(channel, 'webui:initial-session')
          return this.handshake()
        } } },
      }, { process: { isMainFrame }, localStorage: {
        setItem: (key, value) => storage.set(key, value),
      } })
      windows.push(this)
    }
    async loadURL(url) {
      assert.equal(url, target)
      if (failLoad) throw new Error('LOAD_FAILED')
      beforeLoad?.(this)
      this.preload()
      // Match WebUI's initial auth guard: a cookie alone cannot pass this check.
      this.initialRoute = storage.get('jwt_token') ? '/overview' : '/login'
    }
    isDestroyed() { return this.destroyed }
    destroy() { this.destroyed = true }
  }
  const api = loadSource('electron/main.ts', {}, {
    ...cloud, BrowserWindow, path, __dirname: '/launcher',
    loadProjects: async () => [{ id: 'new-project', name: 'New', type, projectPath: '/project', url: target }],
    getLocalProject: async () => ({ host: '127.0.0.1', port: 5267 }),
    getLocalWebuiUrl: () => target,
    loadSettings: async () => ({ webuiOpenMode: mode }),
    decryptAccessToken: () => accessToken,
    shell: { openExternal: async url => external.push(url) },
  }, ['openProject', 'openAuthenticatedWebui'])
  return { ...api, storage, cookies, requests, windows, external, target }
}

for (const type of ['local', 'cloud']) {
  test(`${type}: initial window has JWT before the frontend auth guard runs`, async () => {
    const f = fixture({ type })
    await f.openProject('new-project')
    assert.equal(f.storage.get('jwt_token'), 'fresh-session')
    assert.equal(f.cookies.get('kira_token').value, 'fresh-session')
    assert.equal(f.cookies.get('kira_token').httpOnly, true)
    assert.equal(f.cookies.get('kira_token').path, '/')
    const window = f.windows[0]
    assert.equal(window.initialRoute, '/overview')
    assert.equal(window.options.webPreferences.preload, path.join('/launcher', 'webui-preload.cjs'))
    assert.equal(window.options.webPreferences.partition, 'persist:kira-project-new-project')
    assert.equal(window.options.webPreferences.contextIsolation, true)
    assert.equal(window.options.webPreferences.nodeIntegration, false)
  })
}

test('opening a window replaces a stale JWT with the newly authenticated session', async () => {
  const f = fixture({ staleToken: 'expired-session' })
  await f.openProject('new-project')
  assert.equal(f.storage.get('jwt_token'), 'fresh-session')
})

test('reload does not restore a logged-out or rotated session', async () => {
  const f = fixture()
  await f.openProject('new-project')
  f.storage.clear()
  f.windows[0].preload()
  assert.equal(f.storage.has('jwt_token'), false)
  f.storage.set('jwt_token', 'rotated-session')
  f.windows[0].preload()
  assert.equal(f.storage.get('jwt_token'), 'rotated-session')
})

test('auth-disabled local instance initializes frontend with the sentinel login session', async () => {
  const f = fixture({ authEnabled: false, accessToken: '' })
  await f.openProject('new-project')
  assert.equal(f.windows[0].initialRoute, '/overview')
  assert.equal(f.storage.get('jwt_token'), 'fresh-session')
})

test('no available session leaves the existing manual login flow usable', async () => {
  const f = fixture({ accessToken: '' })
  await f.openProject('new-project')
  assert.equal(f.windows[0].initialRoute, '/login')
  assert.equal(f.storage.size, 0)
  assert.equal(f.cookies.size, 0)
  assert.ok(!f.requests.some(request => request.url.endsWith('/api/auth/login')))
})

test('untrusted frames and origins cannot retrieve or consume the initial session', async () => {
  const f = fixture({ beforeLoad: window => {
    window.preload(false)
    assert.equal(f.storage.size, 0)
    assert.equal(window.handshake({ sender: {} }), null)
    assert.equal(window.handshake({ senderFrame: null }), null)
    assert.equal(window.handshake({ senderFrame: { url: f.target } }), null)
    for (const url of ['https://untrusted.test', 'http://127.0.0.1:5268', 'https://127.0.0.1:5267', 'about:blank', 'invalid']) {
      window.webContents.mainFrame.url = url
      assert.equal(window.handshake(), null)
    }
    window.webContents.mainFrame.url = f.target + '/overview'
  } })
  await f.openProject('new-project')
  assert.equal(f.storage.get('jwt_token'), 'fresh-session')
  assert.equal(f.windows[0].handshake(), null)
})

for (const failure of ['failCookie', 'failLoad']) {
  test(`${failure}: closes the failed window and propagates the error`, async () => {
    const f = fixture({ [failure]: true })
    await assert.rejects(f.openProject('new-project'), /(?:COOKIE|LOAD)_FAILED/)
    assert.equal(f.windows[0].destroyed, true)
  })
}

test('system browser mode does not initialize an embedded session', async () => {
  const f = fixture({ mode: 'browser' })
  await f.openProject('new-project')
  assert.deepEqual(f.external, [f.target])
  assert.equal(f.windows.length, 0)
  assert.equal(f.requests.length, 0)
})
