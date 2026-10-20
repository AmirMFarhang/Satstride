// TEST-ONLY helpers for the check market: an in-memory Lightning with HODL
// semantics, a sandbox check engine on the fixture chain and a pinned release
// manifest. Nothing here is used by the CLI or the demo.

import { PlaybookReasoner } from '../src/ai/playbook-reasoner.js'
import { hexToBytes, keyPairFromLabel, randomHex, sha256Hex, type Hex, type KeyPair } from '../src/core/crypto.js'
import type { DecodedLightningInvoice } from '../src/rgb/lightning.js'
import { investigationFixture } from '../src/sandbox/investigation-fixtures.js'
import { contractHash, loadScoringContract } from '../src/scorer/contract.js'
import { SandboxScorerEngine } from '../src/scorer/providers.js'
import { signReleaseManifest } from '../src/scorer/releases.js'
import type { TrustPolicy } from '../src/scorer/verify.js'
import { SandboxCheckEngine } from '../src/checknode/engine.js'
import type { LightningCheckRail, OperatorRail, PayerRail } from '../src/checknode/rail.js'

export const NOW = 1_790_000_000
export const contract = loadScoringContract()
export const CONTRACT = contractHash(contract)
export const SOURCE = 'source:' + 'ab'.repeat(32)
export const USDT = 'rgb:test-usdt'
export const release = keyPairFromLabel('check-test-release-signer')

export function trustPolicy(over: Partial<TrustPolicy> = {}): TrustPolicy {
  const releases = signReleaseManifest(release, { builds: [{ label: 'container', provider: 'container', code_measurement: SOURCE, contract_hash: CONTRACT, max_trust: 'dev-inprocess' }], issued_at: NOW })
  return { minTrust: 'dev-inprocess', releases, releaseSignerPk: release.pubkey, contract, ...over }
}

export function sandboxEngine(label = 'container scorer (FALLBACK: no external provider config on this node)', enclave?: KeyPair) {
  const f = investigationFixture('fatima')
  const engine = new SandboxScorerEngine({ provider: 'container', key: enclave ?? f.key, chain: f.chain, reasoner: new PlaybookReasoner(), blocksPerMonth: 30, oraclePk: f.oracle.pubkey, measurement: SOURCE, now: () => NOW })
  return { f, engine: new SandboxCheckEngine(engine, { label, fallback: true, modelHash: null }) }
}

interface Inv { asset_id: string; amount: number; hodl: boolean; preimage: Hex | null; status: 'Open' | 'Claimable' | 'Succeeded' | 'Cancelled'; payee: string; paid?: { asset_id: string; amount: number } }

/** TEST-ONLY Lightning: HODL invoices are held until claimed with the preimage, as on a real node. */
export class MemoryLightning {
  readonly invoices = new Map<Hex, Inv>()
  operatorRail(kind: LightningCheckRail, payee = 'payee'): OperatorRail {
    const ln = this
    return {
      kind,
      async invoice(o) {
        const preimage = kind === 'rgb-ln-hodl' ? null : randomHex(32)
        const payment_hash = kind === 'rgb-ln-hodl' ? o.key_hash : sha256Hex(hexToBytes(preimage!))
        ln.invoices.set(payment_hash, { asset_id: o.asset_id, amount: o.amount, hodl: kind === 'rgb-ln-hodl', preimage, status: 'Open', payee })
        return { invoice: `lnbcrt-test-${payment_hash}`, payment_hash }
      },
      async waitPaid(hash, timeoutMs, expect) {
        const deadline = Date.now() + timeoutMs
        for (;;) {
          const inv = ln.invoices.get(hash)
          if (inv?.paid && ['Claimable', 'Succeeded'].includes(inv.status) && (inv.paid.asset_id !== expect.asset_id || inv.paid.amount !== expect.amount)) { inv.status = 'Cancelled'; throw new Error('RECEIVE_REFUSED') }
          if (inv?.status === 'Claimable') return 'held'
          if (inv?.status === 'Succeeded') return 'settled'
          if (inv?.status === 'Cancelled') throw new Error('check payment cancelled')
          if (Date.now() >= deadline) throw new Error('timed out waiting for the check payment')
          await new Promise((r) => setTimeout(r, 5))
        }
      },
      async claim(hash, preimage) {
        const inv = ln.invoices.get(hash)
        if (!inv || inv.status !== 'Claimable' || sha256Hex(hexToBytes(preimage)) !== hash) throw new Error('cannot claim')
        inv.preimage = preimage
        inv.status = 'Succeeded'
      },
      async cancel(hash) {
        const inv = ln.invoices.get(hash)
        if (inv && inv.status !== 'Succeeded') inv.status = 'Cancelled'
      },
    }
  }
  /** `tamper` pays another asset or amount than the invoice asks, to exercise the receive checks. */
  payerRail(tamper?: { asset_id: string; amount: number }): PayerRail {
    const ln = this
    return {
      async decode(invoice): Promise<DecodedLightningInvoice> {
        const hash = invoice.replace('lnbcrt-test-', '')
        const inv = ln.invoices.get(hash)
        if (!inv) throw new Error('unknown invoice')
        return { amt_msat: 3_000_000, payment_hash: hash, payee_pubkey: '02' + 'aa'.repeat(32), asset_id: inv.asset_id, asset_amount: inv.amount, timestamp: Math.floor(Date.now() / 1000), expiry_sec: 900, network: 'Regtest' }
      },
      async pay(invoice, expect, timeoutMs) {
        const hash = invoice.replace('lnbcrt-test-', '')
        const inv = ln.invoices.get(hash)
        if (!inv || inv.asset_id !== expect.asset_id || inv.amount !== expect.amount || hash !== expect.payment_hash) throw new Error('not the committed payment')
        inv.paid = tamper ?? { asset_id: inv.asset_id, amount: inv.amount }
        inv.status = inv.hodl ? 'Claimable' : 'Succeeded'
        const deadline = Date.now() + timeoutMs
        for (;;) {
          const status = inv.status as Inv['status']
          if (status === 'Succeeded') return { preimage: inv.preimage }
          if (status === 'Cancelled') throw new Error('check payment failed: the operator cancelled the held HTLC')
          if (Date.now() >= deadline) throw new Error('check payment timed out')
          await new Promise((r) => setTimeout(r, 5))
        }
      },
    }
  }
}
