import { detectFanInBurst, detectPassThrough } from './typologies.js'
import type { Hex } from '../core/crypto.js'
import { FINDING_TYPES, type ConfirmedFinding, type ConfirmedInvestigation, type InvestigationEvidence } from './investigation-types.js'

const PREFUND_BLOCKS = 5
const near = (a: number, b: number) => Math.abs(a - b) * 10000 <= b * 500
const median = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[middle] : Math.floor((sorted[middle - 1] + sorted[middle]) / 2)
}

/** Only verified evidence, never model-provided quantities, determines these effects. */
export function confirmRows(report: { findings: { type: typeof FINDING_TYPES[number]; txids: string[] }[] }, evidence: InvestigationEvidence): ConfirmedInvestigation {
  const { bundle, currentHeight, blocksPerMonth, validInflows, profiles } = evidence
  const findings: ConfirmedFinding[] = []
  const excludedPayers = new Set<Hex>()
  let hallucinations = 0
  let rejected = 0
  let irregularIncomeMedian: number | undefined
  const own = new Set([bundle.borrower_pk, ...bundle.own_pks])
  const candidates = [...bundle.candidate_inflows, ...bundle.history.filter((r) => r.direction === 'in' && evidence.trustedInflows.has(r.txid) && !bundle.candidate_inflows.some((c) => c.txid === r.txid)).map((r) => ({ ...r, payer_pk: r.counterparty_pk, payer_sig: '' }))]
  const verified = candidates.filter((r) => (validInflows.has(r.txid) || evidence.trustedInflows.has(r.txid)) && !own.has(r.payer_pk))
  const loops = (payer: Hex) => {
    const incoming = verified.filter((r) => r.payer_pk === payer)
    const lo = Math.min(...incoming.map((r) => r.height))
    const hi = Math.max(...incoming.map((r) => r.height)) + blocksPerMonth
    const sum = incoming.reduce((n, r) => n + r.amount, 0)
    const back = bundle.history.filter((r) => r.direction === 'out' && r.counterparty_pk === payer && r.height >= lo && r.height <= hi).reduce((n, r) => n + r.amount, 0)
    return sum > 0 && back * 10000 >= sum * 5000
  }
  for (const proposed of report.findings.slice(0, 12)) {
    const resolved = proposed.txids.map((ref) => evidence.resolveTxid(ref))
    if (resolved.some((ref) => ref === undefined)) { hallucinations += resolved.filter((ref) => ref === undefined).length; continue }
    const ids = [...new Set(resolved as Hex[])]
    if (!ids.length || !(FINDING_TYPES as readonly string[]).includes(proposed.type)) { rejected++; continue }
    const cited = verified.filter((r) => ids.includes(r.txid))
    let payers = [...new Set(cited.map((r) => r.payer_pk))]
    let confirmed = false
    if (proposed.type === 'prefunded_inflow') {
      // A model may cite the suspicious outgoing leg. Resolve its matching
      // signed incoming leg before checking the repeated pattern in code.
      const citedOut = bundle.history.filter((r) => ids.includes(r.txid) && r.direction === 'out' && !own.has(r.counterparty_pk))
      payers = [...new Set([...payers, ...verified.filter((inflow) => citedOut.some((out) => out.counterparty_pk !== inflow.payer_pk && out.height < inflow.height && out.height >= inflow.height - PREFUND_BLOCKS && near(out.amount, inflow.amount))).map((r) => r.payer_pk)])]
      payers = payers.filter((payer) => {
        const months = new Set<number>()
        for (const inflow of verified.filter((r) => r.payer_pk === payer)) {
          const before = bundle.history.find((r) => r.direction === 'out' && !own.has(r.counterparty_pk) && r.counterparty_pk !== inflow.payer_pk && r.height < inflow.height && r.height >= inflow.height - PREFUND_BLOCKS && near(r.amount, inflow.amount))
          if (before) months.add(Math.floor((currentHeight - inflow.height) / blocksPerMonth))
        }
        return months.size >= 2
      })
      confirmed = payers.length > 0
    } else if (proposed.type === 'circular_flow') {
      // A second hop outside this consolidated wallet history is not evidence.
      if (!payers.length) payers = [...new Set(bundle.history.filter((r) => ids.includes(r.txid) && r.direction === 'out' && verified.some((incoming) => incoming.payer_pk === r.counterparty_pk)).map((r) => r.counterparty_pk))]
      payers = payers.filter(loops)
      confirmed = payers.length > 0
    } else if (proposed.type === 'income_is_loan') {
      confirmed = cited.length > 0 && cited.every((r) => profiles.get(r.payer_pk)?.known_lender || profiles.get(r.payer_pk)?.disbursement_txids?.includes(r.txid))
    } else if (proposed.type === 'new_payer') {
      confirmed = payers.length === 1 && (() => {
        const first = profiles.get(payers[0])?.first_seen_height
        const inflow = Math.min(...verified.filter((r) => r.payer_pk === payers[0]).map((r) => r.height))
        // Unknown global first-seen information cannot confirm a new identity.
        return first !== undefined && first <= inflow && inflow - first < blocksPerMonth
      })()
    } else if (proposed.type === 'irregular_genuine') {
      const months = Math.max(1, bundle.lender_requirements.inflow_months)
      // The finding proposes wallet-wide freelancer context. Code recomputes
      // the full independent payer cohort rather than trusting an LLM to list
      // every member of that cohort correctly.
      const eligible = verified.filter((r) => !loops(r.payer_pk) && !profiles.get(r.payer_pk)?.known_lender && !excludedPayers.has(r.payer_pk))
      payers = [...new Set(eligible.map((r) => r.payer_pk))]
      const sums = Array<number>(months).fill(0)
      for (const row of eligible) {
        const month = Math.floor((currentHeight - row.height) / blocksPerMonth)
        if (month >= 0 && month < months) sums[month] += row.amount
      }
      confirmed = cited.length > 0 && cited.every((r) => eligible.some((e) => e.txid === r.txid)) && payers.length >= 3 && sums.every((n) => n > 0)
      if (confirmed) irregularIncomeMedian = median(sums)
    } else if (proposed.type === 'fan_in_burst' || proposed.type === 'pass_through') {
      const result = (proposed.type === 'fan_in_burst' ? detectFanInBurst : detectPassThrough)(bundle, { currentHeight, blocksPerMonth })
      confirmed = result.matched && result.txids.every((id) => ids.includes(id))
      payers = result.payers
    } else if (proposed.type === 'injection_attempt') {
      confirmed = ids.every((id) => evidence.redactedTxids.has(id))
    }
    if (!confirmed) { rejected++; continue }
    if (['prefunded_inflow', 'circular_flow', 'income_is_loan', 'fan_in_burst', 'pass_through'].includes(proposed.type)) for (const pk of payers) excludedPayers.add(pk)
    if (!findings.some((f) => f.type === proposed.type && f.payers.join() === payers.join())) findings.push({ type: proposed.type, txids: ids, payers })
  }
  // Exclusions win regardless of the model's order of proposals.
  if (excludedPayers.size && findings.some((f) => f.type === 'irregular_genuine' && f.payers.some((pk) => excludedPayers.has(pk)))) {
    irregularIncomeMedian = undefined
    const at = findings.findIndex((f) => f.type === 'irregular_genuine')
    findings.splice(at, 1)
    rejected++
  }
  return { findings, hallucinations, rejected, excludedPayers, irregularIncomeMedian }
}

/** Notes cannot smuggle private identifiers or exact money out of the sandbox. */
export function safeLenderNote(note: string, findings: ConfirmedFinding[]): string {
  const withoutBands = note.replace(/about\s+(\d[\d,]*)\s*[–-]\s*(\d[\d,]*)\s*USDT\s*(?:a|per)\s*month/gi, (match, low: string, high: string) => {
    const lo = Number(low.replaceAll(',', '')), hi = Number(high.replaceAll(',', ''))
    return lo % 1000 === 0 && hi % 1000 === 0 && hi > lo ? '' : match
  })
  const unsafe = !note.trim() || /^(unknown|n\/a|none|not sure)$/i.test(note.trim()) || note.length > 400 || /[a-f0-9]{12,}|\b[tp]\d+\b|txid|pubkey|(?:bc1|tb1|bcrt1)[a-z0-9]{20,}/i.test(note) || /\d|USDT|BTC|sats|\$|€|dollars|euros|hundred|thousand|million|billion/i.test(withoutBands)
  if (!unsafe) return note
  return templatedLenderNote(findings)
}

export function templatedLenderNote(findings: ConfirmedFinding[]): string {
  if (findings.some((f) => f.type === 'prefunded_inflow' || f.type === 'circular_flow')) return 'Repeated funding loops were confirmed. These payments were excluded from income.'
  if (findings.some((f) => f.type === 'irregular_genuine')) return 'Income from several independent payers was confirmed across every required month.'
  return 'The investigation finished. Only code-confirmed findings affect this application.'
}
