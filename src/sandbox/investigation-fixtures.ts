// Synthetic signed evidence for deterministic tests and real-model benchmarks.
// The live demo uses the separately seeded RGB wallets, never this fake chain.
import { FakeChain } from '../chain/fake.js'
import { hashObject, keyPairFromLabel, signHash, type KeyPair } from '../core/crypto.js'
import { Oracle } from '../oracle/oracle.js'
import type { Bundle, HistoryRow } from './types.js'

export function investigationFixture(persona: 'fatima' | 'walter', options: { liveExtras?: boolean } = {}) {
  const chain = new FakeChain(280)
  const borrower = keyPairFromLabel(persona)
  const oracle = new Oracle(keyPairFromLabel('fixture-oracle'), 10_000_000)
  const history: HistoryRow[] = []
  const candidates: Bundle['candidate_inflows'] = []
  const row = (height: number, amount: number, direction: 'in' | 'out', counterparty: KeyPair, memo: string) => {
    const txid = chain.addTx([{ value: 1000, script: '00' }])
    ;(chain as unknown as { txs: Map<string, { height: number | null }> }).txs.get(txid)!.height = height
    history.push({ txid, height, amount: amount * 1e6, direction, counterparty_pk: counterparty.pubkey, memo })
    if (direction === 'in') candidates.push({ txid, height, amount: amount * 1e6, payer_pk: counterparty.pubkey, payer_sig: signHash(hashObject({ txid, amount: amount * 1e6, borrower_pk: borrower.pubkey }), counterparty.secretKey) })
    return txid
  }
  if (persona === 'fatima') {
    const amounts = [[600, 1000, 1400, 800], [1100, 700, 900, 1300], [800, 1400, 600, 1000]]
    for (let month = 0; month < 3; month++) for (let client = 0; client < 4; client++) row(200 + month * 30 + client * 2, amounts[month][client], 'in', keyPairFromLabel(`client-${client}`), `invoice ${month + 1}: design client ${client + 1}`)
  } else {
    for (const height of [200, 230, 260]) {
      row(height - 2, 2500, 'out', keyPairFromLabel('hidden-intermediary'), 'transfer')
      row(height, 2500, 'in', keyPairFromLabel('salary-W'), 'salary')
    }
  }
  // Exercise the surrounding transfers present in the real showcase, too:
  // a later channel provision is not repeated prefunding; unrelated opening
  // funds must not hide a salary payer's repeated prefunding in a mixed table.
  if (options.liveExtras) {
    if (persona === 'fatima') row(278, 650, 'out', keyPairFromLabel('lightning-channel'), 'channel provision')
    else row(195, 10_000, 'in', keyPairFromLabel('opening-funds'), 'starting wallet funds, not income')
  }
  const bundle: Bundle = {
    v: 1, borrower_pk: borrower.pubkey, own_pks: [], offer_id: `${keyPairFromLabel('fixture-lender').pubkey}:offer`,
    loan_request: { principal: 600_000_000, fee: 6_000_000, term_blocks: 30, grace_blocks: 5 },
    lender_requirements: { affordability: true, inflow_months: 3, inflow_multiple_bps: 20000, investigation: 'required' },
    balance: (persona === 'walter' ? 6000 : 1500) * 1e6, history, candidate_inflows: candidates,
    scheduled_outflows: [{ label: 'rent', every_blocks: 30, next_height: 285, amount: 900_000_000 }],
    collateral: { sats: 1_212_000, oracle_quote: oracle.quote(280), allowed_ltv_bps: 5000 },
  }
  return { chain, bundle, oracle, key: keyPairFromLabel('fixture-sandbox') }
}
