// Signed calls to the operator console API (apps/console/API.md). Every
// request, GETs included, carries the x-passbook-* session signature. The
// standalone server (server.mjs) proxies /console/api/* to the platform
// unchanged, and the platform serves the same path itself, so the base is
// absolute in both cases.

import { signedHeaders } from '../session-auth.js'

export const API_BASE = '/console/api'

let session = null
export const setSession = (s) => { session = s }
export const getSession = () => session

export class ApiError extends Error {
  constructor(status, message, path) {
    super(message)
    this.status = status
    this.path = path
  }
  get unauthorized() { return this.status === 401 }
}

/** Percent-encodes a query value so the browser sends exactly the string we sign. */
export const q = (v) => encodeURIComponent(String(v)).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)

async function request(method, path, body, { accept = 'application/json', signal } = {}) {
  const url = `${API_BASE}${path}`
  const raw = body === undefined ? '' : JSON.stringify(body)
  let res
  try {
    const headers = { accept, ...(raw ? { 'content-type': 'application/json' } : {}), ...(await signedHeaders(session, method, url, raw)) }
    res = await fetch(url, { method, headers, body: raw || undefined, cache: 'no-store', credentials: 'omit', signal })
  } catch (err) {
    if (err?.name === 'AbortError') throw err
    throw new ApiError(0, `Network error calling ${method} ${url}: ${err?.message ?? err}`, url)
  }
  if (!res.ok) {
    let detail = ''
    try {
      const text = await res.text()
      try {
        const j = JSON.parse(text)
        detail = j.error ?? j.message ?? j.reason ?? text
      } catch { detail = text }
    } catch { /* no body */ }
    detail = String(detail || res.statusText || '').trim().slice(0, 300)
    throw new ApiError(res.status, `${method} ${url} answered ${res.status}${detail ? `: ${detail}` : ''}`, url)
  }
  return res
}

export async function apiGet(path, opts) {
  const res = await request('GET', path, undefined, opts)
  return res.json()
}

export async function apiPost(path, body, opts) {
  const res = await request('POST', path, body ?? {}, opts)
  const text = await res.text()
  try { return JSON.parse(text) } catch { return { raw: text } }
}

/** Fetches a signed file and saves it through a Blob and an anchor download. */
export async function apiDownload(path, filename) {
  const res = await request('GET', path, undefined, { accept: 'text/csv, */*' })
  const blob = await res.blob()
  const href = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = href
  a.download = filename
  a.rel = 'noopener'
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(href), 4000)
  return blob.size
}
