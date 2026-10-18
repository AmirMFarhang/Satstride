import { toolArgumentsValid } from './run-record.js'
import { excludedIncomeMemo } from './income-tiers.js'
import { isConfirmed, type ChainClient } from '../chain/types.js'
import { hashObject, verifyHash, type Hex } from '../core/crypto.js'
import type { Bundle, HistoryRow } from './types.js'
import { TOOL_NAMES, type InvestigationContext, type InvestigationEvidence, type InvestigationTools, type PayerProfile } from './investigation-types.js'

/** Evidence is verified before the model sees it. No tool can spend or mutate state. */
export async function investigationTools(bundle: Bundle, chain: ChainClient, blocksPerMonth: number, redactedTxids = new Set<Hex>(), context: InvestigationContext = {}): Promise<{ tools: InvestigationTools; evidence: InvestigationEvidence }> {
  if (bundle.history.length > 200 || new Set(bundle.history.map((r) => r.txid)).size !== bundle.history.length) throw new Error('investigation requires at most 200 distinct history rows')
  const currentHeight = await chain.getHeight()
  const validInflows = new Set<Hex>()
  for (const item of bundle.candidate_inflows) {
    if (!verifyHash(item.payer_sig, hashObject({ txid: item.txid, amount: item.amount, borrower_pk: bundle.borrower_pk }), item.payer_pk)) continue
    const tx = await chain.getTx(item.txid)
    const row = bundle.history.find((r) => r.txid === item.txid)
    if (isConfirmed(tx) && tx.height <= currentHeight && row?.direction === 'in' && row.height === tx.height && row.amount === item.amount && row.counterparty_pk === item.payer_pk) validInflows.add(item.txid)
  }
  const trustedInflows = new Set(bundle.history.filter((r) => r.direction === 'in' && context.verifiedHistory && context.verifiedCounterparties?.has(r.counterparty_pk)).map((r) => r.txid))
  const authenticatedIncoming = bundle.history.filter((r) => r.direction === 'in' && (validInflows.has(r.txid) || trustedInflows.has(r.txid)))
  const keys = [...new Set(bundle.history.map((r) => r.counterparty_pk))]
  if (keys.length > 32) throw new Error('investigation supports at most 32 counterparties')
  const refs = new Map(bundle.history.map((r, i) => [`t${i + 1}`, r.txid]))
  const aliases = new Map(keys.map((pk, i) => [`p${i + 1}`, pk]))
  const txRef = (id: Hex) => [...refs].find(([, txid]) => txid === id)?.[0] ?? ''
  const pkRef = (id: Hex) => [...aliases].find(([, pk]) => pk === id)?.[0] ?? ''
  const resolveTxid = (ref: string) => refs.get(ref) ?? (bundle.history.some((r) => r.txid === ref) ? ref : undefined)
  const resolvePk = (ref: string) => aliases.get(ref) ?? (keys.includes(ref) ? ref : undefined)
  const profiles = new Map<Hex, PayerProfile>()
  const profile = async (pk: Hex) => {
    if (!profiles.has(pk)) profiles.set(pk, await context.payerProfile?.(pk) ?? { known_lender: false, known_borrower: false, passbook_pages: 0 })
    return profiles.get(pk)!
  }
  await Promise.all(keys.map(profile))
  const describe = (r: HistoryRow) => ({ ref: txRef(r.txid), txid_prefix: r.txid.slice(0, 12), height: r.height, month: Math.floor((currentHeight - r.height) / blocksPerMonth), direction: r.direction, amount_usdt: r.amount / 1e6, payer: pkRef(r.counterparty_pk), memo: r.memo.slice(0, 140), signed_inflow: validInflows.has(r.txid), authenticated_inflow: validInflows.has(r.txid) || trustedInflows.has(r.txid), known_lender: profiles.get(r.counterparty_pk)?.known_lender ?? false, known_disbursement: profiles.get(r.counterparty_pk)?.disbursement_txids?.includes(r.txid) ?? false })
  const evidence: InvestigationEvidence = { bundle, currentHeight, blocksPerMonth, validInflows, redactedTxids, profiles, resolveTxid, resolvePk, trustedInflows, verifiedHistory: context.verifiedHistory ?? false, verifiedCounterparties: context.verifiedCounterparties ?? new Set() }
  const tools: InvestigationTools = {
    async execute(name, args) {
      if (!(TOOL_NAMES as readonly string[]).includes(name)) throw new Error('unknown read-only investigation tool')
      if (!toolArgumentsValid(name, args)) throw new Error('invalid read-only tool arguments')
      if (name === 'list_counterparties') return keys.map((pk) => {
        const rows = bundle.history.filter((r) => r.counterparty_pk === pk)
        return { pk: pkRef(pk), own_key: bundle.own_pks.includes(pk) || pk === bundle.borrower_pk, valid_payer: rows.some((r) => validInflows.has(r.txid)), count_in: rows.filter((r) => r.direction === 'in').length, count_out: rows.filter((r) => r.direction === 'out').length, total_in_usdt: rows.filter((r) => r.direction === 'in').reduce((s, r) => s + r.amount, 0) / 1e6, total_out_usdt: rows.filter((r) => r.direction === 'out').reduce((s, r) => s + r.amount, 0) / 1e6, first_height: Math.min(...rows.map((r) => r.height)), last_height: Math.max(...rows.map((r) => r.height)) }
      })
      if (name === 'flows_with' || name === 'payer_profile') {
        const pk = resolvePk(args.pk ?? '')
        if (!pk) throw new Error('unknown counterparty reference')
        if (name === 'payer_profile') return { pk: pkRef(pk), ...(await profile(pk)) }
        return bundle.history.filter((r) => r.counterparty_pk === pk).map(describe)
      }
      if (name === 'outflows_before') {
        const txid = resolveTxid(args.txid ?? '')
        const inflow = bundle.history.find((r) => r.txid === txid && r.direction === 'in')
        if (!inflow || !Number.isInteger(args.blocks) || args.blocks! < 1 || args.blocks! > blocksPerMonth) throw new Error('provide an inflow reference and 1..one-month blocks')
        return bundle.history.filter((r) => r.direction === 'out' && r.height < inflow.height && r.height >= inflow.height - args.blocks!).map((r) => ({ ...describe(r), percent_of_inflow: Math.round(r.amount * 10000 / inflow.amount) / 100 }))
      }
      if (name === 'month_table') {
        const months = Math.max(1, bundle.lender_requirements.inflow_months)
        const payerCount = new Set(bundle.candidate_inflows.filter((r) => validInflows.has(r.txid)).map((r) => r.payer_pk)).size
        return { unsigned_income_payer_count: new Set(bundle.history.filter((r) => r.direction === 'in' && trustedInflows.has(r.txid) && !validInflows.has(r.txid) && !bundle.own_pks.includes(r.counterparty_pk) && r.counterparty_pk !== bundle.borrower_pk && !profiles.get(r.counterparty_pk)?.known_lender && !excludedIncomeMemo(r.memo)).map((r) => r.counterparty_pk)).size, distinct_authenticated_incoming_payer_count: new Set(bundle.history.filter((r) => validInflows.has(r.txid) || trustedInflows.has(r.txid)).map((r) => r.counterparty_pk)).size, history_reconciled: context.verifiedHistory ?? false, older_flows: bundle.history.filter((r) => Math.floor((currentHeight - r.height) / blocksPerMonth) >= months).map(describe), preceding_outflows_count: bundle.history.filter((r) => r.direction === 'out' && bundle.history.some((i) => i.direction === 'in' && r.height < i.height && i.height - r.height <= 5)).length, fast_following_outflows_count: bundle.history.filter((r) => r.direction === 'out' && bundle.history.some((i) => i.direction === 'in' && r.height > i.height && r.height - i.height <= 3)).length, return_to_incoming_payer_count: bundle.history.filter((r) => r.direction === 'out' && authenticatedIncoming.some((i) => i.counterparty_pk === r.counterparty_pk)).length, known_loan_income_count: authenticatedIncoming.filter((r) => profiles.get(r.counterparty_pk)?.known_lender || profiles.get(r.counterparty_pk)?.disbursement_txids?.includes(r.txid)).length, authoritative_first_seen_count: [...profiles.values()].filter((p) => p.first_seen_height !== undefined).length, payer_profiles: keys.map((pk) => ({ payer: pkRef(pk), known_lender: profiles.get(pk)?.known_lender ?? false, known_borrower: profiles.get(pk)?.known_borrower ?? false, first_seen_height: profiles.get(pk)?.first_seen_height ?? null })), redacted_memo_refs: [...redactedTxids].map(txRef), distinct_signed_incoming_payer_count: payerCount, signed_incoming_refs: bundle.history.filter((r) => validInflows.has(r.txid)).map((r) => txRef(r.txid)), distinct_signed_incoming_payers: [...new Set(bundle.candidate_inflows.filter((r) => validInflows.has(r.txid)).map((r) => pkRef(r.payer_pk)))], outgoing_rows: bundle.history.filter((r) => r.direction === 'out').length, months: Array.from({ length: months }, (_, month) => {
          const rows = bundle.history.filter((r) => Math.floor((currentHeight - r.height) / blocksPerMonth) === month)
          return { month, signed_incoming_payers: [...new Set(rows.filter((r) => validInflows.has(r.txid)).map((r) => pkRef(r.counterparty_pk)))], flows: rows.map(describe), net_usdt: rows.reduce((s, r) => s + (r.direction === 'in' ? r.amount : -r.amount), 0) / 1e6 }
        }) }
      }
      if (name === 'read_memos') {
        if (!Array.isArray(args.txids) || args.txids.length > 12) throw new Error('read at most 12 known transaction references')
        return args.txids.map((ref) => {
          const row = bundle.history.find((r) => r.txid === resolveTxid(ref))
          if (!row) throw new Error('unknown transaction reference')
          return { ref: txRef(row.txid), memo: row.memo.slice(0, 140) }
        })
      }
      throw new Error('tool not implemented')
    },
  }
  return { tools, evidence }
}
