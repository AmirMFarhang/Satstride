// The check node's chain checks on a public test network (Mutinynet): the observer's allocations are re-checked
// unspent through Esplora when there is no bitcoind, and the history proof may be a configured number of blocks
// old (blocks keep coming every ~30 s). bitcoind/regtest is unchanged.
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { ChainClient } from '../src/chain/types.js'
import { hashObject, keyPairFromLabel, signObject } from '../src/core/crypto.js'
import { historyLedger } from '../src/sandbox/reconcile.js'
import type { Bundle } from '../src/sandbox/types.js'
import { historyProofMaxAge, nodeUnspent, PUBLIC_NETWORK_PROOF_MAX_AGE_BLOCKS, runChainChecks } from '../src/scorer/chain-checks.js'

const txid = 'ab'.repeat(32)
const script = '5120' + 'cd'.repeat(32)

describe('nodeUnspent', () => {
  it('bitcoind: gettxout exactly as before', async () => {
    const calls: unknown[] = []
    const chain = { rpc: async (m: string, p: unknown[]) => { calls.push([m, p]); return { value: 0.00001, scriptPubKey: { hex: script } } } } as unknown as ChainClient
    assert.deepEqual(await nodeUnspent(chain)!(txid, 1), { value: 1000, script })
    assert.deepEqual(calls, [['gettxout', [txid, 1, true]]])
  })
  it('Esplora: unspent per /outspend, value and script from the confirmed transaction', async () => {
    const esplora = (o: { spent?: boolean; height?: number | null }) => ({
      outspends: async () => (o.spent === undefined ? [] : [{ spent: false }, { spent: o.spent }]),
      getTx: async () => ({ txid, height: o.height === undefined ? 100 : o.height, inputs: [], outputs: [{ value: 1, script: '00' }, { value: 1000, script }] }),
      getHeight: async () => 110,
    }) as unknown as ChainClient
    assert.deepEqual(await nodeUnspent(esplora({ spent: false }))!(txid, 1), { value: 1000, script })
    assert.equal(await nodeUnspent(esplora({ spent: true }))!(txid, 1), null, 'spent')
    assert.equal(await nodeUnspent(esplora({ spent: false, height: null }))!(txid, 1), null, 'unconfirmed')
    assert.equal(await nodeUnspent(esplora({ spent: undefined }))!(txid, 1), null, 'unknown status is not unspent')
    assert.equal(await nodeUnspent(esplora({ spent: false }))!(txid, 5), null, 'no such output')
  })
  it('neither: undefined, so reconciliation fails closed', () => {
    assert.equal(nodeUnspent({ getTx: async () => null, getHeight: async () => 1 } as unknown as ChainClient), undefined)
  })
})

describe('historyProofMaxAge', () => {
  it('refuses mainnet', () => {
    assert.throws(() => historyProofMaxAge({ PASSBOOK_PUBLIC_NETWORK: 'mainnet', PASSBOOK_HISTORY_PROOF_MAX_AGE_BLOCKS: '240' }), /refuse mainnet/)
  })
  it('defaults by the chain read: 0 on bitcoind (regtest unchanged), the public-network window on an Esplora', () => {
    assert.equal(historyProofMaxAge({}, 'bitcoind'), 0)
    assert.equal(historyProofMaxAge({}, 'esplora'), PUBLIC_NETWORK_PROOF_MAX_AGE_BLOCKS)
    assert.equal(historyProofMaxAge({ PASSBOOK_HISTORY_PROOF_MAX_AGE_BLOCKS: '0' }, 'esplora'), 0, 'an explicit setting wins')
  })
  it('is 0 unless configured (regtest unchanged), the configured window otherwise, and bounded', () => {
    assert.equal(historyProofMaxAge({}), 0)
    assert.equal(historyProofMaxAge({ PASSBOOK_HISTORY_PROOF_MAX_AGE_BLOCKS: '' }), 0)
    assert.equal(historyProofMaxAge({ PASSBOOK_HISTORY_PROOF_MAX_AGE_BLOCKS: '240' }), 240)
    assert.throws(() => historyProofMaxAge({ PASSBOOK_HISTORY_PROOF_MAX_AGE_BLOCKS: '-1' }), /0 to 4320/)
    assert.throws(() => historyProofMaxAge({ PASSBOOK_HISTORY_PROOF_MAX_AGE_BLOCKS: '99999' }), /0 to 4320/)
    assert.throws(() => historyProofMaxAge({ PASSBOOK_HISTORY_PROOF_MAX_AGE_BLOCKS: 'soon' }), /0 to 4320/)
  })
})

describe('runChainChecks on an Esplora chain with an observer-signed proof', () => {
  // A synthetic proof the way the observer signs it: one 100 TUSDT inflow at height 100, one allocation of 1,000 sats,
  // the proof signed at height 110; the chain's tip is 120 (10 blocks later, as on Mutinynet a few minutes on).
  const observer = keyPairFromLabel('chain-checks-observer')
  const borrower = keyPairFromLabel('chain-checks-borrower').pubkey
  const signer = keyPairFromLabel('chain-checks-signer')
  const asset = 'rgb:test-asset'
  const inflow = { txid: 'ab'.repeat(32), height: 100, direction: 'in' as const, amount: 100_000_000, recipient_id: 'r', counterparty_pk: 'cd'.repeat(32) }
  const allocations = [{ txid: inflow.txid, vout: 1, amount: inflow.amount, bitcoin_sats: 1000, script }]
  const proof = signObject({ v: 1 as const, assurance: 'trusted_wallet_snapshot' as const, observer_pk: observer.pubkey, borrower_pk: borrower, asset_id: asset, wallet_xpubs_hash: 'ee'.repeat(32), observed_from_zero: true, first_transfer_txid: inflow.txid, opening_balance: 0, current_balance: inflow.amount, height: 110, transfers: [inflow], allocations, native_snapshot_hash: hashObject({ ledger: historyLedger([inflow]), balance: inflow.amount, allocations }), btc_history: { status: 'verified' } }, observer.secretKey)
  const bundle = { borrower_pk: borrower, offer_id: 'o', asset_id: asset, balance: inflow.amount, history: [{ txid: inflow.txid, height: 100, direction: 'in', amount: inflow.amount, counterparty_pk: inflow.counterparty_pk, memo: '' }], history_proof: proof } as unknown as Bundle
  const esplora = (spent: boolean) => ({ kind: 'esplora', getHeight: async () => 120, getTx: async () => ({ txid: inflow.txid, height: 100, inputs: [], outputs: [{ value: 1, script: '00' }, { value: 1000, script }] }), outspends: async () => [{ spent: false }, { spent }] }) as unknown as ChainClient
  const reconciled = async (chain: ChainClient, maxAgeBlocks?: number) => (await runChainChecks(bundle, chain, signer, { trustedSigners: [observer.pubkey], lender_pk: 'aa'.repeat(32), purpose_id: 'p', ...(maxAgeBlocks === undefined ? {} : { maxAgeBlocks }) })).checks.find((c) => c.id === 'history_reconciliation')!.ok

  it('refuses a proof 10 blocks old at window 0 (regtest behaviour)', async () => {
    assert.equal(await reconciled(esplora(false), 0), false)
  })
  it('accepts it with no setting at all on an Esplora chain (the standard Mutinynet deployment)', async () => {
    const saved = process.env.PASSBOOK_HISTORY_PROOF_MAX_AGE_BLOCKS
    delete process.env.PASSBOOK_HISTORY_PROOF_MAX_AGE_BLOCKS
    try { assert.equal(await reconciled(esplora(false)), true) } finally { if (saved !== undefined) process.env.PASSBOOK_HISTORY_PROOF_MAX_AGE_BLOCKS = saved }
  })
  it('accepts it inside a configured window, with every allocation re-checked unspent through Esplora', async () => {
    assert.equal(await reconciled(esplora(false), 240), true)
  })
  it('refuses it inside the window when an allocation was spent after the proof', async () => {
    assert.equal(await reconciled(esplora(true), 240), false)
  })
})
