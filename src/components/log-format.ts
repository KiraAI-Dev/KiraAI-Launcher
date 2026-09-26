import type { LauncherLog, LogEntry } from '../../electron/types'

export function getLogEntries(log: LauncherLog): LogEntry[] {
  if (log.entries) return log.entries
  if (!log.content) return []
  return log.content.split('\n').map((content) => {
    const match = /^\[([^\]]+)\] \[(DEBUG|INFO|WARN|WARNING|ERROR|CRITICAL)\] ([\s\S]*)$/.exec(content)
    if (!match) return { level: '', content }
    const [, time, displayLevel, message] = match
    const level = displayLevel === 'WARNING' ? 'WARN' : displayLevel === 'CRITICAL' ? 'ERROR' : displayLevel
    return { level, content, time, displayLevel, message }
  })
}

// Map only supported color names to theme-aware CSS variables; never render log HTML.
export function logColor(value?: string): string | undefined {
  const name = value?.toLowerCase().replace(/^(?:(?:bold|light)_)+/, '')
  const colors: Record<string, string> = {
    black: 'neutral', white: 'neutral', gray: 'muted', grey: 'muted',
    red: 'red', green: 'green', yellow: 'yellow', orange: 'orange',
    blue: 'blue', cyan: 'cyan', purple: 'magenta', magenta: 'magenta',
  }
  return name && Object.prototype.hasOwnProperty.call(colors, name) ? `var(--log-${colors[name]})` : undefined
}
