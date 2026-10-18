// Preload (node --import) for processes that talk to public Nostr relays.
//
// With Node 22's built-in WebSocket (undici) and nostr-tools 2.25.x, a relay that cannot be
// reached (refused, timed out, TLS failure) crashes the whole process: nostr-tools' onerror
// calls ws.close() on a socket that is still connecting, undici fires another error event
// synchronously, which calls close() again, until "Maximum call stack size exceeded". A
// public relay being down must not take the lender peer or the check node down with it.
// This makes close() idempotent and never re-entrant; nothing else changes.
const Base = globalThis.WebSocket
if (Base && !Base.__passbookGuarded) {
  class GuardedWebSocket extends Base {
    #closing = false
    close(code, reason) {
      if (this.#closing) return
      this.#closing = true
      try { super.close(code, reason) } catch { /* already failed or closed */ }
    }
  }
  Object.defineProperty(GuardedWebSocket, '__passbookGuarded', { value: true })
  globalThis.WebSocket = GuardedWebSocket
}
