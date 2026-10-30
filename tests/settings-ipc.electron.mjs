import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import ts from 'typescript'

// Run explicitly: node --test tests/settings-ipc.electron.mjs (requires a desktop session).
test('real Vue refs save appearance and behavior through the actual Electron preload', () => {
  const require = createRequire(import.meta.url)
  const root = fileURLToPath(new URL('..', import.meta.url))
  const source = readFileSync(new URL('../src/App.vue', import.meta.url), 'utf8').split('<script setup lang="ts">')[1].split('</script>')[0]
  const ast = ts.createSourceFile('App.ts', source, ts.ScriptTarget.Latest, true)
  const functions = ast.statements.filter(node => ts.isFunctionDeclaration(node) && ['queueSettingsSave', 'restoreSettings'].includes(node.name?.text)).map(node => node.getText(ast)).join('\n')
  const transpile = code => ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText
  const renderer = `
    const { ref } = Vue;
    const globalEnvironmentVariables = ref({});
    const globalEnvironmentDraft = ref('');
    const settingsReady = ref(false), startupSupported = ref(false);
    const environmentMode = ref('auto'), themeMode = ref('system'), themeColor = ref('blue'), language = ref('zh-CN'), webuiOpenMode = ref('launcher'), closeAction = ref('minimize');
    const closeReminder = ref(true), persistInstanceState = ref(false), autoUpdate = ref(true), autoDownloadUpdate = ref(true), launchAtLogin = ref(false), startMinimized = ref(false);
    let settingsSaveQueue = Promise.resolve();
    const requireLauncherBridge = () => window.kiraLauncher;
    const formatEnvironmentVariables = env => Object.entries(env).map(([k,v]) => k + '=' + v).join('\\n');
    ${transpile(functions)}
    (async () => {
      await restoreSettings();
      if (!Vue.isProxy(globalEnvironmentVariables.value)) throw new Error('Expected a real Vue proxy');
      themeColor.value = 'purple';
      await queueSettingsSave();
      await queueSettingsSave({ environmentVariables: { IPC_TEST: 'value' } });
      themeMode.value = 'dark';
      await queueSettingsSave({ launchAtLogin: true, persistInstanceState: true });
      const saved = await window.kiraLauncher.settings.load();
      return { platform: window.kiraLauncher.platform, themeColor: saved.themeColor, themeMode: saved.themeMode, value: saved.environmentVariables.IPC_TEST, launchAtLogin: saved.launchAtLogin, persistInstanceState: saved.persistInstanceState };
    })()
  `
  const tempRoot = path.resolve(os.tmpdir())
  const temp = mkdtempSync(path.join(tempRoot, 'kira-settings-ipc-'))
  try {
    writeFileSync(path.join(temp, 'preload.cjs'), transpile(readFileSync(new URL('../electron/preload.cts', import.meta.url), 'utf8')))
    writeFileSync(path.join(temp, 'main.cjs'), `
      const { app, BrowserWindow, ipcMain } = require('electron');
      const fs = require('node:fs'), path = require('node:path');
      app.setPath('userData', path.join(__dirname, 'profile'));
      app.whenReady().then(async () => {
        const win = new BrowserWindow({ show: false, webPreferences: { contextIsolation: true, nodeIntegration: false, preload: path.join(__dirname, 'preload.cjs') } });
        let saved = { environmentVariables: {}, environmentMode: 'auto', themeMode: 'system', themeColor: 'blue', language: 'zh-CN', webuiOpenMode: 'launcher', closeAction: 'minimize', closeReminder: true, persistInstanceState: false, autoUpdate: true, autoDownloadUpdate: true, launchAtLogin: false, startMinimized: false };
        ipcMain.handle('settings:load', () => saved);
        ipcMain.handle('settings:startup-supported', () => true);
        ipcMain.handle('settings:save', (_event, value) => { saved = value; return saved });
        try {
          await win.loadURL('data:text/html,<html></html>');
          const vue = fs.readFileSync(${JSON.stringify(require.resolve('vue/dist/vue.global.prod.js'))}, 'utf8');
          const result = await win.webContents.executeJavaScript(vue + '\\n' + ${JSON.stringify(renderer)});
          console.log('IPC_RESULT:' + JSON.stringify(result));
        } catch (error) { console.log('IPC_ERROR:' + error.message); process.exitCode = 1; }
        finally { win.destroy(); app.quit(); }
      });
      setTimeout(() => app.exit(2), 15000).unref();
    `)
    const env = { ...process.env }
    delete env.ELECTRON_RUN_AS_NODE
    const result = spawnSync(require('electron'), [path.join(temp, 'main.cjs')], { cwd: root, env, windowsHide: true, encoding: 'utf8', timeout: 20000 })
    assert.ifError(result.error)
    assert.equal(result.status, 0, result.stdout + result.stderr)
    const line = result.stdout.split(/\r?\n/).find(line => line.startsWith('IPC_RESULT:'))
    assert.ok(line, result.stdout + result.stderr)
    assert.deepEqual(JSON.parse(line.slice('IPC_RESULT:'.length)), { platform: process.platform, themeColor: 'purple', themeMode: 'dark', value: 'value', launchAtLogin: true, persistInstanceState: true })
  } finally {
    assert.equal(path.dirname(path.resolve(temp)), tempRoot)
    assert.ok(path.basename(temp).startsWith('kira-settings-ipc-'))
    rmSync(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
})
