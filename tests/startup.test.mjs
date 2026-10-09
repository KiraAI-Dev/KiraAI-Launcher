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
  for (const input of [{}, { launchAtLogin: 'true', startMinimized: 1 }]) {
    assert.equal(settings.sanitizeSettings(input).launchAtLogin, false)
    assert.equal(settings.sanitizeSettings(input).startMinimized, false)
  }
  await settings.saveSettings({ launchAtLogin: true, startMinimized: true })
  assert.equal((await settings.loadSettings()).launchAtLogin, true)
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
    launchAtLogin: ref(false), startMinimized: ref(false),
    requireLauncherBridge: () => ({ settings: { save: async settings => {
      writes.push(settings)
      if (writes.length === 1) await new Promise(resolve => { finishFirst = resolve })
      return settings
    } } }),
  }, ['queueSettingsSave'])
  const startup = f.queueSettingsSave({ launchAtLogin: true })
  await new Promise(resolve => setImmediate(resolve))
  f.state.themeMode.value = 'dark'
  const appearance = f.queueSettingsSave()
  finishFirst()
  await Promise.all([startup, appearance])
  assert.equal(writes[1].launchAtLogin, true)
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
