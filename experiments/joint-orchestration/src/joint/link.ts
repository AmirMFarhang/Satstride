// Carries one joint loan's messages between the two agents over their Nostr
// bus: NIP-44 encrypted to the counterparty (KIND.JOINT), split into signed
// chunks when a proposal with its proof bytes is larger than a relay accepts.
// The link only moves messages; the role (JointBorrower / JointLender) checks
// every one of them again (sender, recipient, loan, signature) and decides.

import type { Hex } from '../core/crypto.js'
import { chunkedBus, type CheckBus } from '../checknode/bus.js'
import { KIND } from '../market/kinds.js'
import { JOINT_MESSAGE_DOMAIN, type JointMessage } from './messages.js'

export interface JointReceiver { receive(raw: unknown): Promise<JointMessage[]> }

export class JointLink {
  readonly #bus: CheckBus

  constructor(bus: CheckBus, private readonly party: JointReceiver, private readonly loanId: Hex, private readonly counterpartyPk: Hex) {
    this.#bus = chunkedBus(bus)
  }

  async send(messages: JointMessage | JointMessage[]): Promise<void> {
    for (const m of Array.isArray(messages) ? messages : [messages]) await this.#bus.send(KIND.JOINT, m, this.counterpartyPk)
  }

  /** Waits for this loan's next message from the counterparty, hands it to the role and sends its replies. */
  async step(timeoutMs = 60_000): Promise<{ received: JointMessage; replies: JointMessage[] }> {
    const { payload } = await this.#bus.receive<JointMessage>(KIND.JOINT, this.counterpartyPk, {
      timeoutMs,
      match: (m) => !!m && typeof m === 'object' && m.domain === JOINT_MESSAGE_DOMAIN && m.loan_id === this.loanId,
    })
    const replies = await this.party.receive(payload)
    await this.send(replies)
    return { received: payload, replies }
  }
}
