import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { ONCHAIN_NATIVE_REVISION } from '../settlement/onchain-v3-contract.js'

const MAX_FRAME = 24 * 1024 * 1024
export class NativeOwnerUnavailable extends Error {
  constructor() { super('NATIVE_OWNER_UNAVAILABLE: reconcile retained operations before retrying any side effect') }
}
/** Private local IPC. No HTTP listener, seed arguments, shell, automatic restarts or
 * retries. Native holds an OS lock over both its journal and its fresh RGB wallet. */
export class NativeWalletOwner {
  readonly #child: ChildProcessWithoutNullStreams
  readonly #pending = new Map<number, { method: string; resolve(value: unknown): void; reject(e: Error): void; timer: ReturnType<typeof setTimeout> }>()
  #next = 0
  #buffer = Buffer.alloc(0)
  #failed = false
  #tail = Promise.resolve()
  private constructor(binary: string, args: string[], private readonly timeoutMs: number) {
    this.#child = spawn(binary, args, { stdio: ['pipe', 'pipe', 'pipe'] })
    this.#child.stdout.on('data', (chunk: Buffer) => this.#read(chunk))
    // Drain stderr without forwarding native paths or seed-bearing error contexts.
    this.#child.stderr.on('data', () => {})
    this.#child.on('error', () => this.#fail())
    this.#child.on('exit', () => this.#fail())
    this.#child.stdin.on('error', () => this.#fail())
  }
  static async start(binary: string, directory: string, timeoutMs = 120_000): Promise<NativeWalletOwner> {
    return NativeWalletOwner.startCommand(binary, [directory], timeoutMs)
  }
  /** Local device transport for acceptance and packaged native process bridges. */
  static async startCommand(command: string, args: string[], timeoutMs = 120_000): Promise<NativeWalletOwner> {
    const owner = new NativeWalletOwner(command, args, timeoutMs)
    try {
      const cap = await owner.call<{ native_revision: string; network: string; wallet_owner: string }>('capabilities', {})
      if (cap.native_revision !== ONCHAIN_NATIVE_REVISION || cap.network !== 'regtest' || cap.wallet_owner !== 'exclusive-os-lock/v1') throw new Error('NATIVE_CAPABILITIES_MISMATCH')
      return owner
    } catch (e) { await owner.close(); throw e }
  }
  #read(chunk: Buffer) {
    this.#buffer = Buffer.concat([this.#buffer, chunk])
    while (!this.#failed) {
      const end = this.#buffer.indexOf(10)
      if (end < 0) { if (this.#buffer.length > MAX_FRAME) this.#fail(); return }
      if (end > MAX_FRAME) { this.#fail(); return }
      const line = this.#buffer.subarray(0, end)
      this.#buffer = this.#buffer.subarray(end + 1)
      let reply: { id: number; result?: unknown; error?: { code: string } }
      try { reply = JSON.parse(line.toString('utf8')) } catch { this.#fail(); return }
      const pending = this.#pending.get(reply.id)
      if (!pending) { this.#fail(); return }
      this.#pending.delete(reply.id); clearTimeout(pending.timer)
      if (reply.error) pending.reject(new Error(`NATIVE_REFUSED: ${pending.method}: ${reply.error.code}`))
      else if (Object.hasOwn(reply, 'result')) pending.resolve(reply.result)
      else { pending.reject(new NativeOwnerUnavailable()); this.#fail() }
    }
  }
  #fail() {
    if (this.#failed) return
    this.#failed = true
    for (const p of this.#pending.values()) { clearTimeout(p.timer); p.reject(new NativeOwnerUnavailable()) }
    this.#pending.clear(); this.#child.kill('SIGTERM')
  }
  /** One call in flight, including across callers of this owner. Native independently
   * enforces immutable obligation slots across caller keys and process restarts. */
  async call<T>(method: string, params: unknown): Promise<T> {
    let release!: () => void
    const before = this.#tail
    this.#tail = new Promise<void>(r => { release = r })
    await before
    try {
      if (this.#failed) throw new NativeOwnerUnavailable()
      const id = ++this.#next
      const bytes = JSON.stringify({ id, method, params }) + '\n'
      if (Buffer.byteLength(bytes) > MAX_FRAME) throw new Error('NATIVE_REQUEST_TOO_LARGE')
      return await new Promise<T>((resolve, reject) => {
        const timer = setTimeout(() => this.#fail(), this.timeoutMs)
        this.#pending.set(id, { method, resolve: value => resolve(value as T), reject, timer })
        this.#child.stdin.write(bytes, error => { if (error) this.#fail() })
      })
    } finally { release() }
  }
  get pid(): number | undefined { return this.#child.pid }
  async close(): Promise<void> {
    if (this.#child.exitCode !== null || this.#child.signalCode !== null) return
    this.#fail()
    await new Promise<void>(resolve => { this.#child.once('exit', () => resolve()) })
  }
}
