import { net } from 'electron'
import { fetchWithTimeout } from './http.js'
import type { ProjectRelease } from './types.js'

const KIRAAI_RELEASES_API_URL = 'https://api.github.com/repos/KiraAI-Dev/KiraAI/releases/latest'
const RELEASE_CACHE_TTL_MS = 15 * 60 * 1000

/** One main-process cache per release resource; failures remain retryable. */
function cacheReleaseResource<T>(fetchResource: () => Promise<T>): () => Promise<T> {
  let cached: { value: T; expiresAt: number } | undefined
  let pending: Promise<T> | undefined
  return async () => {
    if (cached && Date.now() < cached.expiresAt) return cached.value
    if (!pending) {
      pending = fetchResource().then((value) => {
        cached = { value, expiresAt: Date.now() + RELEASE_CACHE_TTL_MS }
        return value
      }).finally(() => { pending = undefined })
    }
    return pending
  }
}

const cachedProjectReleases = cacheReleaseResource(fetchProjectReleases)
const cachedLatestReleaseArchiveUrl = cacheReleaseResource(fetchLatestReleaseArchiveUrl)

export async function listProjectReleases(): Promise<ProjectRelease[]> {
  // Keep callers from mutating the shared cache in preparation for other consumers.
  return (await cachedProjectReleases()).map((release) => ({ ...release }))
}

export function getLatestReleaseArchiveUrl(): Promise<string> {
  return cachedLatestReleaseArchiveUrl()
}

function downloadError(code: string): Error {
  return new Error(code)
}

async function fetchProjectReleases(): Promise<ProjectRelease[]> {
  try {
    const payload: unknown = await fetchWithTimeout('https://api.github.com/repos/KiraAI-Dev/KiraAI/releases?per_page=50', 15_000, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'KiraAI-Launcher' },
    }, async (response) => {
      const rateLimited = response.status === 429 || (response.status === 403 && (response.headers.get('x-ratelimit-remaining') === '0' || response.headers.has('retry-after')))
      if (!response.ok) {
        await response.body?.cancel()
        throw downloadError(rateLimited ? 'RELEASE_LIST_RATE_LIMITED' : 'RELEASE_LIST_FAILED')
      }
      return response.json()
    })
    if (!Array.isArray(payload)) throw downloadError('RELEASE_LIST_FAILED')
    const releases: ProjectRelease[] = []
    for (const release of payload.slice(0, 50)) {
      if (!release || release.draft || typeof release.tag_name !== 'string' || !release.tag_name.trim()) continue
      if (!releases.some(({ tag }) => tag === release.tag_name)) {
        releases.push({ tag: release.tag_name, prerelease: release.prerelease === true })
      }
    }
    return releases
  } catch (error) {
    if (error instanceof Error && error.message === 'RELEASE_LIST_RATE_LIMITED') throw error
    throw downloadError('RELEASE_LIST_FAILED')
  }
}

async function fetchLatestReleaseArchiveUrl(): Promise<string> {
  let rateLimited = false
  try {
    const payload = await fetchWithTimeout(KIRAAI_RELEASES_API_URL, 15_000, { headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'KiraAI-Launcher' } }, async (response) => {
      rateLimited = response.status === 429 || (response.status === 403 && (response.headers.get('x-ratelimit-remaining') === '0' || response.headers.has('retry-after')))
      if (!response.ok) {
        await response.body?.cancel()
        throw new Error('HTTP_ERROR')
      }
      return response.json() as Promise<{ tag_name?: unknown }>
    })
    if (typeof payload.tag_name !== 'string' || !payload.tag_name.trim()) throw new Error('INVALID_RESPONSE')
    return 'https://github.com/KiraAI-Dev/KiraAI/archive/refs/tags/' + encodeURIComponent(payload.tag_name) + '.zip'
  } catch {
    // The public release page remains usable when the REST API is unavailable.
    // Follow GitHub's canonical repository redirect, including repository transfers.
  }

  try {
    return await getReleasePageArchiveUrl()
  } catch {
    throw downloadError(rateLimited ? 'RELEASE_RATE_LIMITED' : 'RELEASE_LOOKUP_FAILED')
  }
}

function getReleasePageArchiveUrl(): Promise<string> {
  // Electron net.fetch does not expose the final Response.url reliably.
  return new Promise((resolve, reject) => {
    const request = net.request({ url: 'https://github.com/KiraAI-Dev/KiraAI/releases/latest', redirect: 'manual' })
    let settled = false
    let redirects = 0
    const finish = (archiveUrl?: string) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      request.abort()
      if (archiveUrl) resolve(archiveUrl)
      else reject(downloadError('RELEASE_LOOKUP_FAILED'))
    }
    const timeout = setTimeout(() => finish(), 15_000)
    request.on('redirect', (_statusCode, _method, target) => {
      try {
        const releaseUrl = new URL(target)
        if (++redirects > 5 || releaseUrl.origin !== 'https://github.com') return finish()
        const match = /^\/([^/]+\/KiraAI)\/releases\/tag\/(.+)$/i.exec(releaseUrl.pathname)
        if (match) {
          const tag = decodeURIComponent(match[2])
          if (!tag.trim()) return finish()
          return finish('https://github.com/' + match[1] + '/archive/refs/tags/' + encodeURIComponent(tag) + '.zip')
        }
        if (!/^\/[^/]+\/KiraAI\/releases\/latest$/i.test(releaseUrl.pathname)) return finish()
        request.followRedirect()
      } catch {
        finish()
      }
    })
    request.once('error', () => finish())
    request.once('response', (response) => {
      response.once('error', () => finish())
      finish()
    })
    try {
      request.setHeader('Accept', 'text/html')
      request.setHeader('User-Agent', 'KiraAI-Launcher')
      request.end()
    } catch {
      finish()
    }
  })
}
