import { ipcRenderer } from 'electron'

if (process.isMainFrame) {
  // This synchronous handshake only reads main-process memory. It must finish
  // before the WebUI router and auth store read their initial login state.
  const sessionToken: unknown = ipcRenderer.sendSync('webui:initial-session')
  if (typeof sessionToken === 'string' && sessionToken) {
    localStorage.setItem('jwt_token', sessionToken)
  }
}
