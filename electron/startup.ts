import { app } from 'electron'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { LauncherSettings } from './types.js'

export const LOGIN_START_ARGUMENT = '--launch-at-login'
const LOGIN_ITEM_NAME = 'KiraAI Launcher'

export function isStartupSupported(): boolean {
  return app.isPackaged && ['win32', 'darwin', 'linux'].includes(process.platform)
}

function startupExecutable(): string {
  // Portable packages extract/mount a temporary executable on each run.
  return process.env.PORTABLE_EXECUTABLE_FILE || process.env.APPIMAGE || process.execPath
}

function windowsLoginOptions() {
  return { path: startupExecutable(), args: [LOGIN_START_ARGUMENT] }
}

function autostartPath(): string {
  const configHome = process.env.XDG_CONFIG_HOME
  const directory = configHome && path.isAbsolute(configHome) ? configHome : path.join(app.getPath('home'), '.config')
  return path.join(directory, 'autostart', 'com.kiraai.launcher.desktop')
}

function desktopExec(executable: string): string {
  if (/[\r\n\0=]/.test(executable)) throw new Error('STARTUP_SETTINGS_FAILED')
  const quoted = executable.replace(/["`$\\]/g, '\\$&').replace(/%/g, '%%')
  return '"' + quoted.replace(/\\/g, '\\\\') + '"'
}

export function wasStartedAtLogin(argv = process.argv): boolean {
  return argv.includes(LOGIN_START_ARGUMENT)
    || (process.platform === 'darwin' && app.getLoginItemSettings().wasOpenedAtLogin)
}

export function shouldStartInTray(settings: LauncherSettings): boolean {
  return settings.launchAtLogin && settings.startMinimized && wasStartedAtLogin()
}

export async function getLaunchAtLogin(): Promise<boolean> {
  if (!isStartupSupported()) return false
  if (process.platform === 'win32') {
    const settings = app.getLoginItemSettings(windowsLoginOptions())
    return settings.openAtLogin && settings.executableWillLaunchAtLogin
  }
  if (process.platform === 'darwin') return app.getLoginItemSettings().openAtLogin
  try {
    const entry = await fs.readFile(autostartPath(), 'utf8')
    return /^Exec=.+$/m.test(entry) && !/^(?:Hidden=true|X-GNOME-Autostart-enabled=false)\s*$/m.test(entry)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

export async function setLaunchAtLogin(enabled: boolean): Promise<void> {
  if (!isStartupSupported()) {
    if (enabled) throw new Error('STARTUP_SETTINGS_FAILED')
    return
  }
  if (process.platform === 'win32') {
    app.setLoginItemSettings({ ...windowsLoginOptions(), name: LOGIN_ITEM_NAME, openAtLogin: enabled, enabled })
  } else if (process.platform === 'darwin') {
    app.setLoginItemSettings({ openAtLogin: enabled })
  } else {
    const file = autostartPath()
    if (enabled) {
      const entry = [
        '[Desktop Entry]', 'Type=Application', 'Name=KiraAI Launcher',
        'Exec=' + desktopExec(startupExecutable()) + ' ' + LOGIN_START_ARGUMENT,
        'Terminal=false', 'Hidden=false', '',
      ].join('\n')
      await fs.mkdir(path.dirname(file), { recursive: true })
      await fs.writeFile(file, entry, { encoding: 'utf8', mode: 0o600 })
    } else {
      await fs.rm(file, { force: true })
    }
  }
  if (await getLaunchAtLogin() !== enabled) throw new Error('STARTUP_SETTINGS_FAILED')
}