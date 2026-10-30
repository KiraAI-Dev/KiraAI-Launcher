import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import test from 'node:test'
import ts from 'typescript'

function load(file, dependencies = {}) {
  const source = readFileSync(new URL('../' + file, import.meta.url), 'utf8')
  const { outputText } = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } })
  const exports = {}
  vm.runInNewContext(outputText, { exports, require: id => {
    assert.ok(id in dependencies, 'Unexpected dependency: ' + id)
    return dependencies[id]
  }, Error, process })
  return exports
}
const variables = load('electron/environment-variables.ts')

test('global environment persists empty values, spaces and equals signs; old settings default empty', async () => {
  const files = new Map()
  const fs = { mkdir: async () => {}, readFile: async file => files.get(file),
    writeFile: async (file, data) => files.set(file, data),
    rename: async (from, to) => { files.set(to, files.get(from)); files.delete(from) } }
  const settings = load('electron/settings.ts', {
    './environment-variables.js': variables,
    electron: { app: { getPath: () => '/settings' } }, 'node:fs': { promises: fs }, 'node:path': path.posix,
  })
  assert.equal(Object.keys(settings.sanitizeSettings({}).environmentVariables).length, 0)
  const env = variables.parseEnvironmentVariables('HTTP_PROXY=http://localhost:7890\nEMPTY=\nTOKEN= a=b \n\n')
  await settings.saveSettings({ environmentVariables: env })
  const restored = (await settings.loadSettings()).environmentVariables
  assert.equal(restored.HTTP_PROXY, 'http://localhost:7890')
  assert.equal(restored.EMPTY, '')
  assert.equal(restored.TOKEN, ' a=b ')
  await assert.rejects(settings.saveSettings({ environmentVariables: { 'bad-name': 'value' } }), /ENVIRONMENT_VARIABLES_INVALID/)
  assert.equal((await settings.loadSettings()).environmentVariables.TOKEN, ' a=b ')
  await settings.saveSettings({ environmentVariables: {} })
  assert.equal(Object.keys((await settings.loadSettings()).environmentVariables).length, 0)
})

test('invalid names, duplicates, nulls and oversized values are rejected', () => {
  for (const input of ['NO_EQUALS', '1BAD=x', '=x', 'BAD-KEY=x', 'A=1\nA=2', 'A=bad\0value', 'A=' + 'x'.repeat(16385), Array.from({ length: 129 }, (_, i) => `V${i}=x`).join('\n')]) {
    assert.throws(() => variables.parseEnvironmentVariables(input), /ENVIRONMENT_VARIABLES_INVALID/)
  }
  for (const input of [null, [], { A: 1 }]) assert.equal(variables.sanitizeEnvironmentVariables(input), null)
})

test('instance overrides global, global overrides system, deleting overrides restores inheritance', () => {
  for (const platform of ['win32', 'linux', 'darwin']) {
    const base = { SHARED: 'system', SYSTEM_ONLY: 'keep' }
    const merged = variables.mergeEnvironmentVariables(base, { SHARED: 'global', GLOBAL_ONLY: '' }, { SHARED: 'project' }, platform)
    assert.equal(merged.SHARED, 'project')
    assert.equal(merged.SYSTEM_ONLY, 'keep')
    assert.equal(merged.GLOBAL_ONLY, '')
    assert.equal(base.SHARED, 'system')
    assert.equal(variables.mergeEnvironmentVariables(base, {}, {}, platform).SHARED, 'system')
  }
  const windows = variables.mergeEnvironmentVariables({ Path: 'system' }, { PATH: 'global' }, { path: 'project' }, 'win32')
  assert.equal(Object.keys(windows).length, 1)
  assert.equal(windows.path, 'project')
  const linux = variables.mergeEnvironmentVariables({ Path: 'system' }, { PATH: 'global' }, {}, 'linux')
  assert.equal(linux.Path, 'system')
  assert.equal(linux.PATH, 'global')
})

test('global environment translations have identical keys and interpolation variables', () => {
  const { globalEnvironmentMessages } = load('src/i18n/messages.ts')
  const shape = locale => Object.entries(locale).map(([key, value]) => [key, [...value.matchAll(/\{([^}]+)\}/g)].map(match => match[1]).sort()])
  assert.deepEqual(shape(globalEnvironmentMessages['zh-CN']), shape(globalEnvironmentMessages['en-US']))
})

test('Windows rejects case-only duplicates while POSIX names remain distinct', () => {
  for (const text of ['PATH=first\nPath=second', 'PATH=first\nPath:="second"']) {
    assert.throws(() => variables.parseEnvironmentVariables(text, true), /ENVIRONMENT_VARIABLES_INVALID/)
    const posix = variables.parseEnvironmentVariables(text, false)
    assert.equal(posix.PATH, 'first')
    assert.equal(posix.Path, 'second')
  }
  assert.equal(variables.sanitizeEnvironmentVariables({ PATH: 'a', Path: 'b' }, true), null)
  assert.ok(variables.sanitizeEnvironmentVariables({ PATH: 'a', Path: 'b' }, false))
})

test('global and project editors round-trip multiline values without changing literal strings', () => {
  const original = { CERT: 'first\nNEXT=value', CRLF: 'first\r\nsecond\r', QUOTED: '"literal\\n"', PATH_VALUE: 'C:\\new\\test', EMPTY: '', SPACE: ' a=b ', ENCODED_LOOKING: ':="quoted"' }
  const formatted = variables.formatEnvironmentVariables(original)
  assert.equal(formatted.split('\n').length, Object.keys(original).length)
  assert.equal(formatted.includes('CERT:='), true)
  assert.deepEqual({ ...variables.parseEnvironmentVariables(formatted) }, original)
  assert.deepEqual({ ...variables.parseEnvironmentVariables(formatted.replaceAll('\n', '\r\n')) }, original)
  for (const text of ['A:=null', 'A:=1', 'A:=[]', 'A:={}', 'A:="unterminated', 'A:="\\u0000"', 'A:=true']) {
    assert.throws(() => variables.parseEnvironmentVariables(text), /ENVIRONMENT_VARIABLES_INVALID/)
  }
  for (const rawValue of ['"quoted"', '\\n', ':="quoted"']) {
    assert.equal(variables.parseEnvironmentVariables('A=' + rawValue).A, rawValue)
  }
})

test('invalid stored environment maps preserve other settings without overwriting the file', async () => {
  for (const bad of [null, [], { 'BAD-KEY': 'x' }, { A: 1 }, { A: 'bad\0value' }, { A: 'x'.repeat(16385) }]) {
    const original = JSON.stringify({ themeColor: 'purple', language: 'en-US', launchAtLogin: true, environmentVariables: bad })
    let writes = 0
    const settings = load('electron/settings.ts', {
      './environment-variables.js': variables,
      electron: { app: { getPath: () => '/settings' } }, 'node:path': path.posix,
      'node:fs': { promises: { readFile: async () => original, mkdir: async () => {}, writeFile: async () => { writes++ }, rename: async () => {} } },
    })
    const restored = await settings.loadSettings()
    assert.equal(restored.themeColor, 'purple')
    assert.equal(restored.language, 'en-US')
    assert.equal(restored.launchAtLogin, true)
    assert.equal(Object.keys(restored.environmentVariables).length, 0)
    assert.equal(writes, 0)
    await assert.rejects(settings.saveSettings({ themeColor: 'green', environmentVariables: bad }), /ENVIRONMENT_VARIABLES_INVALID/)
    assert.equal(writes, 0)
  }
})
