// Types for web/session-auth.js, so TypeScript tests can import the browser module.
export interface BrowserSession { id: string; secret: string }
export function sha256Hex(text: string): Promise<string>
export function requestDigest(method: string, pathAndQuery: string, timestampMs: number, nonce: string, body: string): Promise<string>
export function readSession(loc?: { hash?: string; pathname: string; search: string }, storage?: { getItem(k: string): string | null; setItem(k: string, v: string): void } | null, history?: { replaceState(a: null, b: string, c: string): void } | null): BrowserSession | null
export function signedHeaders(session: BrowserSession | null, method: string, pathAndQuery: string, body: string, now?: number): Promise<Record<string, string>>
export function signedPost(session: BrowserSession | null, path: string, body?: unknown, fetchImpl?: typeof fetch): Promise<Response>
