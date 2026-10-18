// The RGB Lightning rails against a fake HTTP node that speaks the HODL build's
// REST shapes (UTEXO rgb-lightning-node 61be1f7: `payment_hash` on /lninvoice,
// /claimhodlinvoice, /cancelhodlinvoice, `payment_type` and `Claimable`).
// TEST-ONLY: the fake settles nothing; it checks request shapes and states.
import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import { describe, it } from 'node:test'
import { hexToBytes, randomHex, sha256Hex, type Hex } from '../src/core/crypto.js'
import { RgbLightningNode } from '../src/rgb/lightning.js'
import { RlnOperatorRail, RlnPayerRail } from '../src/checknode/rail.js'
import { freshKey, keyHash } from '../src/checknode/seal.js'

interface Inv { hash: Hex; asset_id: string; asset_amount: number; amt_msat: number; hodl: boolean; preimage: Hex | null; status: string; paid?: { asset_id: string; asset_amount: number } }

function fakeHodlNodes(opts: { ignorePaymentHash?: boolean; payAsset?: { asset_id: string; asset_amount: number } } = {}) {
  const invoices = new Map<Hex, Inv>()
  const calls: string[] = []
  const serve = (role: 'payee' | 'payer') => createServer(async (req, res) => {
    let raw = ''
    for await (const c of req) raw += c
    const body = raw ? JSON.parse(raw) as Record<string, unknown> : {}
    calls.push(`${role} ${req.url}`)
    const send = (status: number, b: unknown) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(b)) }
    const inv = (h: unknown) => invoices.get(String(h))
    switch (req.url) {
      case '/lninvoice': {
        const hodl = typeof body.payment_hash === 'string' && !opts.ignorePaymentHash
        const preimage = hodl ? null : randomHex(32)
        const hash = hodl ? String(body.payment_hash) : sha256Hex(hexToBytes(preimage!))
        invoices.set(hash, { hash, asset_id: String(body.asset_id), asset_amount: Number(body.asset_amount), amt_msat: Number(body.amt_msat), hodl, preimage, status: 'Pending' })
        return send(200, { invoice: `lnbcrt1fake${hash}` })
      }
      case '/decodelninvoice': {
        const i = inv(String(body.invoice).replace('lnbcrt1fake', ''))
        return i ? send(200, { amt_msat: i.amt_msat, expiry_sec: 900, timestamp: Math.floor(Date.now() / 1000), asset_id: i.asset_id, asset_amount: i.asset_amount, payment_hash: i.hash, payment_secret: '00'.repeat(32), payee_pubkey: '02' + 'ab'.repeat(32), network: 'Regtest' }) : send(400, { error: 'bad invoice' })
      }
      case '/sendpayment': {
        const i = inv(String(body.invoice).replace('lnbcrt1fake', ''))
        if (!i) return send(400, { error: 'bad invoice' })
        i.paid = opts.payAsset ?? { asset_id: i.asset_id, asset_amount: i.asset_amount }
        i.status = i.hodl ? 'Claimable' : 'Succeeded'
        return send(200, { payment_id: i.hash, payment_hash: i.hash, payment_secret: '00'.repeat(32), status: 'Pending' })
      }
      case '/getpayment': {
        const i = inv(body.payment_hash)
        if (!i) return send(400, { error: 'PaymentNotFound' })
        const inbound = role === 'payee'
        const status = inbound ? i.status : i.status === 'Claimable' ? 'Pending' : i.status
        const asset = i.paid ?? { asset_id: i.asset_id, asset_amount: i.asset_amount }
        return send(200, { payment: { amt_msat: i.amt_msat, asset_amount: asset.asset_amount, asset_id: asset.asset_id, payment_hash: i.hash, payment_type: inbound ? (i.hodl ? 'InboundHodl' : 'InboundAutoClaim') : 'Outbound', status, created_at: 1, updated_at: 1, payee_pubkey: '02' + 'ab'.repeat(32), preimage: !inbound && status === 'Succeeded' ? i.preimage : null } })
      }
      case '/claimhodlinvoice': {
        const i = inv(body.payment_hash)
        if (!i?.hodl || i.status !== 'Claimable' || sha256Hex(hexToBytes(String(body.payment_preimage))) !== i.hash) return send(400, { error: 'InvoiceNotClaimable' })
        i.preimage = String(body.payment_preimage)
        i.status = 'Succeeded'
        return send(200, { changed: true })
      }
      case '/cancelhodlinvoice': {
        const i = inv(body.payment_hash)
        if (i) i.status = 'Cancelled'
        return send(200, {})
      }
      default: return send(404, { error: 'not found' })
    }
  })
  return { invoices, calls, payee: serve('payee'), payer: serve('payer') }
}

async function listen(s: Server): Promise<string> {
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', () => r()))
  return `http://127.0.0.1:${(s.address() as { port: number }).port}`
}

describe('RGB Lightning rails (HODL build REST shapes)', () => {
  it('locks the invoice to sha256(K), waits for the held HTLC, claims with K; the payer learns K', async () => {
    const f = fakeHodlNodes()
    const [payeeUrl, payerUrl] = [await listen(f.payee), await listen(f.payer)]
    try {
      const op = new RlnOperatorRail(new RgbLightningNode(payeeUrl), 'rgb-ln-hodl', 5)
      const payer = new RlnPayerRail(new RgbLightningNode(payerUrl), 5)
      const k = freshKey()
      const inv = await op.invoice({ asset_id: 'rgb:usdt', amount: 500_000, key_hash: keyHash(k), expiry_sec: 900 })
      assert.equal(inv.payment_hash, keyHash(k))
      const paying = payer.pay(inv.invoice, { asset_id: 'rgb:usdt', amount: 500_000, payment_hash: inv.payment_hash }, 5000)
      assert.equal(await op.waitPaid(inv.payment_hash, 5000, { asset_id: 'rgb:usdt', amount: 500_000 }), 'held')
      await op.claim(inv.payment_hash, k)
      assert.deepEqual(await paying, { preimage: k }, 'paying revealed K')
      assert.ok(f.calls.includes('payee /claimhodlinvoice'))
    } finally {
      f.payee.close(); f.payer.close()
    }
  })

  it('refuses a node that ignores payment_hash, rather than falling back silently', async () => {
    const f = fakeHodlNodes({ ignorePaymentHash: true })
    const url = await listen(f.payee)
    try {
      const op = new RlnOperatorRail(new RgbLightningNode(url), 'rgb-ln-hodl', 5)
      await assert.rejects(op.invoice({ asset_id: 'rgb:usdt', amount: 1, key_hash: keyHash(freshKey()), expiry_sec: 900 }), /HODL_UNSUPPORTED/)
    } finally {
      f.payee.close(); f.payer.close()
    }
  })

  it('cancels a held HTLC of another asset (a voucher of another operator) without revealing K', async () => {
    const f = fakeHodlNodes({ payAsset: { asset_id: 'rgb:pbchk-other', asset_amount: 1 } })
    const [payeeUrl, payerUrl] = [await listen(f.payee), await listen(f.payer)]
    try {
      const op = new RlnOperatorRail(new RgbLightningNode(payeeUrl), 'rgb-ln-hodl', 5)
      const k = freshKey()
      const inv = await op.invoice({ asset_id: 'rgb:pbchk-B', amount: 1, key_hash: keyHash(k), expiry_sec: 900 })
      await new RgbLightningNode(payerUrl).payInvoice(inv.invoice)
      await assert.rejects(op.waitPaid(inv.payment_hash, 5000, { asset_id: 'rgb:pbchk-B', amount: 1 }), /RECEIVE_REFUSED/)
      assert.equal(f.invoices.get(inv.payment_hash)?.status, 'Cancelled')
      assert.equal(f.invoices.get(inv.payment_hash)?.preimage, null, 'K never left the operator')
    } finally {
      f.payee.close(); f.payer.close()
    }
  })

  it('pay-then-deliver: a plain invoice settles and the preimage is the node\'s, not K (the fallback)', async () => {
    const f = fakeHodlNodes()
    const [payeeUrl, payerUrl] = [await listen(f.payee), await listen(f.payer)]
    try {
      const op = new RlnOperatorRail(new RgbLightningNode(payeeUrl), 'rgb-ln-pay-then-deliver', 5)
      const k = freshKey()
      const inv = await op.invoice({ asset_id: 'rgb:usdt', amount: 500_000, key_hash: keyHash(k), expiry_sec: 900 })
      assert.notEqual(inv.payment_hash, keyHash(k))
      const paid = await new RlnPayerRail(new RgbLightningNode(payerUrl), 5).pay(inv.invoice, { asset_id: 'rgb:usdt', amount: 500_000, payment_hash: inv.payment_hash }, 5000)
      assert.notEqual(paid.preimage, k)
      assert.equal(await op.waitPaid(inv.payment_hash, 5000, { asset_id: 'rgb:usdt', amount: 500_000 }), 'settled')
    } finally {
      f.payee.close(); f.payer.close()
    }
  })
})
