import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('kiraLauncher', {
  settings: {
    load: () => ipcRenderer.invoke('settings:load'),
    save: (settings: unknown) => ipcRenderer.invoke('settings:save', settings),
  },
  projects: {
    list: () => ipcRenderer.invoke('projects:list'),
    chooseLocal: () => ipcRenderer.invoke('projects:choose-local'),
    addLocal: (projectPath: string) => ipcRenderer.invoke('projects:add-local', projectPath),
    chooseDownloadDirectory: () => ipcRenderer.invoke('projects:choose-download-directory'),
    download: (value: { parentPath: string; name: string }) => ipcRenderer.invoke('projects:download', value),
    connectCloud: (value: { name: string; url: string; accessToken?: string }) => ipcRenderer.invoke('projects:connect-cloud', value),
    update: (value: { id: string; name: string; port?: number | null; url?: string; accessToken?: string; launchArgs?: string[]; environmentVariables?: Record<string, string> }) => ipcRenderer.invoke('projects:update', value),
    getAccessToken: (id: string) => ipcRenderer.invoke('projects:get-access-token', id),
    start: (id: string) => ipcRenderer.invoke('projects:start', id),
    stop: (id: string) => ipcRenderer.invoke('projects:stop', id),
    open: (id: string) => ipcRenderer.invoke('projects:open', id),
    openFolder: (id: string) => ipcRenderer.invoke('projects:open-folder', id),
    remove: (id: string) => ipcRenderer.invoke('projects:remove', id),
  },
  overview: {
    load: () => ipcRenderer.invoke('overview:load'),
  },
  updates: {
    check: () => ipcRenderer.invoke('updates:check'),
  },
  environment: {
    check: () => ipcRenderer.invoke('environment:check'),
    install: (value: { name: 'Python' | 'uv' | 'Node.js'; version: string }) => ipcRenderer.invoke('environment:install', value),
  },
})
