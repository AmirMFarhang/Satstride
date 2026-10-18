import type { App } from '../server/app.js'

export class DemoStopped extends Error {
  constructor() { super('Demo stopped at a safe checkpoint'); this.name = 'DemoStopped' }
}

type Waiting = 'next' | 'approve' | 'confirm'
type RecordWait = <T>(waiting: Waiting, info: Record<string, unknown>, run: () => Promise<T>) => Promise<T>

/** A restart freezes the current approval before the supervisor closes its writer. */
export class DemoGate {
  waiting: Record<string, unknown> = { waiting: null }
  private release?: (value: unknown) => void
  private reject?: (error: Error) => void
  private frozen = false
  private cancelled = false

  constructor(private readonly app: Pick<App, 'api'>, public scenario: 'standard' | 'margin' | 'cure', private readonly record?: RecordWait) {}

  wait<T>(waiting: Waiting, info: Record<string, unknown>): Promise<T> {
    if (this.record) return this.record<T>(waiting, info, () => this.waitLive<T>(waiting, info))
    return this.waitLive<T>(waiting, info)
  }

  private waitLive<T>(waiting: Waiting, info: Record<string, unknown>): Promise<T> {
    if (this.cancelled) return Promise.reject(new DemoStopped())
    if (this.release) throw new Error('An approval is already waiting')
    this.waiting = { waiting, ...info }
    return new Promise<T>((resolve, reject) => {
      this.release = resolve as (value: unknown) => void
      this.reject = reject
      this.emit()
    })
  }

  answer(kind: Waiting, value?: unknown, stop?: string, loanId?: string): boolean {
    if (this.frozen || this.cancelled) return false
    if (kind === 'next' && value !== undefined && !((this.waiting.scenarios as unknown[] | undefined) ?? []).includes(value)) return false
    if (this.waiting.waiting !== kind || !this.release) return false
    if (kind === 'confirm' && (this.waiting.stop !== stop || this.waiting.loan_id !== loanId)) return false
    const resolve = this.release
    this.release = undefined
    this.reject = undefined
    this.waiting = { waiting: null }
    this.emit()
    resolve(value)
    return true
  }

  freeze(): boolean {
    if (!this.release || this.waiting.waiting === null) return false
    this.frozen = true
    return true
  }

  unfreeze(): void { if (!this.cancelled) this.frozen = false }

  cancel(): void {
    this.frozen = true
    this.cancelled = true
    const reject = this.reject
    this.release = undefined
    this.reject = undefined
    this.waiting = { waiting: null }
    this.emit()
    reject?.(new DemoStopped())
  }

  stop(error?: string): void {
    const stoppedError = error ?? (typeof this.waiting.error === 'string' ? this.waiting.error : undefined)
    this.waiting = { waiting: null, ...(stoppedError ? { error: stoppedError } : {}) }
    this.emit()
  }

  private emit(): void { this.app.api.emit({ type: 'demo', scenario: this.scenario, ...this.waiting }) }
}
