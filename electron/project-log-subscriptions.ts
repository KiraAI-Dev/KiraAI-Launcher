import type { IpcMain, WebContents } from 'electron'
import { watchProjectLog } from './project-logs.js'

export function registerProjectLogSubscriptions(ipcMain: IpcMain) {
  const subscriptions = new Map<WebContents, { id: number; stop: () => void }>()
  ipcMain.on('logs:watch', (event, id: unknown, projectId: unknown) => {
    const sender = event.sender
    if (typeof id !== 'number' || !Number.isSafeInteger(id) || typeof projectId !== 'string' || !projectId.trim()) return
    subscriptions.get(sender)?.stop()
    const stop = () => {
      cancel()
      sender.removeListener('destroyed', stop)
      sender.removeListener('did-start-navigation', stop)
      subscriptions.delete(sender)
    }
    const send = (payload: object) => {
      if (!sender.isDestroyed() && subscriptions.get(sender)?.id === id) sender.send('logs:changed', { id, ...payload })
    }
    const cancel = watchProjectLog(projectId, (log) => send({ log }), (error) => send({ error }))
    subscriptions.set(sender, { id, stop })
    sender.once('destroyed', stop)
    sender.once('did-start-navigation', stop)
  })
  ipcMain.on('logs:unwatch', (event, id: unknown) => {
    const subscription = subscriptions.get(event.sender)
    if (subscription && subscription.id === id) subscription.stop()
  })
}
