export type ThemeMode = 'system' | 'light' | 'dark'
export type ThemeColor = 'blue' | 'purple' | 'green' | 'orange'
export type Language = 'zh-CN' | 'en-US'
export type CloseAction = 'minimize' | 'quit'
export type WebuiOpenMode = 'launcher' | 'browser'
export type ProjectType = 'local' | 'cloud'

export type ManagedProject = {
  id: string
  name: string
  type: ProjectType
  projectPath?: string
  url?: string
  port?: number
  launchArgs?: string[]
  environmentVariables?: Record<string, string>
  version?: string
  runtimeStartedAt?: number
  createdAt: string
}

export type StoredProject = Omit<ManagedProject, 'version' | 'runtimeStartedAt'> & {
  encryptedAccessToken?: string
}

export type EnvironmentToolName = 'Python' | 'uv' | 'Node.js'

export type EnvironmentTool = {
  name: EnvironmentToolName
  installed: boolean
  version?: string
  path?: string
  installVersions: string[]
  defaultInstallVersion: string
}

export type EnvironmentToolProbe = {
  command: string
  versionArgs: string[]
  pathArgs?: string[]
}

export type EnvironmentToolDefinition = {
  name: EnvironmentToolName
  probes: EnvironmentToolProbe[]
  installVersions: string[]
  defaultInstallVersion: string
}

export type OverviewData = {
  launcherVersion: string
  projects: ManagedProject[]
  activeLocalProjectIds: string[]
}

export type LauncherUpdateCheck = {
  currentVersion: string
  latestVersion: string
  updateAvailable: boolean
  releaseUrl: string
}

export type LauncherSettings = {
  themeMode: ThemeMode
  themeColor: ThemeColor
  language: Language
  webuiOpenMode: WebuiOpenMode
  closeAction: CloseAction
  closeReminder: boolean
  autoUpdate: boolean
}
