import { net } from 'electron'

/** Keeps the abort deadline active until the optional response reader finishes. */
export async function fetchWithTimeout(url: string, timeoutMs: number, init?: RequestInit): Promise<Response>
export async function fetchWithTimeout<T>(url: string, timeoutMs: number, init: RequestInit | undefined, readResponse: (response: Response) => Promise<T>): Promise<T>
export async function fetchWithTimeout<T>(url: string, timeoutMs: number, init?: RequestInit, readResponse?: (response: Response) => Promise<T>): Promise<Response | T> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await net.fetch(url, { ...init, signal: controller.signal })
    return readResponse ? await readResponse(response) : response
  } finally {
    clearTimeout(timeout)
  }
}
