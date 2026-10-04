import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
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
  const state = vm.createContext({ exports: {}, require: (id) => {
    assert.ok(id in dependencies, 'Unexpected dependency: ' + id)
    return dependencies[id]
  }, Error, ...globals })
  vm.runInContext(outputText, state)
  return { ...state.exports, state }
}

function updateResult(updateAvailable = true) {
  return { currentVersion: '0.4.0', latestVersion: updateAvailable ? '0.5.0' : '0.4.0', updateAvailable,
    downloaded: false, downloading: false, downloadProgress: null, downloadFailed: false,
    releaseUrl: 'https://github.com/KiraAI-Dev/KiraAI-Launcher/releases/latest', releaseNotes: 'Release notes' }
}

function updaterFixture({ autoDownloadUpdate = false, supported = true, available = true, cached = false } = {}) {
  const updater = new EventEmitter(), sent = [], downloads = [], opened = []
  let checks = 0, installs = 0
  updater.checkForUpdates = async () => {
    checks++
    if (available) updater.emit('update-available')
    return { updateInfo: { version: available ? '0.5.0' : '0.4.0' } }
  }
  updater.downloadUpdate = () => {
    const pending = {}
    const promise = new Promise((resolve, reject) => {
      pending.fail = () => reject(new Error('Private network detail'))
      pending.finish = () => { updater.emit('update-downloaded'); resolve(['installer']) }
    })
    downloads.push(pending)
    if (cached) pending.finish()
    return promise
  }
  updater.quitAndInstall = () => { installs++ }
  const fixture = loadSource('electron/main.ts', {}, {
    autoUpdater: updater, canUseAutoUpdater: () => supported,
    process: { platform: 'win32', arch: 'x64' }, app: { getVersion: () => '0.4.0' },
    currentSettings: { autoDownloadUpdate }, updateDownloaded: false,
    latestUpdateCheck: null, latestUpdateDownloadPromise: null, updateCheckPromise: null, isQuitting: false,
    mainWindow: { isDestroyed: () => false, webContents: { send: (channel, status) => sent.push({ channel, status }) } },
    checkLauncherRelease: async () => updateResult(available),
    isNewerVersion: (latest, current) => latest !== current, normalizeReleaseNotes: () => '',
    LAUNCHER_RELEASES_URL: updateResult().releaseUrl, shell: { openExternal: async (url) => opened.push(url) },
  }, ['configureAutoUpdater', 'publishLauncherUpdate', 'downloadLauncherUpdate', 'applyLauncherUpdateSettings', 'checkLauncherUpdate', 'installLauncherUpdate'])
  fixture.configureAutoUpdater()
  return { ...fixture, updater, sent, downloads, opened, checks: () => checks, installs: () => installs }
}

const settle = () => new Promise((resolve) => setImmediate(resolve))

test('legacy settings retain automatic downloads while explicit false is saved and loaded', async () => {
  const files = new Map()
  const fs = { readFile: async (file) => files.get(file), mkdir: async () => {},
    writeFile: async (file, content) => files.set(file, content),
    rename: async (from, to) => { files.set(to, files.get(from)); files.delete(from) } }
  const settings = loadSource('electron/settings.ts', {
    electron: { app: { getPath: () => '/settings' } }, 'node:fs': { promises: fs },
    'node:path': { join: (...parts) => parts.join('/'), dirname: () => '/settings' },
  })
  assert.equal(settings.sanitizeSettings({ autoUpdate: false }).autoDownloadUpdate, true)
  assert.equal(settings.sanitizeSettings({ autoDownloadUpdate: 'false' }).autoDownloadUpdate, true)
  await settings.saveSettings({ autoDownloadUpdate: false })
  assert.equal((await settings.loadSettings()).autoDownloadUpdate, false)
})

test('disabled automatic downloads only check and publish release metadata', async () => {
  const fixture = updaterFixture()
  const result = await fixture.checkLauncherUpdate()
  assert.equal(result.updateAvailable, true)
  assert.equal(result.downloadProgress, null)
  assert.equal(fixture.downloads.length, 0)
  assert.equal(fixture.updater.autoDownload, false)
  assert.equal(fixture.sent[0].channel, 'updates:status')
})

test('automatic downloads publish initial progress, live percentage and completion', async () => {
  const fixture = updaterFixture({ autoDownloadUpdate: true })
  const result = await fixture.checkLauncherUpdate()
  assert.equal(fixture.downloads.length, 1)
  assert.equal(result.downloading, true)
  assert.equal(result.downloadProgress, 0)
  assert.equal(fixture.sent[0].status.downloadProgress, null)
  fixture.updater.emit('download-progress', { percent: 37.6 })
  assert.equal(fixture.state.latestUpdateCheck.downloadProgress, 37.6)
  fixture.updater.emit('download-progress', { percent: 101 })
  assert.equal(fixture.state.latestUpdateCheck.downloadProgress, 100)
  fixture.downloads[0].finish()
  await settle()
  assert.equal(fixture.state.latestUpdateCheck.downloaded, true)
  assert.equal(fixture.state.latestUpdateCheck.downloading, false)
  assert.equal(fixture.state.latestUpdateDownloadPromise, null)
  assert.equal(fixture.installs(), 0)
})

test('manual update waits for download and installs only after it completes', async () => {
  const fixture = updaterFixture()
  await fixture.checkLauncherUpdate()
  const installing = fixture.installLauncherUpdate()
  assert.equal(fixture.state.latestUpdateCheck.downloading, true)
  assert.equal(fixture.installs(), 0)
  fixture.updater.emit('download-progress', { percent: 52 })
  assert.equal(fixture.state.latestUpdateCheck.downloadProgress, 52)
  fixture.downloads[0].finish()
  await installing
  assert.equal(fixture.installs(), 1)
  assert.equal(fixture.state.isQuitting, true)
})

test('manual installation and repeated checks share an ongoing automatic download', async () => {
  const fixture = updaterFixture({ autoDownloadUpdate: true })
  await fixture.checkLauncherUpdate()
  fixture.updater.emit('download-progress', { percent: 45 })
  assert.equal((await fixture.checkLauncherUpdate()).downloadProgress, 45)
  const installing = fixture.installLauncherUpdate()
  assert.equal(fixture.downloads.length, 1)
  assert.equal(fixture.checks(), 1)
  fixture.downloads[0].finish()
  await installing
  await fixture.installLauncherUpdate()
  assert.equal(fixture.downloads.length, 1, 'downloaded installers must be reused')
})

test('failed automatic download exposes a safe error and manual retry downloads again', async () => {
  const fixture = updaterFixture({ autoDownloadUpdate: true })
  await fixture.checkLauncherUpdate()
  fixture.updater.emit('download-progress', { percent: 18 })
  fixture.downloads[0].fail()
  await settle()
  assert.equal(fixture.state.latestUpdateCheck.downloadFailed, true)
  assert.equal(fixture.state.latestUpdateCheck.downloading, false)
  assert.equal(fixture.state.latestUpdateCheck.downloadProgress, 18)
  assert.equal(fixture.state.latestUpdateDownloadPromise, null)
  const installing = fixture.installLauncherUpdate()
  assert.equal(fixture.downloads.length, 2)
  assert.equal(fixture.state.latestUpdateCheck.downloadFailed, false)
  assert.equal(fixture.state.latestUpdateCheck.downloadProgress, 0)
  fixture.downloads[1].finish()
  await installing
})

test('manual download failure does not install and remains retryable', async () => {
  const fixture = updaterFixture()
  await fixture.checkLauncherUpdate()
  const installing = fixture.installLauncherUpdate()
  fixture.downloads[0].fail()
  await assert.rejects(installing, /^Error: LAUNCHER_UPDATE_INSTALL_FAILED$/)
  assert.equal(fixture.installs(), 0)
  assert.equal(fixture.state.latestUpdateCheck.downloadFailed, true)
})

test('cached downloads complete after metadata is available and return completed status', async () => {
  const fixture = updaterFixture({ autoDownloadUpdate: true, cached: true })
  const result = await fixture.checkLauncherUpdate()
  assert.equal(result.downloaded, true)
  assert.equal(result.downloadProgress, 100)
  assert.equal(fixture.sent.at(-1).status.downloaded, true)
  await settle()
  assert.equal(fixture.state.latestUpdateDownloadPromise, null)
})

test('enabling automatic downloads starts an already discovered update once', async () => {
  const fixture = updaterFixture()
  await fixture.checkLauncherUpdate()
  fixture.state.currentSettings = { autoDownloadUpdate: true }
  fixture.applyLauncherUpdateSettings({ autoDownloadUpdate: false })
  fixture.applyLauncherUpdateSettings({ autoDownloadUpdate: true })
  assert.equal(fixture.downloads.length, 1)
  fixture.state.currentSettings = { autoDownloadUpdate: false }
  fixture.applyLauncherUpdateSettings({ autoDownloadUpdate: true })
  assert.equal(fixture.downloads.length, 1)
  fixture.downloads[0].finish()
  await settle()
})

test('latest versions never start a download even with automatic downloads enabled', async () => {
  const fixture = updaterFixture({ autoDownloadUpdate: true, available: false })
  assert.equal((await fixture.checkLauncherUpdate()).updateAvailable, false)
  assert.equal(fixture.downloads.length, 0)
})

test('portable and development builds retain their release-page update flow', async () => {
  const fixture = updaterFixture({ autoDownloadUpdate: true, supported: false })
  await fixture.checkLauncherUpdate()
  await fixture.installLauncherUpdate()
  assert.equal(fixture.checks(), 0)
  assert.equal(fixture.downloads.length, 0)
  assert.equal(fixture.opened[0], updateResult().releaseUrl)
})

function rendererFixture(check = async () => updateResult(false)) {
  const toasts = [], prompts = []
  const fixture = loadSource('src/App.vue', {}, {
    updateChecking: { value: false }, updateInstalling: { value: false }, updateAvailable: { value: false },
    updateCheckError: { value: '' }, updateCheckResult: { value: null }, updateRestartPromptShown: false,
    aboutText: { value: { latest: 'Latest ({version})', failed: 'Check failed', downloadFailed: 'Download failed', updateFailed: 'Update failed' } },
    messageHost: { value: { success: (content) => toasts.push(content) } },
    dialogHost: { value: { info: (prompt) => prompts.push(prompt) } },
    requireLauncherBridge: () => ({ updates: { check, install: async () => {} } }),
  }, ['checkForUpdates', 'installUpdate', 'applyLauncherUpdateStatus', 'showUpdateRestartPrompt'])
  return { ...fixture, toasts, prompts }
}

test('manual checks show the latest version in a toast and clear content-area results', async () => {
  const fixture = rendererFixture()
  fixture.state.updateCheckResult.value = updateResult()
  await fixture.checkForUpdates()
  assert.deepEqual(fixture.toasts, ['Latest (0.4.0)'])
  assert.equal(fixture.state.updateCheckResult.value, null)
  assert.equal(fixture.state.updateAvailable.value, false)
  assert.equal(fixture.state.updateChecking.value, false)
})

test('background checks stay quiet; new releases and progress stay in the about page', async () => {
  const fixture = rendererFixture(async () => updateResult())
  fixture.applyLauncherUpdateStatus(updateResult(false))
  assert.equal(fixture.toasts.length, 0)
  await fixture.checkForUpdates()
  assert.equal(fixture.toasts.length, 0)
  fixture.applyLauncherUpdateStatus({ ...updateResult(), downloading: true, downloadProgress: 64 })
  assert.equal(fixture.state.updateCheckResult.value.downloadProgress, 64)
  assert.equal(fixture.prompts.length, 0)
  fixture.applyLauncherUpdateStatus({ ...updateResult(), downloaded: true, downloadProgress: 100 })
  assert.equal(fixture.prompts.length, 1)
  fixture.applyLauncherUpdateStatus({ ...updateResult(), downloaded: true, downloadProgress: 100 })
  assert.equal(fixture.prompts.length, 1)
})

test('download errors appear and clear when retry starts; manual install suppresses restart prompt', () => {
  const fixture = rendererFixture()
  fixture.applyLauncherUpdateStatus({ ...updateResult(), downloadFailed: true, downloadProgress: 12 })
  assert.equal(fixture.state.updateCheckError.value, 'Download failed')
  fixture.applyLauncherUpdateStatus({ ...updateResult(), downloading: true, downloadProgress: 0 })
  assert.equal(fixture.state.updateCheckError.value, '')
  fixture.state.updateInstalling.value = true
  fixture.applyLauncherUpdateStatus({ ...updateResult(), downloaded: true, downloadProgress: 100 })
  assert.equal(fixture.prompts.length, 0)
})

test('all locales keep matching keys, placeholders and formatting markers', () => {
  const { messages } = loadSource('src/i18n/messages.ts')
  function signature(value, prefix = '') {
    return Object.entries(value).flatMap(([key, entry]) => {
      const name = prefix + key
      if (typeof entry === 'object') return signature(entry, name + '.')
      return [[name, (entry.match(/\{[^}]+\}|<\/?[^>]+>/g) ?? []).sort()]]
    }).sort(([a], [b]) => a.localeCompare(b))
  }
  assert.deepEqual(signature(messages['zh-CN']), signature(messages['en-US']))
})
