// Wire messages between the two parties of a joint (v3, rgb-onchain-joint) loan.
// Transport-agnostic: the agents carry them NIP-44 encrypted over Nostr like the
// other party-to-party payloads. Each message is signed by the sender's party key
// from the agreed terms and bound to the loan id and the recipient's key, so a
// message from one loan or one counterparty can never be replayed into another.

import { hashObject, isHex, signObject, verifyObject, type Hex, type KeyPair } from '../core/crypto.js'
import type { DecimalAmount, OnchainArtifact, OnchainJointProposal, OnchainPrevout, OnchainSignedEnforcement } from './contract-stub.js'
import { JointRefused, type JointAction } from './ports.js'

export const JOINT_MESSAGE_DOMAIN = 'passbook-joint-message/v1'
/** Proposals carry the full colored PSBT and every artifact's bytes. */
const MAX_PSBT_CHARS = 16 * 1024 * 1024
const MAX_ARTIFACTS = 65

export interface ArtifactBytes { artifact: OnchainArtifact; bytes_base64: string }

export type JointBody =
  /** B → L: the borrower's Bitcoin inputs and the fee it pays, so L can build origination. */
  | { type: 'funding-inputs'; borrower_btc_inputs: OnchainPrevout[]; fee_sats: DecimalAmount }
  /** RGB sender → receiver: the colored, unsigned transaction and the full bytes the receiver must hold before signing. */
  | { type: 'proposal'; proposal: OnchainJointProposal; artifacts: ArtifactBytes[] }
  /** B → L, origination only: B's signed default and every liquidation spend of the future collateral. */
  | { type: 'enforcement'; parent_proposal_hash: Hex; spends: OnchainSignedEnforcement[] }
  /** First signer → second: the PSBT with the first signer's signatures. */
  | { type: 'signature'; action: JointAction; proposal_hash: Hex; unsigned_txid: Hex; signed_psbt_base64: string }
  /** Second signer → first, after its broadcast. Informational; each side reconciles from the chain. */
  | { type: 'broadcast'; action: JointAction; txid: Hex }

export type JointMessageType = JointBody['type']

export interface JointMessage {
  domain: typeof JOINT_MESSAGE_DOMAIN
  loan_id: Hex
  from: Hex
  to: Hex
  body: JointBody
  sig: Hex
}

export function sealJointMessage(key: KeyPair, loanId: Hex, to: Hex, body: JointBody): JointMessage {
  return signObject({ domain: JOINT_MESSAGE_DOMAIN, loan_id: loanId, from: key.pubkey, to, body }, key.secretKey)
}

export function jointMessageId(message: JointMessage): Hex { return hashObject(message) }

/** Checks envelope, signature and size bounds; the body's meaning is checked by the receiving role. */
export function openJointMessage(value: unknown, expect: { loan_id: Hex; from: Hex; to: Hex }): JointMessage {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new JointRefused('JOINT_MESSAGE_SHAPE')
  const m = value as JointMessage
  const keys = Object.keys(m).sort().join(',')
  if (keys !== 'body,domain,from,loan_id,sig,to') throw new JointRefused('JOINT_MESSAGE_SHAPE', 'unknown or missing field')
  if (m.domain !== JOINT_MESSAGE_DOMAIN) throw new JointRefused('JOINT_MESSAGE_DOMAIN')
  if (m.loan_id !== expect.loan_id) throw new JointRefused('JOINT_WRONG_LOAN')
  if (m.from !== expect.from || m.to !== expect.to) throw new JointRefused('JOINT_WRONG_PARTY')
  if (!isHex(m.sig, 64) || !verifyObject(m, expect.from)) throw new JointRefused('JOINT_BAD_SIGNATURE')
  checkBody(m.body)
  return m
}

function checkBody(body: unknown): asserts body is JointBody {
  if (!body || typeof body !== 'object') throw new JointRefused('JOINT_MESSAGE_SHAPE', 'body')
  const b = body as JointBody
  switch (b.type) {
    case 'funding-inputs':
      if (!Array.isArray(b.borrower_btc_inputs) || b.borrower_btc_inputs.length < 1 || b.borrower_btc_inputs.length > 64) throw new JointRefused('JOINT_MESSAGE_SHAPE', 'funding inputs')
      decimal(b.fee_sats)
      return
    case 'proposal':
      if (!b.proposal || typeof b.proposal !== 'object') throw new JointRefused('JOINT_MESSAGE_SHAPE', 'proposal')
      if (typeof b.proposal.colored_psbt_base64 !== 'string' || b.proposal.colored_psbt_base64.length > MAX_PSBT_CHARS) throw new JointRefused('JOINT_MESSAGE_SHAPE', 'psbt')
      if (!Array.isArray(b.artifacts) || b.artifacts.length > MAX_ARTIFACTS) throw new JointRefused('JOINT_MESSAGE_SHAPE', 'artifacts')
      for (const a of b.artifacts) {
        if (!a || !a.artifact || !isHex(a.artifact.sha256, 32) || typeof a.bytes_base64 !== 'string') throw new JointRefused('JOINT_MESSAGE_SHAPE', 'artifact')
      }
      return
    case 'enforcement':
      if (!isHex(b.parent_proposal_hash, 32) || !Array.isArray(b.spends) || b.spends.length < 1 || b.spends.length > 33) throw new JointRefused('JOINT_MESSAGE_SHAPE', 'enforcement')
      return
    case 'signature':
      if (!isAction(b.action) || !isHex(b.proposal_hash, 32) || !isHex(b.unsigned_txid, 32)) throw new JointRefused('JOINT_MESSAGE_SHAPE', 'signature')
      if (typeof b.signed_psbt_base64 !== 'string' || !b.signed_psbt_base64.length || b.signed_psbt_base64.length > MAX_PSBT_CHARS) throw new JointRefused('JOINT_MESSAGE_SHAPE', 'signed psbt')
      return
    case 'broadcast':
      if (!isAction(b.action) || !isHex(b.txid, 32)) throw new JointRefused('JOINT_MESSAGE_SHAPE', 'broadcast')
      return
    default:
      throw new JointRefused('JOINT_MESSAGE_TYPE')
  }
}

const isAction = (v: unknown): v is JointAction => v === 'origination' || v === 'repayment'

function decimal(v: unknown): void {
  if (typeof v !== 'string' || !/^(0|[1-9][0-9]{0,19})$/.test(v) || BigInt(v) > (1n << 64n) - 1n) throw new JointRefused('JOINT_MESSAGE_SHAPE', 'decimal u64 string required')
}
