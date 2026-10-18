import assert from 'node:assert/strict'
import { test } from 'node:test'
import { canonicalJson, hashObject, sha256Hex } from '../../src/core/crypto.js'
import { nativeActor, nativeSettled, nativeTransfer } from './native-helpers.js'

const enabled = process.env.PASSBOOK_NATIVE_ACCEPTANCE === '1'
test('native receipt: exact media, durable one-time issuance, send/receive; one-unit NIA redemption', { skip: !enabled, timeout: 120_000 }, async () => {
  const operator = await nativeActor('asset-operator')
  const holder = await nativeActor('asset-holder')
  try {
    const slot = hashObject({ wallet: operator.walletId, purchase: 'optional-receipt-test' })
    await operator.owner.call('slot_reserve', { slot, intent_hash: sha256Hex('purchase'), intent: { purchase: 'test' } })
    const data = { v: 1, kind: 'passbook-check-receipt', commitment: '11'.repeat(32), evidence_digest: '22'.repeat(32), release_hash: '33'.repeat(32), operator_pk: operator.gate.pubkey, tier: 'software-evidence', date: '2026-10-18' }
    const media = Buffer.from(canonicalJson(data))
    const artifact = await operator.owner.call<{ sha256: string }>('artifact_put', { hex: media.toString('hex') })
    const receipt = await operator.owner.call<{ asset_id: string; details: string }>('issue_receipt', { slot, media_sha256: artifact.sha256 })
    const again = await operator.owner.call<{ asset_id: string }>('issue_receipt', { slot, media_sha256: artifact.sha256 })
    assert.equal(again.asset_id, receipt.asset_id)
    assert.equal(receipt.details, 'passbook-check-receipt/v1 sha256:' + sha256Hex(media))
    await nativeTransfer(operator, holder, receipt.asset_id, 'uda')
    const held = await holder.owner.call<{ hex: string; details: string }>('read_receipt', { asset_id: receipt.asset_id })
    assert.equal(held.hex, media.toString('hex')); assert.equal(held.details, receipt.details)
    // Repeat issuance replays the same result even after the token leaves the issuer.
    assert.equal((await operator.owner.call<{ asset_id: string }>('issue_receipt', { slot, media_sha256: artifact.sha256 })).asset_id, receipt.asset_id)
    const malicious = await operator.owner.call<{ sha256: string }>('artifact_put', { hex: Buffer.from(canonicalJson({ ...data, raw_report: 'forbidden' })).toString('hex') })
    await assert.rejects(() => operator.owner.call('issue_receipt', { slot, media_sha256: malicious.sha256 }), /NATIVE_REFUSED/)
    // Fork NIA redemption is a transfer of a real one-unit allocation, never burn.
    const voucher = await operator.owner.call<{ asset_id: string }>('issue_nia', { ticker: 'PBCHK', name: 'Operator-specific no-value voucher', precision: 0, amount: '1' })
    await nativeTransfer(operator, holder, voucher.asset_id, 'nia')
    await nativeTransfer(holder, operator, voucher.asset_id, 'nia')
    await nativeSettled(holder, voucher.asset_id, '0')
    await nativeSettled(operator, voucher.asset_id, '1')
    const receive = await operator.owner.call<{ recipient_id: string }>('receive', { asset_id: voucher.asset_id, kind: 'nia', amount: '1', transport_endpoints: [], confirmations: 1 })
    await assert.rejects(() => holder.owner.call('prepare_send', { asset_id: voucher.asset_id, kind: 'nia', amount: '1', recipient_id: receive.recipient_id, output_sats: '1000', transport_endpoints: [], confirmations: 1, fee_rate: 2, blinding: null }), /NATIVE_REFUSED/)
  } finally { await operator.owner.close(); await holder.owner.close() }
})
