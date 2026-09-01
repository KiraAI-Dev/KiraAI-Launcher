interface LauncherSettings {
  themeMode: 'system' | 'light' | 'dark'
  themeColor: 'blue' | 'purple' | 'green' | 'orange'
  language: 'zh-CN' | 'en-US'
  webuiOpenMode: 'launcher' | 'browser'
  closeAction: 'minimize' | 'quit'
  closeReminder: boolean
  autoUpdate: boolean
}

interface ManagedProject {
  id: string
  name: string
  type: 'local' | 'cloud'
  projectPath?: string
  url?: string
  host?: string
  port?: number
  launchArgs?: string[]
  environmentVariables?: Record<string, string>
  hasSavedAccessToken?: boolean
  version?: string
  runtimeStartedAt?: number
  createdAt: string
}

interface LocalProjectCandidate {
  name: string
  type: 'local'
  projectPath: string
  port: number
}

interface EnvironmentTool {
  name: 'Python' | 'uv' | 'Node.js'
  installed: boolean
  version?: string
  path?: string
  installVersions: string[]
  defaultInstallVersion: string
}

interface OverviewData {
  launcherVersion: string
  projects: ManagedProject[]
  activeLocalProjectIds: string[]
}

interface LauncherUpdateCheck {
  currentVersion: string
  latestVersion: string
  updateAvailable: boolean
  releaseUrl: string
}

interface Window {
  kiraLauncher?: {
    settings: {
      load: () => Promise<LauncherSettings>
      save: (settings: LauncherSettings) => Promise<LauncherSettings>
    }
    projects: {
      list: () => Promise<ManagedProject[]>
      chooseLocal: () => Promise<LocalProjectCandidate | null>
      addLocal: (projectPath: string) => Promise<ManagedProject>
      chooseDownloadDirectory: () => Promise<string | null>
      download: (value: { parentPath: string; name: string }) => Promise<ManagedProject>
      connectCloud: (value: { name: string; url: string; accessToken?: string }) => Promise<ManagedProject>
      update: (value: { id: string; name: string; host?: string; port?: number | null; url?: string; accessToken?: string; launchArgs?: string[]; environmentVariables?: Record<string, string> }) => Promise<ManagedProject>
      getAccessToken: (id: string) => Promise<string>
      start: (id: string) => Promise<void>
      stop: (id: string) => Promise<void>
      open: (id: string) => Promise<void>
      openFolder: (id: string) => Promise<void>
      remove: (id: string) => Promise<void>
    }
    overview: {
      load: () => Promise<OverviewData>
    }
    updates: {
      check: () => Promise<LauncherUpdateCheck>
    }
    environment: {
      check: () => Promise<EnvironmentTool[]>
      install: (value: { name: EnvironmentTool['name']; version: string }) => Promise<EnvironmentTool>
    }
  }
}
