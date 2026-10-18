// What borrower and lender agents share: their party wallets, the platform API,
// the relays, read access to Bitcoin, a guarded local model, and a signed line
// on the wire for everything they do. Agents never see each other's wallets.

import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type * as bitcoin from 'bitcoinjs-lib'
import { GuardedReasoner } from '../ai/guarded.js'
import { primaryReasonerFromEnv } from '../ai/engine.js'
import type { AiTrace, Reasoner } from '../ai/types.js'
import { BitcoindChain } from '../chain/bitcoind.js'
import { signObject, type Hex } from '../core/crypto.js'
import type { Sats } from '../core/money.js'
import type { EscrowParties, Leaf } from '../escrow/escrow.js'
import { negotiationId } from '../market/negotiate.js'
import type { Signer } from '../wallet/signer.js'
import { availableSanctionsScreen } from '../compliance/sanctions.js'
import { NodeGovernance, type SignContext } from '../governance/node.js'
import type { Party } from '../wallet/party.js'
import { PlatformClient } from './platform-client.js'
import { IouDesk } from './iou-desk.js'
import { Relay } from './relay.js'

export type Mine = (blocks?: number) => Promise<unknown>

export interface AgentDeps {
  party: Party
  platform?: PlatformClient
  relay?: Relay
  chain?: BitcoindChain
  /** primary model; wrapped in the guard here. Defaults to PASSBOOK_AI (see ai/engine.ts). */
  reasoner?: Reasoner
  /** produce blocks: on regtest the demo mines on demand */
  mine: Mine
  /** where narration goes besides the wire (the terminal in the demo) */
  log?: (role: string, title: string, detail?: unknown) => void
  /** The node's policy gate and decision log; by default <wallets>/<role>/governance with the demo policy. */
  governance?: NodeGovernance
}

/** What an agent asks the gate for; the agent is always the initiator. */
export type AgentSignContext = Omit<SignContext, 'initiator'>

/** <wallets>/<role>/governance next to the party's RGB data, or in memory for a wallet directory that does not exist (test doubles). */
export function governanceFor(party: Party): NodeGovernance {
  const walletDir = party.rgb?.dataDir ? dirname(party.rgb.dataDir) : null
  return new NodeGovernance({ ownerKey: party.key, dir: walletDir && existsSync(walletDir) ? join(walletDir, 'governance') : null, sanctions: availableSanctionsScreen() })
}

export function reasonerFromEnv(): Reasoner {
  return primaryReasonerFromEnv()
}

export class Agent {
  readonly party: Party
  readonly platform: PlatformClient
  readonly relay: Relay
  readonly chain: BitcoindChain
  readonly ai: GuardedReasoner
  readonly mine: Mine
  readonly iou: IouDesk
  readonly traces: AiTrace[] = []
  /** Every money-moving signature this agent makes passes this node's policy gate. */
  readonly governance: NodeGovernance
  /** Resolves once the RGB wallet is under the gate's WDK policy. */
  readonly governed: Promise<void>
  private readonly log?: AgentDeps['log']

  constructor(deps: AgentDeps) {
    this.party = deps.party
    this.iou = new IouDesk(this)
    const platform = deps.platform ?? new PlatformClient()
    // Sign every platform request with this agent's key when the client supports it.
    this.platform = typeof platform.as === 'function' ? platform.as(deps.party.key) : platform
    this.relay = deps.relay ?? new Relay(deps.party.key)
    this.governance = deps.governance ?? governanceFor(deps.party)
    const rgb = deps.party.rgb as Partial<Party['rgb']> | undefined
    this.governed = typeof rgb?.enroll === 'function' ? this.governance.enrollWallet(rgb as Party['rgb']) : Promise.resolve()
    // a failed enrolment surfaces at the next send (which awaits it), never as an unhandled rejection
    this.governed.catch(() => {})
    // The kill switch: once this agent is stopped at its gate, nothing more leaves it. Every outbound path is
    // guarded: the common publish primitive and, for relays that do not route through it, send and publishPublic.
    for (const name of ['publish', 'send', 'publishPublic'] as const) {
      const original = (this.relay as unknown as Record<string, unknown>)[name]
      if (typeof original !== 'function') continue
      const bound = (original as (...a: unknown[]) => Promise<unknown>).bind(this.relay)
      ;(this.relay as unknown as Record<string, unknown>)[name] = async (...args: unknown[]) => { this.governance.assertActive(this.role); return bound(...args) }
    }
    this.chain = deps.chain ?? BitcoindChain.fromEnv()
    this.mine = deps.mine
    this.log = deps.log
    this.ai = new GuardedReasoner(deps.reasoner ?? reasonerFromEnv(), (t) => {
      this.traces.push(t)
      void this.say(`model: ${t.task}`, { engine: t.engine, ms: t.ms, fallback: t.fallbackReason ?? null })
    })
  }

  get role(): string {
    return this.party.role
  }

  get pubkey(): Hex {
    return this.party.key.pubkey
  }

  /** Narrate a step: to the terminal and, signed, to the platform's wire. Never raw wallet data. */
  async say(title: string, detail?: unknown): Promise<void> {
    this.log?.(this.role, title, detail)
    const note = signObject({ actor_pk: this.pubkey, role: this.role, title, detail: detail ?? null }, this.party.key.secretKey)
    try {
      await this.platform.note(note)
    } catch {
      // the wire is best effort; the platform being down must not stop a payment
    }
  }

  /** Optional index writes cannot gate an already-authorized peer payment. */
  async index(label: string, write: () => Promise<unknown>): Promise<void> {
    try { await write() } catch (err) { await this.say(`Index warning: ${label}`, { warning: (err as Error).message }) }
  }

  /** Unspent outputs at this party's key-path address, from bitcoind's UTXO set. */
  async btcUtxos(): Promise<{ txid: Hex; vout: number; value: Sats }[]> {
    const r = await this.chain.rpc<{ unspents: { txid: string; vout: number; amount: number }[] }>('scantxoutset', ['start', [`addr(${this.party.btcAddress})`]])
    return r.unspents.map((u) => ({ txid: u.txid, vout: u.vout, value: Math.round(u.amount * 1e8) }))
  }

  /** Sign an escrow leaf through this node's policy gate. */
  async signLeaf(psbt: bitcoin.Psbt, parties: EscrowParties, leaf: Leaf, ctx: AgentSignContext): Promise<bitcoin.Psbt> {
    return this.governance.signLeaf(psbt, parties, leaf, this.party.key.secretKey, { ...ctx, initiator: { agent: this.role } })
  }

  /** Sign this party's own key-path inputs through the gate. */
  async signKeyPath(psbt: bitcoin.Psbt, ctx: AgentSignContext): Promise<bitcoin.Psbt> {
    return this.governance.signKeyPath(psbt, this.party.key.secretKey, { ...ctx, initiator: { agent: this.role } })
  }

  /**
   * The Signer for this agent's messages in one negotiation: its party key behind a session key scoped to that
   * negotiation, so `passbook agent stop` refuses the agent's next message mid-negotiation.
   */
  negotiationSigner(borrowerPk: Hex, nonce: Hex): Signer {
    return this.governance.gate.sessionSigner(this.party.key, this.governance.session(this.role, negotiationId(borrowerPk, nonce)))
  }

  /** Send over RGB through the gate. */
  async sendRgb(opts: { invoice: string; assetId: string; amount: number; feeRate?: number }, ctx: AgentSignContext): Promise<{ txid: string; batchTransferIdx: number }> {
    await this.governed
    return this.governance.sendRgb(this.party.rgb, opts, { ...ctx, initiator: { agent: this.role } })
  }

  async broadcast(hex: Hex): Promise<Hex> {
    return this.chain.rpc<Hex>('sendrawtransaction', [hex])
  }

  close(): void {
    this.relay.close()
  }
}
