import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, net, shell, Tray } from 'electron'
import { execFile, spawn } from 'node:child_process'
import { promises as fs } from 'node:fs'
import { createRequire } from 'node:module'
import { createServer } from 'node:net'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { AppUpdater } from 'electron-updater'
import { decryptAccessToken, encryptAccessToken, getInstanceRuntimeDuration, getInstanceVersion, getLocalAccessToken, getWebuiSessionToken, readJson, requestWithTimeout, verifyCloudProject } from './cloud.js'
import { checkEnvironment, installEnvironmentTool } from './environment.js'
import { getLocalProject, saveLocalWebuiPort } from './local-project.js'
import { downloadAndRegisterProject as downloadProject } from './project-download.js'
import { loadProjects, registerProject, sanitizeEnvironmentVariables, sanitizeLaunchArgs, saveProjects, toManagedProject } from './project-store.js'
import { defaultSettings, loadSettings, saveSettings } from './settings.js'
import type { CloseAction, LauncherSettings, LauncherUpdateCheck, ManagedProject, OverviewData, StoredProject } from './types.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const require = createRequire(import.meta.url)
// electron-updater is CommonJS, so ESM named imports are not reliable at runtime.
const { autoUpdater } = require('electron-updater') as { autoUpdater: AppUpdater }
const isDev = !app.isPackaged
app.setName('KiraAI Launcher')

function isPortableBuild(): boolean {
  if (process.env.PORTABLE_EXECUTABLE_DIR || process.env.APPIMAGE) return true
  try {
    const metadata = require(path.join(app.getAppPath(), 'package.json')) as { kiraPortable?: unknown }
    return metadata.kiraPortable === true
  } catch {
    return false
  }
}

function canUseAutoUpdater(): boolean {
  return !isDev && !isPortableBuild()
}

type GitHubReleaseResponse = {
  tag_name?: unknown
  html_url?: unknown
}

let currentSettings = defaultSettings
let mainWindow: BrowserWindow | null = null
let tray: Tray | null = null
let isQuitting = false
let closePromptInProgress = false
let updateCheckPromise: Promise<LauncherUpdateCheck> | null = null
let updateRestartPromptShown = false

const LAUNCHER_RELEASES_API_URL = 'https://api.github.com/repos/KiraAI-Dev/KiraAI-Launcher/releases/latest'
const PROJECT_SETUP_TIMEOUT_MS = 5 * 60 * 1000
const LOCAL_STARTUP_TIMEOUT_MS = 60 * 1000
const LOCAL_GRACEFUL_SHUTDOWN_TIMEOUT_MS = 10 * 1000
const LOCAL_FORCE_STOP_TIMEOUT_MS = 10 * 1000
const PACKAGE_INDEX_PROBE_TIMEOUT_MS = 5000
const PACKAGE_INDEX_PROBE_SIZE_BYTES = 32 * 1024
const PYTHON_PACKAGE_INDEX_URLS = [
  'https://pypi.org/simple/',
  'https://pypi.tuna.tsinghua.edu.cn/simple/',
  'https://mirrors.aliyun.com/pypi/simple/',
  'https://mirrors.cloud.tencent.com/pypi/simple/',
] as const
const DEFAULT_PYTHON_PACKAGE_INDEX_URL = PYTHON_PACKAGE_INDEX_URLS[0]
type PackageIndexProbe = {
  url: (typeof PYTHON_PACKAGE_INDEX_URLS)[number]
  speedBytesPerSecond: number
}

function applicationIconPath() {
  return isDev
    ? path.join(process.cwd(), 'public', 'icon.png')
    : path.join(__dirname, '../dist/icon.png')
}

function trayText(settings: LauncherSettings) {
  return settings.language === 'zh-CN'
    ? { show: '显示启动器', quit: '退出' }
    : { show: 'Show Launcher', quit: 'Quit' }
}

function closeReminderText(action: CloseAction, activeProjectCount: number) {
  const isChinese = currentSettings.language === 'zh-CN'
  const isQuittingApp = action === 'quit'
  if (isChinese) {
    return {
      title: isQuittingApp ? '退出 KiraAI Launcher' : '最小化到托盘',
      message: isQuittingApp ? '确定要退出 KiraAI Launcher 吗？' : '确定要将 KiraAI Launcher 最小化到托盘吗？',
      detail: isQuittingApp && activeProjectCount > 0
        ? `由启动器启动的 ${activeProjectCount} 个 KiraAI 实例也将一并关闭。`
        : undefined,
      confirm: isQuittingApp ? '退出并关闭实例' : '最小化到托盘',
      cancel: '取消',
    }
  }
  return {
    title: isQuittingApp ? 'Quit KiraAI Launcher' : 'Minimize to tray',
    message: isQuittingApp ? 'Do you want to quit KiraAI Launcher?' : 'Do you want to minimize KiraAI Launcher to the tray?',
    detail: isQuittingApp && activeProjectCount > 0
      ? `${activeProjectCount} KiraAI instance${activeProjectCount === 1 ? '' : 's'} started by the launcher will also be stopped.`
      : undefined,
    confirm: isQuittingApp ? 'Quit and stop instances' : 'Minimize to tray',
    cancel: 'Cancel',
  }
}

async function confirmApplicationClose(action: CloseAction): Promise<boolean> {
  const text = closeReminderText(action, launchedProjects.size)
  const options = {
    type: 'question' as const,
    title: text.title,
    message: text.message,
    detail: text.detail,
    buttons: [text.confirm, text.cancel],
    defaultId: 0,
    cancelId: 1,
  }
  const result = mainWindow && !mainWindow.isDestroyed()
    ? await dialog.showMessageBox(mainWindow, options)
    : await dialog.showMessageBox(options)
  return result.response === 0
}

async function quitApplication(): Promise<void> {
  await Promise.allSettled([...launchedProjects.keys()].map((id) => stopLocalProject(id)))
  isQuitting = true
  app.quit()
}

async function requestApplicationClose(action: CloseAction): Promise<void> {
  if (isQuitting || closePromptInProgress) return
  closePromptInProgress = true
  try {
    if (currentSettings.closeReminder && !await confirmApplicationClose(action)) return
    if (action === 'minimize') {
      mainWindow?.hide()
      return
    }
    await quitApplication()
  } finally {
    if (!isQuitting) closePromptInProgress = false
  }
}

function showMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    createWindow()
    return
  }
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.show()
  mainWindow.focus()
}

function updateTrayMenu(settings: LauncherSettings) {
  if (!tray) return
  const text = trayText(settings)
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: text.show, click: showMainWindow },
    { type: 'separator' },
    { label: text.quit, click: () => { void requestApplicationClose('quit') } },
  ]))
}

function createTray() {
  if (tray) return
  const icon = nativeImage.createFromPath(applicationIconPath())
  tray = new Tray(icon)
  tray.setToolTip('KiraAI Launcher')
  updateTrayMenu(currentSettings)
  tray.on('click', showMainWindow)
}

function updaterText() {
  return currentSettings.language === 'zh-CN'
    ? {
        title: '更新已就绪',
        message: 'KiraAI Launcher 的新版本已下载完成，重启后即可安装。',
        restart: '立即重启',
        later: '稍后',
      }
    : {
        title: 'Update ready',
        message: 'A new version of KiraAI Launcher has been downloaded and will be installed after restart.',
        restart: 'Restart now',
        later: 'Later',
      }
}

function configureAutoUpdater() {
  if (!canUseAutoUpdater()) return
  // Windows update metadata has no architecture suffix. Keep ARM64 on a dedicated channel
  // so it cannot download the x64 installer from the shared GitHub release.
  if (process.platform === 'win32' && process.arch === 'arm64') autoUpdater.channel = 'latest-arm64'
  autoUpdater.autoDownload = true
  autoUpdater.autoInstallOnAppQuit = true
  autoUpdater.on('update-downloaded', () => {
    if (updateRestartPromptShown) return
    updateRestartPromptShown = true
    const text = updaterText()
    void dialog.showMessageBox({
      type: 'info',
      title: text.title,
      message: text.message,
      buttons: [text.restart, text.later],
      defaultId: 0,
      cancelId: 1,
    }).then(({ response }) => {
      if (response !== 0) return
      isQuitting = true
      autoUpdater.quitAndInstall()
    })
  })
}

const launchedProjects = new Map<string, ReturnType<typeof spawn>>()

async function loadOverview(): Promise<OverviewData> {
  const projects = await loadProjects()
  const projectIds = new Set(projects.map((project) => project.id))
  return {
    launcherVersion: app.getVersion(),
    projects: await Promise.all(projects.map(async (project) => ({
      ...toManagedProject(project),
      ...await getProjectRuntimeDetails(project),
    }))),
    activeLocalProjectIds: [...launchedProjects.keys()].filter((id) => projectIds.has(id)),
  }
}

async function getProjectRuntimeDetails(project: StoredProject): Promise<Pick<ManagedProject, 'version' | 'runtimeStartedAt'>> {
  let target: string | undefined
  let accessToken: string | undefined
  let localVersion: string | undefined
  try {
    if (project.type === 'local') {
      if (!project.projectPath) return {}
      const localProject = await getLocalProject(project.projectPath)
      localVersion = localProject.version
      if (!launchedProjects.has(project.id)) return localVersion ? { version: localVersion } : {}
      target = `http://127.0.0.1:${localProject.port ?? 5267}`
      accessToken = await getLocalAccessToken(project.projectPath)
    } else {
      target = project.url
      accessToken = decryptAccessToken(project)
    }
    if (!target) return {}
    const sessionToken = await getWebuiSessionToken(target, accessToken)
    if (!sessionToken) return {}
    const [runtimeDuration, version] = await Promise.all([
      getInstanceRuntimeDuration(target, sessionToken),
      getInstanceVersion(target, sessionToken),
    ])
    return { runtimeStartedAt: Date.now() - runtimeDuration * 1000, version }
  } catch {
    return localVersion ? { version: localVersion } : {}
  }
}

async function fetchWithTimeout(url: string, timeoutMs: number, init?: RequestInit): Promise<Response> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await net.fetch(url, { ...init, signal: controller.signal })
  } finally {
    clearTimeout(timeout)
  }
}

function isNewerVersion(latestVersion: string, currentVersion: string): boolean {
  const toParts = (value: string) => value.replace(/^v/i, '').split(/[.+-]/).map(Number)
  const latestParts = toParts(latestVersion)
  const currentParts = toParts(currentVersion)
  if (latestParts.some(Number.isNaN) || currentParts.some(Number.isNaN)) return false
  const length = Math.max(latestParts.length, currentParts.length)
  for (let index = 0; index < length; index += 1) {
    const difference = (latestParts[index] ?? 0) - (currentParts[index] ?? 0)
    if (difference !== 0) return difference > 0
  }
  return false
}

async function checkLauncherRelease(): Promise<LauncherUpdateCheck> {
  let response: Response
  try {
    response = await fetchWithTimeout(LAUNCHER_RELEASES_API_URL, 15_000, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'KiraAI-Launcher' },
    })
  } catch {
    throw new Error('LAUNCHER_UPDATE_CHECK_FAILED')
  }
  if (!response.ok) throw new Error('LAUNCHER_UPDATE_CHECK_FAILED')
  const release = await readJson(response) as GitHubReleaseResponse | null
  if (typeof release?.tag_name !== 'string' || !release.tag_name || typeof release.html_url !== 'string' || !release.html_url) {
    throw new Error('LAUNCHER_UPDATE_CHECK_FAILED')
  }
  const currentVersion = app.getVersion()
  return {
    currentVersion,
    latestVersion: release.tag_name,
    updateAvailable: isNewerVersion(release.tag_name, currentVersion),
    releaseUrl: release.html_url,
  }
}

async function checkLauncherUpdate(): Promise<LauncherUpdateCheck> {
  if (updateCheckPromise) return updateCheckPromise
  updateCheckPromise = (async () => {
    if (!canUseAutoUpdater()) return checkLauncherRelease()
    try {
      const result = await autoUpdater.checkForUpdates()
      const latestVersion = result?.updateInfo.version
      if (typeof latestVersion !== 'string' || !latestVersion) throw new Error('INVALID_RESPONSE')
      const currentVersion = app.getVersion()
      return {
        currentVersion,
        latestVersion,
        updateAvailable: isNewerVersion(latestVersion, currentVersion),
        releaseUrl: '',
      }
    } catch {
      throw new Error('LAUNCHER_UPDATE_CHECK_FAILED')
    }
  })()
  try {
    return await updateCheckPromise
  } finally {
    updateCheckPromise = null
  }
}

function runCommand(command: string, args: string[], timeout = 8000): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(command, args, { windowsHide: true, timeout }, (error, stdout, stderr) => {
      if (error) reject(error)
      else resolve({ stdout: stdout.trim(), stderr: stderr.trim() })
    })
  })
}

async function startLocalProject(id: string): Promise<void> {
  if (launchedProjects.has(id)) return
  const project = (await loadProjects()).find((item) => item.id === id)
  if (!project || project.type !== 'local' || !project.projectPath) throw new Error('LOCAL_PROJECT_NOT_FOUND')
  const localProject = await getLocalProject(project.projectPath)
  await ensureLocalPortAvailable(localProject.port ?? 5267)
  const venvPythonPath = path.join(project.projectPath, 'venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python')
  const detectedPackageIndex = await selectFastestPackageIndex()
  const packageIndex = detectedPackageIndex ?? DEFAULT_PYTHON_PACKAGE_INDEX_URL
  let useUv = await hasUv()
  try {
    await fs.access(venvPythonPath)
  } catch {
    if (useUv && detectedPackageIndex) {
      try {
        await runProjectCommand('uv', ['venv', 'venv', '--python', '3.11', '--seed', '--index-url', packageIndex], project.projectPath, 'VENV_CREATE_FAILED')
      } catch {
        useUv = false
        const hostPython = await findHostPython()
        await runProjectCommand(hostPython.command, [...hostPython.args, '-m', 'venv', '--clear', 'venv'], project.projectPath, 'VENV_CREATE_FAILED')
      }
    } else {
      useUv = false
      const hostPython = await findHostPython()
      await runProjectCommand(hostPython.command, [...hostPython.args, '-m', 'venv', 'venv'], project.projectPath, 'VENV_CREATE_FAILED')
    }
  }

  if (useUv) {
    await runProjectCommand('uv', ['pip', 'install', '--python', venvPythonPath, '--upgrade', 'pip', '--index-url', packageIndex], project.projectPath, 'DEPENDENCY_INSTALL_FAILED')
    await runProjectCommand('uv', ['pip', 'install', '--python', venvPythonPath, '-r', 'requirements.txt', '--index-url', packageIndex], project.projectPath, 'DEPENDENCY_INSTALL_FAILED')
  } else {
    await runProjectCommand(venvPythonPath, ['-m', 'pip', 'install', '--disable-pip-version-check', '--upgrade', 'pip', '--index-url', packageIndex], project.projectPath, 'DEPENDENCY_INSTALL_FAILED')
    await runProjectCommand(venvPythonPath, ['-m', 'pip', 'install', '--disable-pip-version-check', '-r', 'requirements.txt', '--index-url', packageIndex], project.projectPath, 'DEPENDENCY_INSTALL_FAILED')
  }

  const child = spawn(venvPythonPath, ['main.py', ...project.launchArgs ?? []], {
    cwd: project.projectPath,
    env: {
      ...process.env,
      ...project.environmentVariables,
      KIRA_LAUNCH_SOURCE: 'launcher',
    },
    windowsHide: true,
    stdio: 'ignore',
  })
  launchedProjects.set(id, child)
  child.once('exit', () => launchedProjects.delete(id))
  child.once('error', () => launchedProjects.delete(id))
  await waitForSpawn(child)
  await waitForLocalWebui(localProject.port ?? 5267, child)
}

function ensureLocalPortAvailable(port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', () => reject(new Error('LOCAL_PORT_UNAVAILABLE')))
    server.once('listening', () => {
      server.close((error) => {
        if (error) reject(new Error('LOCAL_PORT_UNAVAILABLE'))
        else resolve()
      })
    })
    server.listen({ port, host: '127.0.0.1', exclusive: true })
  })
}

async function stopLocalProject(id: string): Promise<void> {
  const child = launchedProjects.get(id)
  if (!child) return
  launchedProjects.delete(id)
  if (typeof child.pid !== 'number') throw new Error('LOCAL_STOP_FAILED')

  const project = (await loadProjects()).find((item) => item.id === id)
  if (project?.type === 'local' && project.projectPath) {
    try {
      const localProject = await getLocalProject(project.projectPath)
      if (await requestGracefulLocalShutdown(
        project.projectPath,
        localProject.port ?? 5267,
      )) {
        await waitForProcessExit(child, LOCAL_GRACEFUL_SHUTDOWN_TIMEOUT_MS)
        return
      }
    } catch {
      // The fallback below terminates the whole supervisor tree when the
      // controlled shutdown request cannot complete.
    }
  }

  if (child.exitCode !== null) return
  if (process.platform === 'win32') {
    await runProjectCommand('taskkill', ['/pid', String(child.pid), '/t', '/f'], process.cwd(), 'LOCAL_STOP_FAILED')
  } else if (!child.kill('SIGTERM')) {
    throw new Error('LOCAL_STOP_FAILED')
  }
  await waitForProcessExit(child, LOCAL_FORCE_STOP_TIMEOUT_MS)
}

async function requestGracefulLocalShutdown(
  projectPath: string,
  port: number,
): Promise<boolean> {
  const target = `http://127.0.0.1:${port}`
  try {
    const sessionToken = await getWebuiSessionToken(target, await getLocalAccessToken(projectPath))
    if (!sessionToken) return false
    const response = await requestWithTimeout(`${target}/api/system/shutdown`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${sessionToken}`,
      },
    }, LOCAL_GRACEFUL_SHUTDOWN_TIMEOUT_MS)
    return response.ok
  } catch {
    return false
  }
}

function waitForProcessExit(child: ReturnType<typeof spawn>, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    if (child.exitCode !== null) {
      resolve()
      return
    }
    const timeout = setTimeout(() => {
      cleanup()
      reject(new Error('LOCAL_STOP_TIMEOUT'))
    }, timeoutMs)
    const onExit = () => {
      cleanup()
      resolve()
    }
    const onError = () => {
      cleanup()
      reject(new Error('LOCAL_STOP_FAILED'))
    }
    const cleanup = () => {
      clearTimeout(timeout)
      child.removeListener('exit', onExit)
      child.removeListener('error', onError)
    }
    child.once('exit', onExit)
    child.once('error', onError)
  })
}

type PythonCommand = { command: string; args: string[] }

async function hasUv(): Promise<boolean> {
  try {
    await runCommand('uv', ['--version'])
    return true
  } catch {
    return false
  }
}

async function selectFastestPackageIndex(): Promise<string | undefined> {
  let fastest: PackageIndexProbe | undefined
  for (const url of PYTHON_PACKAGE_INDEX_URLS) {
    const result = await measurePackageIndexSpeed(url)
    if (result && (!fastest || result.speedBytesPerSecond > fastest.speedBytesPerSecond)) fastest = result
  }
  return fastest?.url
}

async function measurePackageIndexSpeed(url: PackageIndexProbe['url']): Promise<PackageIndexProbe | undefined> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), PACKAGE_INDEX_PROBE_TIMEOUT_MS)
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
  const startedAt = Date.now()
  try {
    const response = await net.fetch(url, {
      headers: {
        Range: `bytes=0-${PACKAGE_INDEX_PROBE_SIZE_BYTES - 1}`,
        'Accept-Encoding': 'identity',
      },
      signal: controller.signal,
    })
    if (response.status !== 200 && response.status !== 206) {
      await response.body?.cancel()
      return undefined
    }
    reader = response.body?.getReader()
    if (!reader) return undefined
    let downloadedBytes = 0
    const byteLimit = response.status === 206 ? PACKAGE_INDEX_PROBE_SIZE_BYTES : Number.POSITIVE_INFINITY
    while (downloadedBytes < byteLimit) {
      const { done, value } = await reader.read()
      if (done) break
      downloadedBytes += value.byteLength
    }
    const elapsedMs = Date.now() - startedAt
    if (downloadedBytes === 0 || elapsedMs <= 0) return undefined
    return { url, speedBytesPerSecond: downloadedBytes * 1000 / elapsedMs }
  } catch {
    return undefined
  } finally {
    clearTimeout(timeout)
    try {
      await reader?.cancel()
    } catch {
      // The response stream can already be closed or aborted after a complete sample.
    }
  }
}

async function findHostPython(): Promise<PythonCommand> {
  const candidates: PythonCommand[] = process.platform === 'win32'
    ? [{ command: 'python', args: [] }, { command: 'py', args: ['-3'] }]
    : [{ command: 'python3', args: [] }, { command: 'python', args: [] }]
  for (const candidate of candidates) {
    try {
      await runCommand(candidate.command, [...candidate.args, '--version'])
      return candidate
    } catch {
      // Try the next supported Python launcher.
    }
  }
  throw new Error('PYTHON_UNAVAILABLE')
}

function runProjectCommand(command: string, args: string[], cwd: string, errorCode: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, windowsHide: true, stdio: 'ignore' })
    let settled = false
    const finish = (error?: Error) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      if (error) reject(error)
      else resolve()
    }
    const timeout = setTimeout(() => {
      child.kill()
      finish(new Error(errorCode))
    }, PROJECT_SETUP_TIMEOUT_MS)
    child.once('error', () => finish(new Error(errorCode)))
    child.once('exit', (code) => {
      if (code === 0) finish()
      else finish(new Error(errorCode))
    })
  })
}

function waitForSpawn(child: ReturnType<typeof spawn>): Promise<void> {
  return new Promise((resolve, reject) => {
    child.once('spawn', resolve)
    child.once('error', () => reject(new Error('LOCAL_START_FAILED')))
  })
}

async function waitForLocalWebui(port: number, child: ReturnType<typeof spawn>): Promise<void> {
  const deadline = Date.now() + LOCAL_STARTUP_TIMEOUT_MS
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.killed) throw new Error('LOCAL_START_FAILED')
    try {
      const response = await requestWithTimeout(`http://127.0.0.1:${port}/api/health`)
      const health = await readJson(response) as { status?: unknown } | null
      if (response.ok && health?.status === 'ok') return
    } catch {
      // The service can take a moment to bind its port after dependencies are installed.
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 500))
  }
  throw new Error('LOCAL_START_TIMEOUT')
}

async function openAuthenticatedWebui(project: StoredProject, target: string, sessionToken: string | undefined): Promise<void> {
  const webuiWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    title: `${project.name} · KiraAI`,
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      partition: `persist:kira-project-${project.id}`,
    },
  })
  if (sessionToken) {
    await webuiWindow.webContents.session.cookies.set({
      url: target,
      name: 'kira_token',
      value: sessionToken,
      httpOnly: true,
      sameSite: 'lax',
    })
  }
  await webuiWindow.loadURL(target)
}

async function openProject(id: string): Promise<void> {
  const project = (await loadProjects()).find((item) => item.id === id)
  if (!project) throw new Error('PROJECT_NOT_FOUND')
  const target = project.type === 'cloud' ? project.url : `http://127.0.0.1:${project.port ?? 5267}`
  if (!target) throw new Error('PROJECT_URL_UNAVAILABLE')
  if ((await loadSettings()).webuiOpenMode === 'browser') {
    await shell.openExternal(target)
    return
  }
  if (project.type === 'cloud') {
    const cloudAccessToken = decryptAccessToken(project)
    if (!cloudAccessToken) {
      await shell.openExternal(target)
      return
    }
    const sessionToken = await getWebuiSessionToken(target, cloudAccessToken)
    await openAuthenticatedWebui(project, target, sessionToken)
    return
  }

  let healthResponse: Response
  try {
    healthResponse = await requestWithTimeout(`${target}/api/health`)
  } catch {
    await shell.openExternal(target)
    return
  }
  const health = await readJson(healthResponse) as { status?: unknown } | null
  if (!healthResponse.ok || health?.status !== 'ok') {
    await shell.openExternal(target)
    return
  }

  const localAccessToken = project.projectPath ? await getLocalAccessToken(project.projectPath) : undefined
  let sessionToken: string | undefined
  try {
    sessionToken = await getWebuiSessionToken(target, localAccessToken)
  } catch (error) {
    if (error instanceof Error && error.message === 'CLOUD_ACCESS_TOKEN_INVALID') throw new Error('LOCAL_LOGIN_FAILED')
    throw error
  }
  await openAuthenticatedWebui(project, target, sessionToken)
}

async function openProjectFolder(id: string): Promise<void> {
  const project = (await loadProjects()).find((item) => item.id === id)
  if (!project) throw new Error('PROJECT_NOT_FOUND')
  if (project.type !== 'local' || !project.projectPath) throw new Error('PROJECT_FOLDER_UNAVAILABLE')
  const errorMessage = await shell.openPath(project.projectPath)
  if (errorMessage) throw new Error('PROJECT_FOLDER_OPEN_FAILED')
}

async function updateProject(value: unknown): Promise<ManagedProject> {
  if (typeof value !== 'object' || value === null) throw new Error('PROJECT_SETTINGS_INVALID')
  const { id, name, port, url, accessToken, launchArgs, environmentVariables } = value as { id?: unknown; name?: unknown; port?: unknown; url?: unknown; accessToken?: unknown; launchArgs?: unknown; environmentVariables?: unknown }
  if (typeof id !== 'string' || typeof name !== 'string') throw new Error('PROJECT_SETTINGS_INVALID')
  if (typeof accessToken !== 'undefined' && typeof accessToken !== 'string') throw new Error('PROJECT_SETTINGS_INVALID')
  const projectName = name.trim()
  if (!projectName) throw new Error('PROJECT_NAME_REQUIRED')
  const safeLaunchArgs = sanitizeLaunchArgs(launchArgs)
  if (safeLaunchArgs === null) throw new Error('PROJECT_LAUNCH_ARGUMENTS_INVALID')
  const safeEnvironmentVariables = sanitizeEnvironmentVariables(environmentVariables)
  if (safeEnvironmentVariables === null) throw new Error('PROJECT_ENVIRONMENT_VARIABLES_INVALID')

  const projects = await loadProjects()
  const projectIndex = projects.findIndex((project) => project.id === id)
  if (projectIndex === -1) throw new Error('PROJECT_NOT_FOUND')
  const project = projects[projectIndex]
  let updatedProject: StoredProject

  if (project.type === 'local') {
    if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65_535) throw new Error('PROJECT_PORT_INVALID')
    if (launchedProjects.has(project.id) && port !== project.port) throw new Error('PROJECT_RUNNING')
    if (!project.projectPath) throw new Error('LOCAL_PROJECT_NOT_FOUND')
    if (port !== project.port) await saveLocalWebuiPort(project.projectPath, port)
    updatedProject = { ...project, name: projectName, port, launchArgs: safeLaunchArgs, environmentVariables: safeEnvironmentVariables }
  } else {
    if (typeof url !== 'string') throw new Error('PROJECT_SETTINGS_INVALID')
    const normalizedUrl = await verifyCloudProject(url)
    if (projects.some((item) => item.id !== project.id && item.type === 'cloud' && item.url === normalizedUrl)) {
      throw new Error('PROJECT_URL_ALREADY_MANAGED')
    }
    const suppliedAccessToken = accessToken?.trim()
    if (suppliedAccessToken) await getWebuiSessionToken(normalizedUrl, suppliedAccessToken)
    updatedProject = {
      ...project,
      name: projectName,
      url: normalizedUrl,
      encryptedAccessToken: suppliedAccessToken ? encryptAccessToken(suppliedAccessToken) : project.encryptedAccessToken,
    }
  }

  projects[projectIndex] = updatedProject
  await saveProjects(projects)
  return toManagedProject(updatedProject)
}

async function removeProject(id: string): Promise<void> {
  const projects = await loadProjects()
  if (!projects.some((project) => project.id === id)) throw new Error('PROJECT_NOT_FOUND')
  await saveProjects(projects.filter((project) => project.id !== id))
  launchedProjects.delete(id)
}

function createWindow() {
  const window = new BrowserWindow({
    width: 1000,
    height: 700,
    minWidth: 600,
    minHeight: 300,
    title: 'KiraAI Launcher',
    backgroundColor: '#0b1020',
    icon: applicationIconPath(),
    autoHideMenuBar: true,
    titleBarStyle: 'hiddenInset',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, 'preload.cjs'),
    },
  })
  mainWindow = window
  window.on('close', (event) => {
    if (isQuitting) return
    event.preventDefault()
    void requestApplicationClose(currentSettings.closeAction)
  })
  window.on('closed', () => {
    if (mainWindow === window) mainWindow = null
  })
  if (isDev) window.loadURL('http://localhost:5173')
  else window.loadFile(path.join(__dirname, '../dist/index.html'))
}

app.whenReady().then(async () => {
  currentSettings = await loadSettings()
  configureAutoUpdater()
  ipcMain.handle('settings:load', async () => {
    currentSettings = await loadSettings()
    return currentSettings
  })
  ipcMain.handle('settings:save', async (_event, settings: unknown) => {
    currentSettings = await saveSettings(settings)
    updateTrayMenu(currentSettings)
    return currentSettings
  })
  ipcMain.handle('projects:list', () => loadProjects().then((projects) => projects.map(toManagedProject)))
  ipcMain.handle('projects:choose-local', async () => {
    const result = await dialog.showOpenDialog({
      title: '选择已部署的 KiraAI 项目',
      properties: ['openDirectory'],
    })
    if (result.canceled || !result.filePaths[0]) return null
    return getLocalProject(result.filePaths[0])
  })
  ipcMain.handle('projects:add-local', (_event, projectPath: unknown) => {
    if (typeof projectPath !== 'string') throw new Error('PROJECT_PATH_INVALID')
    return getLocalProject(projectPath).then(registerProject).then(toManagedProject)
  })
  ipcMain.handle('projects:choose-download-directory', async () => {
    const result = await dialog.showOpenDialog({
      title: '选择 KiraAI 项目下载位置',
      properties: ['openDirectory', 'createDirectory'],
    })
    return result.canceled ? null : result.filePaths[0] ?? null
  })
  ipcMain.handle('projects:download', async (_event, value: unknown) => {
    if (typeof value !== 'object' || value === null) throw new Error('DOWNLOAD_INPUT_INVALID')
    const { parentPath, name } = value as { parentPath?: unknown; name?: unknown }
    if (typeof parentPath !== 'string' || typeof name !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(name)) {
      throw new Error('PROJECT_NAME_INVALID')
    }
    return downloadProject(parentPath, name).then(toManagedProject)
  })
  ipcMain.handle('projects:connect-cloud', async (_event, value: unknown) => {
    if (typeof value !== 'object' || value === null) throw new Error('CLOUD_INPUT_INVALID')
    const { name, url, accessToken } = value as { name?: unknown; url?: unknown; accessToken?: unknown }
    if (typeof name !== 'string' || !name.trim() || typeof url !== 'string') throw new Error('CLOUD_DETAILS_REQUIRED')
    const normalizedUrl = await verifyCloudProject(url)
    if (typeof accessToken !== 'undefined' && typeof accessToken !== 'string') throw new Error('CLOUD_INPUT_INVALID')
    const suppliedAccessToken = accessToken?.trim()
    const existingProject = (await loadProjects()).find((project) => project.type === 'cloud' && project.url === normalizedUrl)
    const storedAccessToken = existingProject ? decryptAccessToken(existingProject) : undefined
    await getWebuiSessionToken(normalizedUrl, suppliedAccessToken || storedAccessToken)
    const tokenDetails = suppliedAccessToken ? { encryptedAccessToken: encryptAccessToken(suppliedAccessToken) } : {}
    return toManagedProject(await registerProject({ name: name.trim(), type: 'cloud', url: normalizedUrl, ...tokenDetails }))
  })
  ipcMain.handle('projects:update', (_event, value: unknown) => updateProject(value))
  ipcMain.handle('projects:get-access-token', async (_event, id: unknown) => {
    if (typeof id !== 'string') throw new Error('PROJECT_ID_INVALID')
    const project = (await loadProjects()).find((item) => item.id === id)
    if (!project) throw new Error('PROJECT_NOT_FOUND')
    if (project.type !== 'cloud') throw new Error('PROJECT_SETTINGS_INVALID')
    const accessToken = decryptAccessToken(project)
    if (!accessToken) throw new Error('CLOUD_TOKEN_DECRYPT_FAILED')
    return accessToken
  })
  ipcMain.handle('projects:start', (_event, id: unknown) => {
    if (typeof id !== 'string') throw new Error('PROJECT_ID_INVALID')
    return startLocalProject(id)
  })
  ipcMain.handle('projects:stop', (_event, id: unknown) => {
    if (typeof id !== 'string') throw new Error('PROJECT_ID_INVALID')
    return stopLocalProject(id)
  })
  ipcMain.handle('projects:open', (_event, id: unknown) => {
    if (typeof id !== 'string') throw new Error('PROJECT_ID_INVALID')
    return openProject(id)
  })
  ipcMain.handle('projects:open-folder', (_event, id: unknown) => {
    if (typeof id !== 'string') throw new Error('PROJECT_ID_INVALID')
    return openProjectFolder(id)
  })
  ipcMain.handle('projects:remove', (_event, id: unknown) => {
    if (typeof id !== 'string') throw new Error('PROJECT_ID_INVALID')
    return removeProject(id)
  })
  ipcMain.handle('overview:load', loadOverview)
  ipcMain.handle('updates:check', checkLauncherUpdate)
  ipcMain.handle('environment:check', checkEnvironment)
  ipcMain.handle('environment:install', (_event, value: unknown) => installEnvironmentTool(value))
  createTray()
  createWindow()
  if (currentSettings.autoUpdate && canUseAutoUpdater()) void checkLauncherUpdate().catch(() => undefined)
  app.on('activate', showMainWindow)
})
app.on('before-quit', (event) => {
  if (isQuitting) return
  event.preventDefault()
  void requestApplicationClose('quit')
})
app.on('window-all-closed', () => { if (process.platform !== 'darwin' && isQuitting) app.quit() })
