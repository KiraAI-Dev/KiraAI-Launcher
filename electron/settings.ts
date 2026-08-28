import { app } from 'electron'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { CloseAction, Language, LauncherSettings, ThemeColor, ThemeMode, WebuiOpenMode } from './types.js'

export const defaultSettings: LauncherSettings = {
  themeMode: 'system',
  themeColor: 'blue',
  language: 'zh-CN',
  webuiOpenMode: 'launcher',
  closeAction: 'minimize',
  closeReminder: true,
  autoUpdate: true,
}

function settingsPath() {
  return path.join(app.getPath('userData'), 'settings.json')
}

export function sanitizeSettings(value: unknown): LauncherSettings {
  const candidate = typeof value === 'object' && value !== null ? value as Partial<LauncherSettings> : {}
  return {
    themeMode: ['system', 'light', 'dark'].includes(candidate.themeMode ?? '') ? candidate.themeMode as ThemeMode : defaultSettings.themeMode,
    themeColor: ['blue', 'purple', 'green', 'orange'].includes(candidate.themeColor ?? '') ? candidate.themeColor as ThemeColor : defaultSettings.themeColor,
    language: ['zh-CN', 'en-US'].includes(candidate.language ?? '') ? candidate.language as Language : defaultSettings.language,
    webuiOpenMode: ['launcher', 'browser'].includes(candidate.webuiOpenMode ?? '') ? candidate.webuiOpenMode as WebuiOpenMode : defaultSettings.webuiOpenMode,
    closeAction: ['minimize', 'quit'].includes(candidate.closeAction ?? '') ? candidate.closeAction as CloseAction : defaultSettings.closeAction,
    closeReminder: typeof candidate.closeReminder === 'boolean' ? candidate.closeReminder : defaultSettings.closeReminder,
    autoUpdate: typeof candidate.autoUpdate === 'boolean' ? candidate.autoUpdate : defaultSettings.autoUpdate,
  }
}

export async function loadSettings(): Promise<LauncherSettings> {
  try {
    return sanitizeSettings(JSON.parse(await fs.readFile(settingsPath(), 'utf8')))
  } catch {
    return saveSettings(defaultSettings)
  }
}

export async function saveSettings(settings: unknown): Promise<LauncherSettings> {
  const safeSettings = sanitizeSettings(settings)
  const filePath = settingsPath()
  const temporaryPath = `${filePath}.tmp`
  await fs.mkdir(path.dirname(filePath), { recursive: true })
  await fs.writeFile(temporaryPath, `${JSON.stringify(safeSettings, null, 2)}\n`, 'utf8')
  await fs.rename(temporaryPath, filePath)
  return safeSettings
}
