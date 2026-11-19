import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'
import ts from 'typescript'
import { computed, nextTick, reactive, ref, watch } from 'vue'

const source = readFileSync(new URL('../electron/project-upgrade.ts', import.meta.url), 'utf8')
const { outputText } = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } })
const instance = { url: 'https://kira.example.test', accessToken: 'access-token' }
const target = 'v3.10.0'
const releases = (version = 'v3.2.0') => ({
  current_version: version,
  releases: [{ tag_name: 'v4.0.0', draft: true }, { tag_name: 'v5.0.0', prerelease: true }, { tag_name: 'v6.0.0-rc.1' }, { tag_name: 'v3.9.0' }, { tag_name: target }],
})
const task = (status, values = {}) => ({ id: 'task-1', target_version: target, status, overall_percent: 45, ...values })

function fixture(handle, { session = () => 'session-token', tick = 1_000, listProjectReleases = async () => [{ tag: target, prerelease: false }] } = {}) {
  const exports = {}
  const requests = []
  const sessions = []
  let now = 0
  const dependencies = {
    'node:timers/promises': { setTimeout: async () => { now += tick } },
    './project-releases.js': { listProjectReleases },
    './cloud.js': {
      normalizeCloudUrl: (url) => new URL(url).toString().replace(/\/$/, ''),
      getWebuiSessionToken: async (url, accessToken) => {
        sessions.push({ url, accessToken })
        return session(url, sessions.length)
      },
      readJson: (response) => response.json(),
    },
    './http.js': {
      fetchWithTimeout: async (url, timeout, init, read) => {
        const { origin, pathname } = new URL(url)
        requests.push({ origin, pathname, init, timeout })
        const result = await handle(pathname, origin, init)
        return read(result instanceof Response ? result : Response.json(result))
      },
    },
  }
  vm.runInNewContext(outputText, { exports, require: (id) => dependencies[id], Date: { now: () => now }, AbortSignal, Error })
  return { ...exports, requests, sessions, advanceTime: (milliseconds) => { now += milliseconds } }
}

test('version column and bulk dialog share an in-flight check and cache its result for 15 minutes', async () => {
  let resolveRequest
  const waiting = new Promise((resolve) => { resolveRequest = resolve })
  const api = fixture(async () => { await waiting; return releases() })
  const versionColumn = api.checkManagedProjectUpgrade('project', instance)
  const bulkDialog = api.checkManagedProjectUpgrade('project', { ...instance })
  assert.equal(versionColumn, bulkDialog)
  resolveRequest()
  await bulkDialog

  api.advanceTime(15 * 60_000 - 1)
  await api.checkManagedProjectUpgrade('project', instance)
  assert.equal(api.requests.length, 1)
  assert.equal(api.sessions.length, 1)

  api.advanceTime(1)
  await api.checkManagedProjectUpgrade('project', instance)
  assert.equal(api.requests.length, 2)
})

test('refresh and upgrade invalidation bypass the cache, and failed checks remain retryable', async () => {
  let attempts = 0
  const api = fixture(() => {
    if (++attempts === 2) throw new Error('unreachable')
    return releases(attempts === 4 ? target : 'v3.2.0')
  })
  await api.checkManagedProjectUpgrade('project', instance)
  await assert.rejects(api.checkManagedProjectUpgrade('project', instance, true), /unreachable/)
  await api.checkManagedProjectUpgrade('project', instance)
  assert.equal(api.requests.length, 3)

  api.invalidateProjectUpgradeCheck('project')
  assert.equal((await api.checkManagedProjectUpgrade('project', instance)).updateAvailable, false)
  assert.equal(api.requests.length, 4)
})

test('cache entries are not reused after an instance restarts, stops or changes credentials', async () => {
  const api = fixture(() => releases())
  const first = { ...instance, processId: 100 }
  const restarted = { ...instance, processId: 200 }
  await api.checkManagedProjectUpgrade('project', first)
  await api.checkManagedProjectUpgrade('project', restarted)
  await api.checkManagedProjectUpgrade('project', { ...restarted, accessToken: 'new-token' })
  const stopped = await api.checkManagedProjectUpgrade('project', { installedVersion: 'v3.9.0' })
  assert.equal(stopped.requiresStart, true)
  const updated = await api.checkManagedProjectUpgrade('project', { installedVersion: target })
  assert.equal(updated.updateAvailable, false)
  assert.equal(api.requests.length, 3)
})

test('an old pending check cannot restore the cache after invalidation', async () => {
  let resolveRequest
  const waiting = new Promise((resolve) => { resolveRequest = resolve })
  let requests = 0
  const api = fixture(async () => ++requests === 1 ? waiting : releases(target))
  const old = api.checkManagedProjectUpgrade('project', instance)
  api.invalidateProjectUpgradeCheck('project')
  await api.checkManagedProjectUpgrade('project', instance)
  resolveRequest(releases())
  await old

  assert.equal((await api.checkManagedProjectUpgrade('project', instance)).updateAvailable, false)
  assert.equal(requests, 2)
})

test('check selects the newest stable tag numerically and never offers a downgrade', async () => {
  const api = fixture(() => releases('v3.10.1'))
  const checked = await api.checkProjectUpgrade(instance)
  assert.equal(checked.targetVersion, target)
  assert.equal(checked.currentVersion, 'v3.10.1')
  assert.equal(checked.updateAvailable, false)
  assert.equal(api.requests[0].init.headers.Authorization, 'Bearer session-token')
  assert.equal(api.requests[0].init.redirect, 'error')

  const prerelease = fixture(() => releases('v3.10.0-rc.1'))
  assert.equal((await prerelease.checkProjectUpgrade(instance)).updateAvailable, true)
})

test('check handles missing credentials and unsupported update endpoints without posting', async () => {
  const missing = fixture(() => assert.fail('Unexpected request'), { session: () => undefined })
  await assert.rejects(missing.checkProjectUpgrade(instance), /PROJECT_UPGRADE_AUTH_REQUIRED/)
  const unsupported = fixture(() => Response.json({ detail: 'Not Found' }, { status: 404 }))
  await assert.rejects(unsupported.checkProjectUpgrade(instance), /PROJECT_UPGRADE_UNSUPPORTED\n404: Not Found/)
  assert.deepEqual(unsupported.requests.map(({ init }) => init.method), ['GET'])
})

test('stopped local instances only require startup if the installed version is older than the latest stable release', async () => {
  const api = fixture(() => assert.fail('Unexpected request to a stopped instance'), {
    listProjectReleases: async () => [{ tag: 'v3.9.0', prerelease: false }, { tag: 'v4.0.0', prerelease: true }, { tag: target, prerelease: false }],
  })
  for (const installed of [target, '3.10.0', 'v3.10.1']) {
    const checked = await api.checkStoppedProjectUpgrade(installed)
    assert.equal(checked.currentVersion, installed)
    assert.equal(checked.updateAvailable, false)
    assert.equal(checked.requiresStart, undefined)
  }
  const checked = await api.checkStoppedProjectUpgrade('v3.9.0')
  assert.equal(checked.targetVersion, target)
  assert.equal(checked.updateAvailable, true)
  assert.equal(checked.requiresStart, true)
  assert.deepEqual(api.sessions, [])
})

test('a stopped instance with an unknown version is not reported up to date', async () => {
  const api = fixture(() => assert.fail('Unexpected request'), { listProjectReleases: async () => assert.fail('Unexpected release lookup') })
  for (const installed of [undefined, 'unrecognized']) {
    await assert.rejects(api.checkStoppedProjectUpgrade(installed), /PROJECT_UPGRADE_LOCAL_VERSION_UNKNOWN/)
  }
})

test('rechecks the release before starting and refuses a stale target', async () => {
  const api = fixture(() => releases())
  await assert.rejects(api.upgradeProject(instance, 'v3.9.0', () => {}), /PROJECT_UPGRADE_RECHECK/)
  assert.deepEqual(api.requests.map(({ pathname }) => pathname), ['/api/releases'])
})

test('submitting an update rechecks the actual release even when an instance check is cached', async () => {
  let requests = 0
  const api = fixture((pathname) => {
    assert.equal(pathname, '/api/releases')
    return ++requests === 1 ? releases() : { ...releases(), releases: [{ tag_name: 'v3.11.0' }] }
  })
  await api.checkManagedProjectUpgrade('project', instance)
  await assert.rejects(api.upgradeProject(instance, target, () => {}), /PROJECT_UPGRADE_RECHECK/)
  assert.equal(requests, 2)
})

test('polls progress and waits for healthy target version using a fresh session', async () => {
  const steps = []
  let attempts = 0
  const api = fixture((pathname) => {
    if (pathname === '/api/releases') return releases()
    if (pathname === '/api/releases/download') return task('running')
    if (pathname === '/api/releases/progress/task-1') return task('restarting')
    if (pathname === '/api/health') return { status: 'ok' }
    if (pathname === '/api/version') return { version: ++attempts === 1 ? 'v3.2.0' : '3.10.0' }
    assert.fail(`Unexpected request: ${pathname}`)
  }, { session: (_url, count) => `session-${count}` })

  await api.upgradeProject(instance, target, (progress) => steps.push(progress.phase))
  assert.deepEqual(steps, ['starting', 'updating', 'verifying', 'verifying'])
  assert.equal(api.requests.find(({ init }) => init.method === 'POST').init.body, JSON.stringify({ tag_name: target }))
  assert.equal(api.requests.at(-1).init.headers.Authorization, 'Bearer session-3')
  assert.equal(api.sessions.at(-1).accessToken, instance.accessToken)
})

test('verifies the version after a restart has removed the progress task', async () => {
  const api = fixture((pathname) => {
    if (pathname === '/api/releases') return releases()
    if (pathname === '/api/releases/download') return task('running')
    if (pathname === '/api/releases/progress/task-1') return Response.json({}, { status: 404 })
    if (pathname === '/api/health') return { status: 'ok' }
    if (pathname === '/api/version') return { version: target }
    assert.fail(`Unexpected request: ${pathname}`)
  })
  await api.upgradeProject(instance, target, () => {})
  assert.equal(api.requests.at(-1).pathname, '/api/version')
})

test('never reports success when the instance comes back on the wrong version', async () => {
  const api = fixture((pathname) => {
    if (pathname === '/api/releases') return releases()
    if (pathname === '/api/releases/download') return task('restarting')
    if (pathname === '/api/health') return { status: 'ok' }
    if (pathname === '/api/version') return { version: 'v3.2.0' }
    assert.fail(`Unexpected request: ${pathname}`)
  }, { tick: 120_000 })
  await assert.rejects(api.upgradeProject(instance, target, () => {}), /PROJECT_UPGRADE_UNCONFIRMED/)
})

test('distinct instances update concurrently and duplicate submissions are rejected', async () => {
  const second = { url: 'https://other.example.test' }
  const started = new Set()
  let releasePosts
  let notifyStarted
  const bothStarted = new Promise((resolve) => { notifyStarted = resolve })
  const pending = new Promise((resolve) => { releasePosts = resolve })
  const api = fixture(async (pathname, origin) => {
    if (pathname === '/api/releases') return releases()
    if (pathname === '/api/releases/download') {
      started.add(origin)
      if (started.size === 2) notifyStarted()
      await pending
      return origin === instance.url ? task('failed', { message: 'Dependency installation failed' }) : task('restarting')
    }
    if (pathname === '/api/health') return { status: 'ok' }
    if (pathname === '/api/version') return { version: target }
    assert.fail(`Unexpected request: ${pathname}`)
  })

  const results = Promise.allSettled([api.upgradeProject(instance, target, () => {}), api.upgradeProject(second, target, () => {})])
  await bothStarted
  try {
    await assert.rejects(api.upgradeProject({ url: `${instance.url}/` }, target, () => {}), /PROJECT_UPGRADE_BUSY/)
  } finally {
    releasePosts()
  }
  const [failed, succeeded] = await results
  assert.match(failed.reason.message, /PROJECT_UPGRADE_FAILED\nDependency installation failed/)
  assert.equal(succeeded.status, 'fulfilled')
  assert.equal(api.requests.filter(({ init }) => init.method === 'POST').length, 2)
  await assert.rejects(api.upgradeProject(instance, target, () => {}), /PROJECT_UPGRADE_FAILED/)
})

test('does not resend a POST after a connection loss with unknown outcome', async () => {
  const api = fixture((pathname) => {
    if (pathname === '/api/releases') return releases()
    if (pathname === '/api/releases/download') throw new Error('connection closed')
    assert.fail(`Unexpected request: ${pathname}`)
  })
  await assert.rejects(api.upgradeProject(instance, target, () => {}), /PROJECT_UPGRADE_UNCONFIRMED\nconnection closed/)
  assert.equal(api.requests.filter(({ init }) => init.method === 'POST').length, 1)
})

function dialogFixture(check) {
  const file = readFileSync(new URL('../src/components/ProjectBulkUpgrade.vue', import.meta.url), 'utf8')
  const script = file.split('<script setup lang="ts">')[1].split('</script>')[0].replace(/^import .*$/gm, '')
  const { outputText: dialog } = ts.transpileModule(script, { compilerOptions: { target: ts.ScriptTarget.ES2022 } })
  const calls = []
  const events = []
  const checks = []
  const props = reactive({
    show: false,
    projects: [{ id: 'local', name: 'Local' }, { id: 'cloud', name: 'Cloud' }],
    singleProject: { id: 'cloud', name: 'Cloud', check },
    language: 'en-US',
  })
  const ui = vm.runInNewContext(dialog + '\n({ confirmation, rows, updateSelected })', {
    computed, ref, watch,
    defineProps: () => props,
    defineEmits: () => (event) => events.push(event),
    projectBulkUpgradeMessages: { 'en-US': { confirmSingle: 'Update {name} to {version}?' } },
    onMounted: (callback) => callback(),
    onBeforeUnmount: () => {},
    window: { kiraLauncher: { projects: {
      checkUpgrade: async (id) => {
        checks.push(id)
        return check
      },
      upgrade: async (id, version) => { calls.push({ id, version }) },
      onUpgradeProgress: () => () => {},
    } } },
  })
  return { ...ui, calls, events, checks, props }
}

test('single instance dialog waits for confirmation and updates only that instance', async () => {
  const dialog = dialogFixture({ currentVersion: 'v3.2.0', targetVersion: target, updateAvailable: true })
  dialog.props.show = true
  await nextTick()
  assert.equal(dialog.confirmation.value, 'Update Cloud to v3.10.0?')
  assert.deepEqual(dialog.calls, [])
  assert.deepEqual(dialog.checks, [])
  await dialog.updateSelected()
  assert.deepEqual(dialog.calls, [{ id: 'cloud', version: target }])
  assert.deepEqual(dialog.events, ['finished'])
  assert.equal(dialog.rows.value[0].state, 'success')
})

test('single instance dialog does not submit an update for a stopped instance', async () => {
  const dialog = dialogFixture({ currentVersion: 'v3.2.0', targetVersion: target, updateAvailable: true, requiresStart: true })
  dialog.props.show = true
  await nextTick()
  assert.equal(dialog.confirmation.value, '')
  await dialog.updateSelected()
  assert.deepEqual(dialog.calls, [])
  assert.equal(dialog.rows.value[0].state, 'skipped')
})

test('mounted upgrade dialog only checks on open and keeps its content while leaving', async () => {
  const dialog = dialogFixture({ currentVersion: 'v3.2.0', targetVersion: target, updateAvailable: true })
  await nextTick()
  assert.deepEqual(dialog.checks, [])
  assert.equal(dialog.rows.value.length, 0)

  dialog.props.show = true
  await nextTick()
  dialog.props.show = false
  dialog.props.singleProject = undefined
  await nextTick()
  assert.equal(dialog.confirmation.value, 'Update Cloud to v3.10.0?')
  assert.deepEqual(dialog.checks, [])

  dialog.props.show = true
  await nextTick()
  assert.deepEqual(dialog.checks, ['local', 'cloud'])
  assert.equal(dialog.rows.value.length, 2)
})
