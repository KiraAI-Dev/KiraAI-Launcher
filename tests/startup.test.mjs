import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import test from 'node:test'
import ts from 'typescript'

function loadSource(file, dependencies = {}, globals = {}, names) {
  let source = readFileSync(new URL('../' + file, import.meta.url), 'utf8')
  if (file.endsWith('.vue')) source = source.split('<script setup lang="ts">')[1].split('</script>')[0]
  if (names) {
    const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true)
    source = ast.statements.filter(node => ts.isFunctionDeclaration(node) && names.includes(node.name?.text))
      .map(node => node.getText(ast)).join('\n') + '\nexport { ' + names.join(', ') + ' }'
  }
  const { outputText } = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } })
  const state = vm.createContext({ exports: {}, require: id => {
    assert.ok(id in dependencies, 'Unexpected dependency: ' + id)
    return dependencies[id]
  }, Error, ...globals })
  vm.runInContext(outputText, state)
  return { ...state.exports, state }
}

function startupFixture({ platform = 'win32', packaged = true, env = {}, argv = [], openedAtLogin = false, rejected = false } = {}) {
  const writes = [], reads = [], files = new Map()
  const login = { openAtLogin: false, executableWillLaunchAtLogin: false, wasOpenedAtLogin: openedAtLogin }
  const fs = {
    mkdir: async () => {},
    writeFile: async (file, content) => { files.set(file, content) },
    readFile: async file => {
      if (!files.has(file)) throw Object.assign(new Error('missing'), { code: 'ENOENT' })
      return files.get(file)
    },
    rm: async file => { files.delete(file) },
  }
  const app = {
    isPackaged: packaged, getPath: () => '/home/test',
    getLoginItemSettings: options => { reads.push(options); return { ...login } },
    setLoginItemSettings: options => {
      writes.push(options)
      if (!rejected) {
        login.openAtLogin = options.openAtLogin
        login.executableWillLaunchAtLogin = options.openAtLogin
      }
    },
  }
  const module = loadSource('electron/startup.ts', { electron: { app }, 'node:fs': { promises: fs }, 'node:path': path.posix }, {
    process: { platform, env, argv, execPath: '/installed/KiraAI Launcher' },
  })
  return { ...module, writes, reads, files, login, fs }
}

test('startup settings default off, reject non-booleans and persist both preferences', async () => {
  const files = new Map()
  const fs = { mkdir: async () => {}, readFile: async file => files.get(file),
    writeFile: async (file, data) => files.set(file, data),
    rename: async (from, to) => { files.set(to, files.get(from)); files.delete(from) } }
  const settings = loadSource('electron/settings.ts', {
    electron: { app: { getPath: () => '/settings' } }, 'node:fs': { promises: fs }, 'node:path': path.posix,
  })
  for (const input of [{}, { launchAtLogin: 'true', startMinimized: 1, persistInstanceState: 'true' }]) {
    assert.equal(settings.sanitizeSettings(input).launchAtLogin, false)
    assert.equal(settings.sanitizeSettings(input).startMinimized, false)
    assert.equal(settings.sanitizeSettings(input).persistInstanceState, false)
  }
  await settings.saveSettings({ launchAtLogin: true, startMinimized: true, persistInstanceState: true })
  assert.equal((await settings.loadSettings()).launchAtLogin, true)
  assert.equal((await settings.loadSettings()).persistInstanceState, true)
  assert.equal((await settings.loadSettings()).startMinimized, true)
  await settings.saveSettings({ launchAtLogin: false, startMinimized: true })
  assert.equal((await settings.loadSettings()).launchAtLogin, false)
  assert.equal((await settings.loadSettings()).startMinimized, true)
})

test('Windows registers and removes the executable with a dedicated login argument', async () => {
  const f = startupFixture()
  await f.setLaunchAtLogin(true)
  assert.equal(await f.getLaunchAtLogin(), true)
  assert.equal(f.writes[0].path, '/installed/KiraAI Launcher')
  assert.deepEqual(Array.from(f.writes[0].args), ['--launch-at-login'])
  assert.equal(f.reads[0].path, f.writes[0].path)
  assert.deepEqual(Array.from(f.reads[0].args), Array.from(f.writes[0].args))
  await f.setLaunchAtLogin(false)
  assert.equal(await f.getLaunchAtLogin(), false)
  assert.equal(f.writes[1].enabled, false)
})

test('Windows portable startup targets the original portable executable', async () => {
  const f = startupFixture({ env: { PORTABLE_EXECUTABLE_FILE: 'D:\\Apps\\Kira Launcher.exe' } })
  await f.setLaunchAtLogin(true)
  assert.equal(f.writes[0].path, 'D:\\Apps\\Kira Launcher.exe')
})

test('a Windows startup item disabled by the OS is reported as disabled', async () => {
  const f = startupFixture()
  f.login.openAtLogin = true
  assert.equal(await f.getLaunchAtLogin(), false)
})

test('macOS uses login item settings and its native login launch marker', async () => {
  const f = startupFixture({ platform: 'darwin', openedAtLogin: true })
  await f.setLaunchAtLogin(true)
  assert.deepEqual(Object.keys(f.writes[0]), ['openAtLogin'])
  assert.equal(f.shouldStartInTray({ launchAtLogin: true, startMinimized: true }), true)
  await f.setLaunchAtLogin(false)
  assert.equal(await f.getLaunchAtLogin(), false)
})

test('Linux creates and removes an XDG autostart entry for the original AppImage', async () => {
  const f = startupFixture({ platform: 'linux', env: { XDG_CONFIG_HOME: '/config', APPIMAGE: '/apps/Kira AI.AppImage' } })
  await f.setLaunchAtLogin(true)
  const entry = f.files.get('/config/autostart/com.kiraai.launcher.desktop')
  assert.match(entry, /Exec="\/apps\/Kira AI.AppImage" --launch-at-login\n/)
  assert.equal(await f.getLaunchAtLogin(), true)
  await f.setLaunchAtLogin(false)
  assert.equal(f.files.size, 0)
  assert.equal(await f.getLaunchAtLogin(), false)
})

test('Linux ignores a relative XDG directory and respects disabled desktop entries', async () => {
  const f = startupFixture({ platform: 'linux', env: { XDG_CONFIG_HOME: 'relative' } })
  await f.setLaunchAtLogin(true)
  const file = '/home/test/.config/autostart/com.kiraai.launcher.desktop'
  const entry = f.files.get(file)
  assert.ok(entry)
  f.files.set(file, entry.replace('Hidden=false', 'Hidden=true'))
  assert.equal(await f.getLaunchAtLogin(), false)
  f.files.set(file, entry + 'X-GNOME-Autostart-enabled=false\n')
  assert.equal(await f.getLaunchAtLogin(), false)
})

test('Linux escapes executable metacharacters and rejects desktop entry injection', async () => {
  const executable = '/apps/Kira $cash `tick` "quote" \\ 100%.AppImage'
  const f = startupFixture({ platform: 'linux', env: { APPIMAGE: executable } })
  await f.setLaunchAtLogin(true)
  const entry = [...f.files.values()][0]
  const exec = entry.split('\n').find(line => line.startsWith('Exec=')).slice(5)
  // Undo the desktop string escaping, then command quoting and literal percent codes.
  const decoded = exec.slice(1, -('" --launch-at-login'.length)).replace(/\\\\/g, '\\')
    .replace(/\\(["`$\\])/g, '$1').replace(/%%/g, '%')
  assert.equal(decoded, executable)
  const invalid = startupFixture({ platform: 'linux', env: { APPIMAGE: '/apps/Kira\nExec=bad' } })
  await assert.rejects(invalid.setLaunchAtLogin(true), /STARTUP_SETTINGS_FAILED/)
  assert.equal(invalid.files.size, 0)
})

test('development and unsupported platforms cannot register startup items', async () => {
  for (const options of [{ packaged: false }, { platform: 'freebsd' }]) {
    const f = startupFixture(options)
    assert.equal(f.isStartupSupported(), false)
    await assert.rejects(f.setLaunchAtLogin(true), /STARTUP_SETTINGS_FAILED/)
    await f.setLaunchAtLogin(false)
    assert.equal(f.writes.length, 0)
    assert.equal(f.files.size, 0)
  }
})

test('OS rejection and filesystem failures are surfaced', async () => {
  await assert.rejects(startupFixture({ rejected: true }).setLaunchAtLogin(true), /STARTUP_SETTINGS_FAILED/)
  const f = startupFixture({ platform: 'linux' })
  f.fs.readFile = async () => { throw Object.assign(new Error('denied'), { code: 'EACCES' }) }
  await assert.rejects(f.getLaunchAtLogin(), /denied/)
})

test('only an automatic login launch with both preferences enabled starts hidden', () => {
  for (const platform of ['win32', 'linux', 'darwin']) {
    for (const automatic of [false, true]) {
      const f = startupFixture({ platform, argv: automatic ? ['app', '--launch-at-login'] : ['app'] })
      for (const launchAtLogin of [false, true]) {
        for (const startMinimized of [false, true]) {
          assert.equal(f.shouldStartInTray({ launchAtLogin, startMinimized }), automatic && launchAtLogin && startMinimized)
        }
      }
    }
  }
})

function saveFixture({ startupFails = false, diskFails = false } = {}) {
  const startupWrites = [], persisted = [], applied = []
  const f = loadSource('electron/main.ts', {}, {
    currentSettings: { launchAtLogin: false, startMinimized: false },
    sanitizeSettings: value => value,
    setLaunchAtLogin: async enabled => {
      startupWrites.push(enabled)
      if (startupFails && enabled) throw new Error('private OS error')
    },
    saveSettings: async value => {
      if (diskFails) throw new Error('private filesystem error')
      persisted.push(value)
      return value
    },
    applyLauncherUpdateSettings: () => applied.push('updater'), updateTrayMenu: () => applied.push('tray'),
  }, ['saveLauncherSettings'])
  return { ...f, startupWrites, persisted, applied }
}

test('saving startup registers with the OS before persisting and updates existing settings consumers', async () => {
  const f = saveFixture()
  await f.saveLauncherSettings({ launchAtLogin: true, startMinimized: true })
  assert.deepEqual(f.startupWrites, [true])
  assert.equal(f.persisted[0].startMinimized, true)
  assert.deepEqual(f.applied, ['updater', 'tray'])
  await f.saveLauncherSettings({ launchAtLogin: true, startMinimized: false })
  assert.deepEqual(f.startupWrites, [true])
})

test('OS or disk failures roll back startup without publishing unsaved settings or private error details', async () => {
  for (const options of [{ startupFails: true }, { diskFails: true }]) {
    const f = saveFixture(options)
    await assert.rejects(f.saveLauncherSettings({ launchAtLogin: true }), /^Error: SETTINGS_SAVE_FAILED$/)
    assert.deepEqual(f.startupWrites, [true, false])
    assert.equal(f.state.currentSettings.launchAtLogin, false)
    assert.equal(f.persisted.length, 0)
    assert.equal(f.applied.length, 0)
  }
})

test('hidden startup never shows the BrowserWindow until explicitly restored', () => {
  const windows = [], events = []
  class Window extends EventEmitter {
    constructor(options) { super(); this.options = options; this.webContents = { send() {} }; windows.push(this) }
    loadFile() {}
    isDestroyed() { return false }
    isMinimized() { return false }
    show() { events.push('show') }
    focus() { events.push('focus') }
  }
  const f = loadSource('electron/main.ts', {}, {
    BrowserWindow: Window, mainWindow: null, applicationIconPath: () => '/icon.png', path: path.posix,
    __dirname: '/app', isDev: false,
  }, ['createWindow', 'showMainWindow'])
  f.createWindow(false)
  assert.equal(windows[0].options.show, false)
  assert.equal(events.length, 0)
  f.showMainWindow()
  assert.equal(windows.length, 1)
  assert.deepEqual(events, ['show', 'focus'])
  f.state.mainWindow = null
  f.showMainWindow()
  assert.equal(windows[1].options.show, true)
})

test('queued UI saves preserve startup preferences when appearance changes concurrently', async () => {
  const ref = value => ({ value })
  const writes = []
  let finishFirst
  const f = loadSource('src/App.vue', {}, {
    settingsSaveQueue: Promise.resolve(),
    themeMode: ref('system'), themeColor: ref('blue'), language: ref('zh-CN'), webuiOpenMode: ref('launcher'),
    closeAction: ref('minimize'), closeReminder: ref(true), autoUpdate: ref(true), autoDownloadUpdate: ref(true),
    launchAtLogin: ref(false), startMinimized: ref(false), persistInstanceState: ref(false),
    requireLauncherBridge: () => ({ settings: { save: async settings => {
      writes.push(settings)
      if (writes.length === 1) await new Promise(resolve => { finishFirst = resolve })
      return settings
    } } }),
  }, ['queueSettingsSave'])
  const startup = f.queueSettingsSave({ launchAtLogin: true, persistInstanceState: true })
  await new Promise(resolve => setImmediate(resolve))
  f.state.themeMode.value = 'dark'
  const appearance = f.queueSettingsSave()
  finishFirst()
  await Promise.all([startup, appearance])
  assert.equal(writes[1].launchAtLogin, true)
  assert.equal(writes[1].persistInstanceState, true)
  assert.equal(writes[1].themeMode, 'dark')
})

test('all locale keys and interpolation variables match', () => {
  const { messages } = loadSource('src/i18n/messages.ts')
  function leaves(value, prefix = '') {
    return Object.entries(value).flatMap(([key, item]) => typeof item === 'object'
      ? leaves(item, prefix + key + '.') : [[prefix + key, [...item.matchAll(/\{([^}]+)\}/g)].map(match => match[1]).sort()]])
      .sort(([a], [b]) => a.localeCompare(b))
  }
  const locales = Object.values(messages)
  for (const locale of locales.slice(1)) assert.deepEqual(leaves(locale), leaves(locales[0]))
})

function sessionStoreFixture(initial, failure) {
  const files = new Map(initial === undefined ? [] : [['/settings/project-session.json', initial]])
  const writes = []
  const fs = {
    mkdir: async () => {},
    readFile: async file => {
      if (!files.has(file)) throw Object.assign(new Error('missing'), { code: 'ENOENT' })
      return files.get(file)
    },
    writeFile: async (file, content, options) => { writes.push({ file, options }); files.set(file, content) },
    rename: async (from, to) => {
      if (failure) throw new Error('private disk detail')
      files.set(to, files.get(from)); files.delete(from)
    },
  }
  return { ...loadSource('electron/project-session.ts', {
    electron: { app: { getPath: () => '/settings' } }, 'node:fs': { promises: fs }, 'node:path': path.posix,
  }), files, writes }
}

test('project sessions tolerate a missing file and filter malformed IDs without storing runtime or secrets', async () => {
  const f = sessionStoreFixture()
  assert.deepEqual(Array.from(await f.loadProjectSession()), [])
  await f.saveProjectSession(['local', 'local', 'another'])
  assert.equal(f.files.get('/settings/project-session.json'), '["local","another"]\n')
  assert.equal(f.files.has('/settings/project-session.json.tmp'), false)
  assert.equal(f.writes[0].options.mode, 0o600)
  f.files.set('/settings/project-session.json', '["local",null,42,"",{}, "local"]')
  assert.deepEqual(Array.from(await f.loadProjectSession()), ['local'])
  f.files.set('/settings/project-session.json', '{"ids":["local"]}')
  assert.deepEqual(Array.from(await f.loadProjectSession()), [])
  f.files.set('/settings/project-session.json', '{broken')
  await assert.rejects(f.loadProjectSession(), /JSON/)
})

test('an unsuccessful atomic session replacement preserves the previous snapshot', async () => {
  const f = sessionStoreFixture('["previous"]', true)
  await assert.rejects(f.saveProjectSession(['new']), /private disk detail/)
  assert.equal(f.files.get('/settings/project-session.json'), '["previous"]')
})

function sessionLifecycleFixture(overrides = {}) {
  const events = []
  const f = loadSource('electron/main.ts', {}, {
    currentSettings: { persistInstanceState: true },
    settingsSaveQueue: Promise.resolve(), stoppingLocalProjects: false, isQuitting: false, localProjectsStopPromise: null,
    launchedProjects: new Map([['running', {}]]), startingProjects: new Map([['starting', {}]]),
    pendingProjectRestores: new Set(),
    loadProjectSession: async () => ['local', 'local', 'cloud', 'removed'],
    saveProjectSession: async ids => events.push(['save', Array.from(ids)]),
    loadProjects: async () => [{ id: 'local', type: 'local' }, { id: 'cloud', type: 'cloud' }],
    startLocalProject: async id => events.push(['start', id]),
    stopLocalProject: async id => events.push(['stop', id]),
    publishProjectChange: () => events.push(['changed']),
    writeLauncherLog: (...args) => events.push(['log', ...args]),
    stopLocalProjectsForExit: undefined,
    app: { quit: () => events.push(['quit']) },
    ...overrides,
  }, ['prepareProjectRestore', 'restoreLocalProjects', 'stopLocalProjectsForExit', 'persistAndStopLocalProjects', 'quitApplication'])
  return { ...f, events }
}

test('a session is consumed once and only existing local projects are restored', async () => {
  const f = sessionLifecycleFixture()
  await f.prepareProjectRestore()
  assert.deepEqual(Array.from(f.state.pendingProjectRestores), ['local'])
  assert.deepEqual(f.events, [['save', []]])
  await f.restoreLocalProjects()
  assert.deepEqual(f.events, [['save', []], ['start', 'local'], ['changed']])
  await f.restoreLocalProjects()
  assert.equal(f.events.filter(([kind]) => kind === 'start').length, 1)
})

test('disabled restoration clears stale snapshots without starting projects', async () => {
  const f = sessionLifecycleFixture({ currentSettings: { persistInstanceState: false } })
  await f.prepareProjectRestore()
  await f.restoreLocalProjects()
  assert.deepEqual(f.events, [['save', []]])
})

test('unreadable or unconsumable sessions never start instances or expose private errors', async () => {
  for (const method of ['loadProjectSession', 'saveProjectSession']) {
    const f = sessionLifecycleFixture({ [method]: async () => { throw new Error('secret path/token') } })
    await f.prepareProjectRestore()
    await f.restoreLocalProjects()
    assert.equal(f.events.some(([kind]) => kind === 'start'), false)
    assert.equal(JSON.stringify(f.events).includes('secret'), false)
  }
})

test('restoration isolates failures, cleans up a failed process, and continues to the next instance', async () => {
  const started = []
  const f = sessionLifecycleFixture({
    pendingProjectRestores: new Set(['bad', 'good']),
    startLocalProject: async id => { started.push(id); if (id === 'bad') throw new Error('private reason') },
  })
  await f.restoreLocalProjects()
  assert.deepEqual(started, ['bad', 'good'])
  assert.deepEqual(f.events.filter(([kind]) => kind === 'stop'), [['stop', 'bad']])
  assert.equal(f.state.pendingProjectRestores.size, 0)
  assert.equal(f.events.filter(([kind]) => kind === 'changed').length, 2)
  assert.equal(JSON.stringify(f.events).includes('private reason'), false)
})

test('quitting snapshots running, starting and queued restores before stopping and exiting', async () => {
  const f = sessionLifecycleFixture({ pendingProjectRestores: new Set(['running', 'queued']) })
  await f.quitApplication()
  assert.deepEqual(f.events, [['save', ['running', 'starting', 'queued']], ['stop', 'running'], ['quit']])
  assert.equal(f.state.stoppingLocalProjects, true)
  assert.equal(f.state.isQuitting, true)
})

test('exit honors an accepted settings save and still stops processes when snapshot saving fails', async () => {
  let finishSave
  const f = sessionLifecycleFixture({
    settingsSaveQueue: new Promise(resolve => { finishSave = resolve }),
    saveProjectSession: async () => { throw new Error('secret disk detail') },
    stopLocalProject: async () => { throw new Error('private stop detail') },
  })
  const quit = f.quitApplication()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(f.events.length, 0)
  finishSave()
  await quit
  assert.deepEqual(f.events.at(-1), ['quit'])
  assert.equal(JSON.stringify(f.events).includes('secret'), false)
})

test('disabled persistence writes an empty exit snapshot', async () => {
  const f = sessionLifecycleFixture({ currentSettings: { persistInstanceState: false } })
  await f.quitApplication()
  assert.deepEqual(f.events[0], ['save', []])
})

test('exiting during restoration stops the restore queue and retains unattempted IDs', async () => {
  const started = []
  let finishStart
  const f = sessionLifecycleFixture({
    pendingProjectRestores: new Set(['first', 'second']),
    startLocalProject: id => { started.push(id); return new Promise(resolve => { finishStart = resolve }) },
  })
  const restoring = f.restoreLocalProjects()
  await f.quitApplication()
  finishStart()
  await restoring
  assert.deepEqual(started, ['first'])
  assert.ok(f.events.find(([kind, ids]) => kind === 'save' && ids.includes('second')))
})

test('manual and automatic starts share one launch and no new launch begins while exiting', async () => {
  let launches = 0, finish
  const f = loadSource('electron/main.ts', {}, {
    stoppingLocalProjects: false, startingProjects: new Map(),
    launchLocalProject: () => { launches++; return new Promise(resolve => { finish = resolve }) },
  }, ['startLocalProject'])
  const automatic = f.startLocalProject('local', () => {})
  const manual = f.startLocalProject('local', () => {})
  assert.equal(launches, 1)
  finish()
  await Promise.all([automatic, manual])
  assert.equal(f.state.startingProjects.size, 0)
  f.state.stoppingLocalProjects = true
  await assert.rejects(f.startLocalProject('another', () => {}), /LOCAL_START_FAILED/)
  assert.equal(launches, 1)
})

test('minimizing or cancelling close never snapshots or stops instances', async () => {
  for (const cancelled of [false, true]) {
    const events = []
    const f = loadSource('electron/main.ts', {}, {
      isQuitting: false, closePromptInProgress: false,
      currentSettings: { closeReminder: cancelled },
      confirmApplicationClose: async () => false,
      tray: {}, mainWindow: { hide: () => events.push('hide') },
      quitApplication: async () => events.push('quit'),
    }, ['requestApplicationClose'])
    await f.requestApplicationClose(cancelled ? 'quit' : 'minimize')
    assert.deepEqual(events, cancelled ? [] : ['hide'])
  }
})

test('the project change bridge forwards lifecycle notifications and removes its listener', () => {
  const ipc = new EventEmitter()
  let bridge
  loadSource('electron/preload.cts', {
    electron: { contextBridge: { exposeInMainWorld: (_name, api) => { bridge = api } }, ipcRenderer: ipc },
  })
  let changed = 0
  const remove = bridge.projects.onChanged(() => changed++)
  ipc.emit('projects:changed', {}, 'untrusted payload')
  assert.equal(changed, 1)
  remove()
  ipc.emit('projects:changed')
  assert.equal(changed, 1)
})

test('an unsaved restore preference does not change the displayed switch on save failure', async () => {
  const errors = []
  const f = loadSource('src/App.vue', {}, {
    startupSaving: { value: false }, persistInstanceState: { value: false },
    queueSettingsSave: async () => { throw new Error('private save failure') },
    messageHost: { value: { error: message => errors.push(message) } },
    t: { value: { settingsSaveFailed: 'Could not save' } },
  }, ['saveBehaviorSettings'])
  await f.saveBehaviorSettings({ persistInstanceState: true })
  assert.equal(f.state.persistInstanceState.value, false)
  assert.equal(f.state.startupSaving.value, false)
  assert.deepEqual(errors, ['Could not save'])
})

test('simultaneous update and normal exits share one snapshot write and one stop sequence', async () => {
  let finishSave
  const saved = []
  const f = sessionLifecycleFixture({
    saveProjectSession: ids => { saved.push(Array.from(ids)); return new Promise(resolve => { finishSave = resolve }) },
  })
  const updating = f.stopLocalProjectsForExit()
  const closing = f.stopLocalProjectsForExit()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(saved.length, 1)
  finishSave()
  await Promise.all([updating, closing])
  assert.deepEqual(f.events, [['stop', 'running']])
})

test('a normal exit snapshot restores local instances in a fresh launcher session', async () => {
  const store = sessionStoreFixture()
  const first = sessionLifecycleFixture({
    launchedProjects: new Map([['local', {}]]), startingProjects: new Map(),
    saveProjectSession: store.saveProjectSession,
  })
  await first.quitApplication()
  const second = sessionLifecycleFixture({
    loadProjectSession: store.loadProjectSession,
    saveProjectSession: store.saveProjectSession,
  })
  await second.prepareProjectRestore()
  await second.restoreLocalProjects()
  assert.deepEqual(second.events, [['start', 'local'], ['changed']])
  assert.deepEqual(Array.from(await store.loadProjectSession()), [])
})

test('exit during dependency installation prevents a late local process from spawning', async () => {
  let spawns = 0
  const f = loadSource('electron/main.ts', {}, {
    stoppingLocalProjects: false,
    launchedProjects: new Map(),
    loadProjects: async () => [{ id: 'local', name: 'Test', type: 'local', projectPath: '/project' }],
    writeLauncherLog: () => {}, getLocalProject: async () => ({ port: 5267 }),
    getLocalWebuiUrl: () => 'http://localhost:5267', ensureLocalPortAvailable: async () => {},
    path: path.posix, process: { platform: 'linux', env: {} }, fs: { access: async () => {} },
    selectFastestPackageIndex: async () => 'https://pypi.org/simple/', hasUv: async () => true,
    runProjectCommand: async () => { f.state.stoppingLocalProjects = true },
    spawn: () => { spawns++; return new EventEmitter() },
  }, ['launchLocalProject'])
  await assert.rejects(f.launchLocalProject('local', () => {}), /LOCAL_START_FAILED/)
  assert.equal(spawns, 0)
})
