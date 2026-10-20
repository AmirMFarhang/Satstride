// Only reported states become tasks. A recent event or a loaded model does not
// prove a check is running; terminal check records never become active work.
export function liveTasks(market, now = Date.now()) {
  if (!market) return null
  const tasks = []
  for (const loan of market.loans?.items ?? []) {
    const titles = { pending: 'Loan registered', locked: 'Collateral locked', open: 'Loan open' }
    if (!titles[loan.status]) continue
    tasks.push({ id: `loan-${loan.id}`, title: titles[loan.status], detail: loan.status === 'open' ? `Repayment due at block ${loan.maturity_height ?? 'unknown'}.` : loan.status === 'pending' ? 'Latest registry state: pending. Collateral has not been recorded here.' : 'Waiting for the next recorded loan step.', state: 'waiting', kind: 'loan', ref: loan.id, at: loan.updated_at })
  }
  for (const item of market.agenda ?? []) {
    // Open loans above already include their maturity. Other agenda entries
    // are actual platform obligations, never invented demo steps.
    if (item.kind === 'maturity') continue
    tasks.push({ id: `agenda-${item.kind}-${item.title}`, title: item.title, detail: item.detail, state: item.severity === 'alert' ? 'attention' : 'waiting', kind: 'agenda', at: item.due_at })
  }
  for (const item of market.negotiations ?? []) {
    if (!['asked', 'negotiating'].includes(item.state) || !Number.isFinite(item.last_at) || now - item.last_at > 120_000) continue
    tasks.push({ id: `neg-${item.id}`, title: 'Negotiation observed', detail: 'Recent relay messages; the private conversation and its current progress are not visible here.', state: 'observed', kind: 'negotiation', ref: item.id, at: item.last_at })
  }
  return tasks
}

export const WORKFLOW_STAGES = [
  ['negotiation', 'Negotiate'], ['consent', 'Consent'], ['check', 'Check'], ['terms', 'Terms'],
  ['collateral', 'Collateral'], ['funding', 'Fund'], ['repayment', 'Repay'], ['closed', 'Close'],
]

// These are projections of the existing signed /wire narration, not claims
// that a process is busy or a transaction has independently been verified.
const WORKFLOW_REPORTS = [
  [/^Negotiation (ended without a deal|error)/, 'negotiation', 'Negotiation stopped', true],
  [/^Credit check refused before it ran/, 'check', 'Credit check refused', true],
  [/^Term sheet not approved by the lender/, 'terms', 'Terms approval refused', true],
  [/^Collateral released(?:;| through)/, 'closed', 'Close reported'],
  [/^Approved on the phone: repay|^Repaid over RGB|^Repayment (consignment posted|settled)/, 'repayment', 'Repayment reported'],
  [/^Default split signed and handed|^Holding the borrower-signed default split|^Disbursed over RGB|^USDT received over RGB|^Approved on the phone: fund/, 'funding', 'Funding step reported'],
  [/^Approved on the phone: lock|^Collateral locked with/, 'collateral', 'Collateral step reported'],
  [/^Term sheet (ready|approved|countersigned)|^Terms checked and accepted|^Both approvals of the term sheet|^Approved on the phone: this term sheet/, 'terms', 'Terms approval reported'],
  [/^Check result opened and verified on the phone|^Credit check (billed|released|paid and opened)/, 'check', 'Credit-check result reported'],
  [/^Approved on the phone: share my sealed history/, 'consent', 'Consent approved'],
  [/^Asking for a loan$|^Negotiation (sent|received|agreed)/, 'negotiation', 'Negotiation reported'],
]

export function liveWorkflows(activity, now = Date.now()) {
  const latest = new Map()
  for (const item of [...(activity ?? [])].sort((a, b) => b.at - a.at)) {
    if (item.source !== 'platform' || item.kind !== 'agent' || !item.from || !Number.isFinite(item.at) || item.at > now + 30_000 || latest.has(item.from)) continue
    const report = WORKFLOW_REPORTS.find(([pattern]) => pattern.test(item.label ?? ''))
    if (!report) continue
    latest.set(item.from, {
      actor: item.from, role: ['borrower', 'lender'].includes(item.detail) ? item.detail : 'agent',
      stage: report[1], title: report[2], note: item.label, at: item.at, source: 'Signed agent note · platform feed',
      stale: now - item.at > 5 * 60_000,
      stopped: report[3] === true,
      detail: report[1] === 'consent'
        ? 'A consent approval was reported. Sharing and scoring approvals use the same note; the private check phase is unknown.'
        : 'The agent reported this step. Current progress after this update is unknown.',
    })
  }
  return [...latest.values()].slice(0, 6)
}

export function liveServices(overview) {
  if (!overview) return []
  const node = overview.check_nodes?.[0]
  const model = overview.scorer?.qvac
  const assistant = overview.assistant
  const relays = overview.relays ?? []
  const connected = relays.filter(r => r.connected === true).length
  return [
    { id: 'platform', name: 'Platform', status: 'Online', tone: 'ok', detail: 'This signed platform snapshot answered.' },
    { id: 'check', name: 'Credit checks', status: node?.status === 'running' ? 'Online' : node ? 'Unavailable' : 'Not configured', tone: node?.status === 'running' ? 'ok' : 'warn', detail: node?.scorer_label ?? 'No check node is reported.' },
    { id: 'scorer', name: 'Scorer', status: overview.scorer?.status === 'answering' ? 'Answering' : 'Not observed', tone: overview.scorer?.status === 'answering' ? 'ok' : 'neutral', detail: overview.scorer?.scorer_label ?? 'The configured scorer has no current status report.' },
    { id: 'model', name: 'Local model', status: model?.status === 'ready' ? 'Ready' : model?.status === 'loading' ? 'Loading' : 'Unavailable', tone: model?.status === 'ready' ? 'ok' : 'warn', detail: model?.models?.map(m => m.id).join(', ') || 'No model status reported.' },
    { id: 'relays', name: 'Nostr relays', status: `${connected} / ${relays.length} connected`, tone: connected ? 'ok' : 'warn', detail: 'Connections observed by the platform.' },
    { id: 'assistant', name: 'Help agent', status: assistant?.status === 'running' ? 'Announced' : 'Not announced', tone: assistant?.status === 'running' ? 'ok' : 'neutral', detail: assistant?.status === 'running' ? 'Its signed relay announcement has not expired.' : 'No current relay announcement is visible.' },
  ]
}
