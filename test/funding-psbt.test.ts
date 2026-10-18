// Adversarial unit fixtures exercise the real fund gate; wallet.send is a spy
// that throws, so no fabricated RGB transfer result can make a test pass.
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import * as bitcoin from 'bitcoinjs-lib'
import { LenderAgent, L2_POLICY } from '../src/agents/lender.js'
import { PlatformClient } from '../src/agents/platform-client.js'
import type { Relay } from '../src/agents/relay.js'
import { RuleReasoner } from '../src/ai/rule-reasoner.js'
import type { BitcoindChain } from '../src/chain/bitcoind.js'
import { FakeChain } from '../src/chain/fake.js'
import { opReturnScript } from '../src/chain/types.js'
import { hexToBytes, keyPairFromLabel, randomHex } from '../src/core/crypto.js'
import { termsHash, type LoanTerms } from '../src/core/terms.js'
import { buildEscrowSpend, escrowFor, keyPathOutput, leafSigner, partiesOf, signLeaf, splitLocktime, splitOutputs, verifyLeafSignature } from '../src/escrow/escrow.js'
import type { SignRequestPayload } from '../src/market/messages.js'
import { Oracle } from '../src/oracle/oracle.js'
import type { Party } from '../src/wallet/party.js'

const borrower = keyPairFromLabel('funding-adversary')
const lender = keyPairFromLabel('funding-creditor')
const platform = keyPairFromLabel('funding-platform')
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'passbook-fund-unit-'))
  const chain = new FakeChain(100)
  const t: LoanTerms = { v: 1, borrower_pk: borrower.pubkey, lender_pk: lender.pubkey, platform_pk: platform.pubkey, asset_id: 'rgb:unit-fixture', principal: 600_000_000, fee: 6_000_000, collateral_sats: 1_212_000, oracle_quote: new Oracle(platform, 10_000_000).quote(100), open_height: 100, maturity_height: 130, grace_blocks: 5, recovery_height: 155, ladder_step: 0, ltv_bps: 5000, prev_passbook_txid: null, nonce: randomHex() }
  const id = termsHash(t)
  const parties = partiesOf(t)
  const escrow = escrowFor(parties)
  const lock = chain.addTx([{ value: t.collateral_sats, script: escrow.script }, { value: 0, script: opReturnScript(id) }])
  chain.mine()
  const psbt = buildEscrowSpend({ escrow: { txid: lock, vout: 0, value: t.collateral_sats }, parties, leaf: 'A', outputs: splitOutputs(t), locktime: splitLocktime(t) })
  let sends = 0
  let request: SignRequestPayload
  const client = new PlatformClient('http://unused-unit-fixture')
  client.note = async () => ({ ok: true })
  const relay = { receive: async () => ({ payload: request, event: {} }), close() {} } as unknown as Relay
  const party = { role: 'lender1', key: lender, btcAddress: keyPathOutput(lender.pubkey).address, btcScript: keyPathOutput(lender.pubkey).script, rgb: { dataDir: join(dir, 'rgb'), signerId: 'rgb:funding-double', transferSummary: (o: { invoice: string; assetId: string; amount: number }) => ({ kind: 'rgb-transfer', network: 'regtest', asset_id: o.assetId, amount: o.amount, recipient_id: o.invoice, witness: true, witness_sats: 1000, transport_endpoints: [], invoice_sha256: '' }), send: async () => { sends++; throw new Error('RGB_SEND_REACHED') } }, close() {} } as unknown as Party
  const agent = new LenderAgent({ party, platform: client, relay, chain: chain as unknown as BitcoindChain, reasoner: new RuleReasoner(), mine: async () => { throw new Error('unexpected mine') }, policy: L2_POLICY, assetId: t.asset_id })
  // Set the already-underwritten loan; this test isolates the funding gate.
  ;(agent as unknown as { loans: Map<string, unknown> }).loans.set(id, { terms: t, borrower_pk: borrower.pubkey })
  return { t, parties, escrow, psbt, sends: () => sends, run: async () => { request = { purpose: 'split', loan_id: id, terms_hash: id, psbt_base64: psbt.toBase64(), disbursement_invoice: 'unconsumed-unit-fixture' }; return agent.fund(id) }, close: () => { agent.close(); rmSync(dir, { recursive: true, force: true }) } }
}

describe('funding requires a canonical default split bound to the actual collateral', () => {
  it('reaches the RGB send only for a valid borrower signature on the confirmed template', async () => {
    const f = fixture()
    try {
      signLeaf(f.psbt, f.parties, 'A', borrower.secretKey)
      await assert.rejects(f.run(), /RGB_SEND_REACHED/)
      assert.equal(f.sends(), 1)
      await assert.rejects(f.run(), /already attempted/)
      assert.equal(f.sends(), 1, 'an ambiguous external send result is not retried blindly')
    } finally { f.close() }
  })
  for (const attack of ['false amount', 'false script', 'wrong control block'] as const) {
    it(`rejects a genuinely signed ${attack} before sending any RGB`, async () => {
      const f = fixture()
      try {
        const input = f.psbt.data.inputs[0]
        if (attack === 'false amount') input.witnessUtxo!.value += 1n
        if (attack === 'false script') input.witnessUtxo!.script = hexToBytes(keyPathOutput(borrower.pubkey).script)
        if (attack === 'wrong control block') input.tapLeafScript![0].controlBlock[1] ^= 1
        signLeaf(f.psbt, f.parties, 'A', borrower.secretKey)
        assert.equal(verifyLeafSignature(f.psbt, f.parties, 'A', 'borrower'), true, 'the old check trusts the supplied metadata and accepts this signature')
        await assert.rejects(f.run(), /PSBT metadata/)
        assert.equal(f.sends(), 0)
      } finally { f.close() }
    })
  }
  for (const attack of ['wrong leaf script', 'wrong leaf version', 'extra leaf', 'missing leaf', 'sighash metadata', 'disabled locktime'] as const) {
    it(`rejects ${attack} before sending any RGB`, async () => {
      const f = fixture()
      try {
        signLeaf(f.psbt, f.parties, 'A', borrower.secretKey)
        const input = f.psbt.data.inputs[0]
        if (attack === 'wrong leaf script') input.tapLeafScript![0].script = f.escrow.leaves.C.script
        if (attack === 'wrong leaf version') { input.tapLeafScript![0].leafVersion = 0xc2; input.tapLeafScript![0].controlBlock[0] = (input.tapLeafScript![0].controlBlock[0] & 1) | 0xc2 }
        if (attack === 'extra leaf') input.tapLeafScript!.push({ leafVersion: 0xc0, script: f.escrow.leaves.C.script, controlBlock: f.escrow.leaves.C.controlBlock })
        if (attack === 'missing leaf') delete input.tapLeafScript
        if (attack === 'sighash metadata') input.sighashType = bitcoin.Transaction.SIGHASH_NONE
        if (attack === 'disabled locktime') {
          // Build the newly signed transaction with a final input sequence.
          delete input.tapScriptSig
          f.psbt.setInputSequence(0, 0xffffffff)
          signLeaf(f.psbt, f.parties, 'A', borrower.secretKey)
        }
        await assert.rejects(f.run(), /PSBT metadata|canonical default template/)
        assert.equal(f.sends(), 0)
      } finally { f.close() }
    })
  }
  it('rejects a valid 65-byte SIGHASH_NONE signature even with its metadata omitted', async () => {
    const f = fixture()
    try {
      f.psbt.updateInput(0, { sighashType: bitcoin.Transaction.SIGHASH_NONE })
      f.psbt.signTaprootInput(0, leafSigner(borrower.secretKey), f.escrow.leaves.A.leafHash, [bitcoin.Transaction.SIGHASH_NONE])
      assert.equal(verifyLeafSignature(f.psbt, f.parties, 'A', 'borrower'), true)
      delete f.psbt.data.inputs[0].sighashType
      await assert.rejects(f.run(), /PSBT metadata/)
      assert.equal(f.sends(), 0)
    } finally { f.close() }
  })
})
