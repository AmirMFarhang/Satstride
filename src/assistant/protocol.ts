// The agent on call, passbook-assist/v1: the wire between the phone's help sheet
// and the service provider's help agent, and the rules both ends enforce.
// Browser-safe (no node: import): the phone imports this file through Metro.
//
// What the agent may do: answer in text and offer at most ONE navigation from the
// fixed allowlist below, which the phone shows as a button the person taps. It
// never moves money, never signs and never sees keys, seeds or backups: the phone
// sends only the screen it is on and the state of its loans (no free text but the
// question), a question that looks like a secret is never sent, and a request to
// move money is answered with a refusal and, at most, the screen that does it.
// Every answer carries its label: `model (QVAC <model> on the provider)` or
// `template`. There is no silent fallback: a template that stands in for the
// model says why (`fallback_reason`).
//
// Wire (kinds.ts):
//   ASK   7540 phone -> assistant, NIP-44, tags t=passbook, p=<assistant pk>, n=<ask_id>
//   REPLY 7541 assistant -> phone, NIP-44, tags t=passbook, p=<asker pk>,   n=<ask_id>, e=<ask event id>
//   INFO  38540 assistant, public, addressable (d=assistant): its key, model label and corpus hash

import { getEventHash, verifyEvent, type Event } from 'nostr-tools'
import { wordlist } from '@scure/bip39/wordlists/english.js'
import { isHex, randomHex, type Hex } from '../core/crypto.js'
import { KIND, TOPIC } from '../market/kinds.js'
import type { NegotiationSigner, NegotiationTransport, NostrEvent, NostrFilter } from '../market/negotiate-nostr.js'

export const ASSIST_DOMAIN = 'passbook-assist-v1'
export const ASSIST_KIND = { ASK: KIND.ASSIST_ASK, REPLY: KIND.ASSIST_REPLY, INFO: KIND.ASSIST_INFO } as const

/** The phone's transport and key holder: the negotiation's own interfaces, so one relay object serves all three protocols. */
export type AssistTransport = NegotiationTransport
export type AssistSigner = NegotiationSigner
export type { NostrEvent, NostrFilter }

// ---- labels ----

export const TEMPLATE_LABEL = 'template'
export const modelLabel = (model: string): string => `model (QVAC ${model} on the provider)`
const MODEL_LABEL_RE = /^model \(QVAC [A-Za-z0-9._-]{1,40} on the provider\)$/
export const isLabel = (s: unknown): s is string => s === TEMPLATE_LABEL || (typeof s === 'string' && MODEL_LABEL_RE.test(s))

// ---- where the person is ----

export const TABS = ['passbook', 'lend', 'market', 'wallet'] as const
export type TabId = (typeof TABS)[number]

/** Screen names the phone may report (apps/mobile src/ui/Main.tsx SCREENS plus the tab roots). Anything else is sent as 'unknown'. */
export const SCREENS = [
  'passbook', 'lend', 'market', 'wallet',
  'borrow-amount', 'rules', 'offers', 'borrow', 'pay', 'repayment', 'page', 'receipt', 'check-loan', 'pages', 'margin',
  'receive', 'send', 'send-btc', 'send-check', 'send-check-done', 'settings', 'health', 'words', 'lend-offer', 'lend-loan',
  'onboarding', 'unlock', 'unknown',
] as const
export type ScreenId = (typeof SCREENS)[number]

// ---- the navigation allowlist ----

/**
 * Every navigation the agent may offer. Each opens a screen; none acts. The screens that move money
 * (pay, the borrowing flow) still need the person's own tap and confirmation there. Sending money and
 * the recovery words are deliberately absent.
 */
export const INTENTS = {
  passbook: { tab: 'passbook', title: 'Open your passbook' },
  borrow: { tab: 'passbook', screen: 'borrow-amount', title: 'Start borrowing' },
  'borrowing-now': { tab: 'passbook', screen: 'borrow', needs: 'borrowing', title: 'Open the loan in progress' },
  repay: { tab: 'passbook', screen: 'pay', needs: 'repayable', title: 'Open the repay screen' },
  pages: { tab: 'passbook', screen: 'pages', title: 'Your pages' },
  page: { tab: 'passbook', screen: 'page', loan: true, title: "Open this loan's page" },
  receipt: { tab: 'passbook', screen: 'receipt', loan: true, title: 'Open the receipt' },
  'check-loan': { tab: 'passbook', screen: 'check-loan', loan: true, title: 'Check this loan' },
  margin: { tab: 'passbook', screen: 'margin', loan: true, title: 'If bitcoin falls' },
  market: { tab: 'market', title: 'Open the market' },
  lend: { tab: 'lend', title: 'Open Lend' },
  wallet: { tab: 'wallet', title: 'Open your wallet' },
  receive: { tab: 'wallet', screen: 'receive', title: 'Receive' },
  settings: { tab: 'passbook', screen: 'settings', title: 'Settings' },
  health: { tab: 'passbook', screen: 'health', title: 'Wallet health' },
} as const satisfies Record<string, { tab: TabId; screen?: ScreenId; loan?: true; needs?: 'borrowing' | 'repayable'; title: string }>

/** Loan states in which the borrowing flow screen and the repay screen have something to show. */
export const BORROWING_STATES: readonly string[] = ['negotiating', 'checking', 'check-failed', 'awaiting-terms', 'terms', 'locking', 'funding']
export const REPAYABLE_STATES: readonly string[] = ['open', 'margin-call', 'repaying']
export type IntentId = keyof typeof INTENTS
export const INTENT_IDS = Object.keys(INTENTS) as IntentId[]

export interface AssistIntent { go: IntentId; loan_id?: Hex }

/** The route the phone's navigator takes for an intent: `nav.go(r.tab, r.name, r.params)`. */
export interface AssistRoute { tab: TabId; name?: ScreenId; params?: { id: Hex } }

export function routeFor(intent: AssistIntent): AssistRoute {
  const spec = INTENTS[intent.go] as { tab: TabId; screen?: ScreenId; loan?: true }
  return { tab: spec.tab, ...(spec.screen ? { name: spec.screen } : {}), ...(spec.loan && intent.loan_id ? { params: { id: intent.loan_id } } : {}) }
}

export const intentTitle = (intent: AssistIntent): string => INTENTS[intent.go].title

const onlyKeys = (o: object, allowed: readonly string[]) => Object.keys(o).filter((k) => !allowed.includes(k))
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)

/** Why an intent may not be shown: off the allowlist, extra fields, or a loan the person did not share. Empty = allowed. */
export function intentProblems(intent: unknown, ctx: Pick<AssistContext, 'loans'> | null): string[] {
  if (!isObj(intent)) return ['INTENT_SHAPE']
  const extra = onlyKeys(intent, ['go', 'loan_id'])
  if (extra.length) return [`INTENT_FIELDS:${extra.join(',')}`]
  if (typeof intent.go !== 'string' || !(INTENT_IDS as string[]).includes(intent.go)) return ['INTENT_NOT_ALLOWED']
  const spec = INTENTS[intent.go as IntentId] as { loan?: true; needs?: 'borrowing' | 'repayable' }
  if (spec.needs) {
    const states = spec.needs === 'borrowing' ? BORROWING_STATES : REPAYABLE_STATES
    if (!ctx?.loans.some((l) => l.role === 'borrower' && states.includes(l.state))) return [`INTENT_NEEDS_${spec.needs.toUpperCase()}_LOAN`]
  }
  if (!spec.loan) return intent.loan_id === undefined ? [] : ['INTENT_LOAN_NOT_TAKEN']
  if (!isHex(intent.loan_id, 32)) return ['INTENT_LOAN_MISSING']
  if (!ctx?.loans.some((l) => l.loan_id === intent.loan_id)) return ['INTENT_LOAN_UNKNOWN']
  return []
}

// ---- what the phone shares ----

export const LOAN_STATES = [
  'negotiating', 'checking', 'awaiting-terms', 'terms', 'locking', 'funding', 'open', 'margin-call',
  'repaying', 'releasing', 'closed', 'no-deal', 'declined', 'escalated', 'check-failed', 'defaulted', 'liquidated', 'refunded', 'unknown',
] as const
export type LoanState = (typeof LOAN_STATES)[number]
export const CHECK_OUTCOMES = ['QUALIFY', 'ESCALATE', 'DECLINE'] as const
export type CheckOutcome = (typeof CHECK_OUTCOMES)[number]

/** One loan as the phone shows it: no keys, no addresses, no history rows, no counterparty. */
export interface LoanBrief {
  loan_id: Hex
  role: 'borrower' | 'lender'
  state: LoanState
  /** test USDT as the app prints it, e.g. "100.00" */
  principal?: string
  /** what repaying takes now, test USDT */
  owed?: string
  /** blocks until the repayment deadline (negative: past it) */
  blocks_left?: number
  maturity_height?: number
  grace_blocks?: number
  /** loan-to-value now, basis points */
  ltv_bps?: number
  check?: CheckOutcome
}

export interface PassbookBrief { step: number; on_time: number; late: number; defaults: number; open: number; borrowable?: string }

export interface AssistContext {
  v: 1
  app: 'passbook-mobile'
  network: 'regtest'
  tab: TabId
  screen: ScreenId
  height?: number
  passbook?: PassbookBrief
  /** at most MAX_LOANS */
  loans: LoanBrief[]
  /** the wallet is a seeded test persona (regtest test data): answers about its history say so */
  test_persona?: true
}

export const MAX_LOANS = 5
export const MAX_QUESTION = 500
export const MAX_TEXT = 1200
const AMOUNT_RE = /^\d{1,12}(\.\d{1,8})?$/
const int = (v: unknown, min = -1e9, max = 1e9): v is number => Number.isSafeInteger(v) && (v as number) >= min && (v as number) <= max
/** unix seconds */
const time = (v: unknown): v is number => int(v, 0, 1e11)

/** A strict check: exactly these fields and types, so nothing else (a key, an address, a note) can ride along. */
export function contextProblems(ctx: unknown): string[] {
  if (!isObj(ctx)) return ['CONTEXT_SHAPE']
  const p: string[] = []
  const extra = onlyKeys(ctx, ['v', 'app', 'network', 'tab', 'screen', 'height', 'passbook', 'loans', 'test_persona'])
  if (extra.length) p.push(`CONTEXT_FIELDS:${extra.join(',')}`)
  if (ctx.v !== 1 || ctx.app !== 'passbook-mobile' || ctx.network !== 'regtest') p.push('CONTEXT_HEADER')
  if (!(TABS as readonly unknown[]).includes(ctx.tab)) p.push('CONTEXT_TAB')
  if (!(SCREENS as readonly unknown[]).includes(ctx.screen)) p.push('CONTEXT_SCREEN')
  if (ctx.height !== undefined && !int(ctx.height, 0)) p.push('CONTEXT_HEIGHT')
  if (ctx.test_persona !== undefined && ctx.test_persona !== true) p.push('CONTEXT_TEST_PERSONA')
  if (ctx.passbook !== undefined) {
    const b = ctx.passbook
    if (!isObj(b) || onlyKeys(b, ['step', 'on_time', 'late', 'defaults', 'open', 'borrowable']).length || !['step', 'on_time', 'late', 'defaults', 'open'].every((k) => int(b[k], 0, 1e6)) || (b.borrowable !== undefined && !(typeof b.borrowable === 'string' && AMOUNT_RE.test(b.borrowable)))) p.push('CONTEXT_PASSBOOK')
  }
  if (!Array.isArray(ctx.loans) || ctx.loans.length > MAX_LOANS) p.push('CONTEXT_LOANS')
  else ctx.loans.forEach((l, i) => { for (const x of loanProblems(l)) p.push(`LOAN_${i}_${x}`) })
  return p
}

function loanProblems(l: unknown): string[] {
  if (!isObj(l)) return ['SHAPE']
  const p: string[] = []
  if (onlyKeys(l, ['loan_id', 'role', 'state', 'principal', 'owed', 'blocks_left', 'maturity_height', 'grace_blocks', 'ltv_bps', 'check']).length) p.push('FIELDS')
  if (!isHex(l.loan_id, 32)) p.push('ID')
  if (l.role !== 'borrower' && l.role !== 'lender') p.push('ROLE')
  if (!(LOAN_STATES as readonly unknown[]).includes(l.state)) p.push('STATE')
  for (const k of ['principal', 'owed']) if (l[k] !== undefined && !(typeof l[k] === 'string' && AMOUNT_RE.test(l[k] as string))) p.push(k.toUpperCase())
  if (l.blocks_left !== undefined && !int(l.blocks_left)) p.push('BLOCKS_LEFT')
  if (l.maturity_height !== undefined && !int(l.maturity_height, 0)) p.push('MATURITY')
  if (l.grace_blocks !== undefined && !int(l.grace_blocks, 0, 1e6)) p.push('GRACE')
  if (l.ltv_bps !== undefined && !int(l.ltv_bps, 0, 1e6)) p.push('LTV')
  if (l.check !== undefined && !(CHECK_OUTCOMES as readonly unknown[]).includes(l.check)) p.push('CHECK')
  return p
}

/** Inputs for assistContext: the app passes what it already shows; anything malformed is left out rather than sent. */
export interface AssistContextInput {
  tab: string
  screen: string
  height?: number
  passbook?: Partial<PassbookBrief> | null
  loans?: Partial<LoanBrief>[]
  /** session.borrowerState.persona is set: the wallet is a seeded test persona */
  testPersona?: boolean
}

/** The context the phone sends, built field by field from explicit values only (never a spread of app state). */
export function assistContext(input: AssistContextInput): AssistContext {
  const tab = (TABS as readonly string[]).includes(input.tab) ? (input.tab as TabId) : 'passbook'
  const screen = (SCREENS as readonly string[]).includes(input.screen) ? (input.screen as ScreenId) : 'unknown'
  const ctx: AssistContext = { v: 1, app: 'passbook-mobile', network: 'regtest', tab, screen, loans: [] }
  if (int(input.height, 0)) ctx.height = input.height
  if (input.testPersona === true) ctx.test_persona = true
  const b = input.passbook
  if (b && ['step', 'on_time', 'late', 'defaults', 'open'].every((k) => int((b as Record<string, unknown>)[k], 0, 1e6))) {
    ctx.passbook = { step: b.step!, on_time: b.on_time!, late: b.late!, defaults: b.defaults!, open: b.open! }
    if (typeof b.borrowable === 'string' && AMOUNT_RE.test(b.borrowable)) ctx.passbook.borrowable = b.borrowable
  }
  for (const l of input.loans ?? []) {
    if (ctx.loans.length >= MAX_LOANS) break
    if (!isHex(l.loan_id, 32) || (l.role !== 'borrower' && l.role !== 'lender')) continue
    const brief: LoanBrief = { loan_id: l.loan_id, role: l.role, state: (LOAN_STATES as readonly unknown[]).includes(l.state) ? l.state! : 'unknown' }
    if (typeof l.principal === 'string' && AMOUNT_RE.test(l.principal)) brief.principal = l.principal
    if (typeof l.owed === 'string' && AMOUNT_RE.test(l.owed)) brief.owed = l.owed
    if (int(l.blocks_left)) brief.blocks_left = l.blocks_left
    if (int(l.maturity_height, 0)) brief.maturity_height = l.maturity_height
    if (int(l.grace_blocks, 0, 1e6)) brief.grace_blocks = l.grace_blocks
    if (int(l.ltv_bps, 0, 1e6)) brief.ltv_bps = l.ltv_bps
    if ((CHECK_OUTCOMES as readonly unknown[]).includes(l.check)) brief.check = l.check
    ctx.loans.push(brief)
  }
  return ctx
}

// ---- guards both ends run on the question ----

const WORDS = new Set(wordlist)
const B58 = '[1-9A-HJ-NP-Za-km-z]'
const SECRET_PATTERNS: [string, RegExp][] = [
  ['EXTENDED_PRIVATE_KEY', new RegExp(`\\b[xtyzuv]prv${B58}{100,}`)],
  ['NOSTR_SECRET', /\bnsec1[02-9ac-hj-np-z]{50,}/],
  ['WIF', new RegExp(`\\b[5KLc9]${B58}{50,51}\\b`)],
  ['DESCRIPTOR_KEY', /\b(tr|wpkh|wsh|sh)\([^)]*prv/i],
]

/**
 * Whether the text looks like a secret: twelve or more recovery words in a row, an extended private
 * key, a WIF, a Nostr nsec. The phone never sends such a question; the provider drops one without logging it.
 */
export function looksSecret(text: string): string | null {
  for (const [name, re] of SECRET_PATTERNS) if (re.test(text)) return name
  let run = 0
  for (const w of text.toLowerCase().split(/[^a-z]+/)) {
    if (!w) continue
    run = WORDS.has(w) ? run + 1 : 0
    if (run >= 12) return 'RECOVERY_WORDS'
  }
  return null
}

const ACTION_VERBS = 'send|transfer|withdraw|move|pay|repay|approve|accept|sign|countersign|lock|fund|release|liquidate|sell|buy|swap|borrow|lend|cancel|confirm|post|spend|drain|sweep|export|reveal|show'
const REQUEST_LEAD = '(?:please\\s+|pls\\s+|can you\\s+|could you\\s+|would you\\s+|will you\\s+|go ahead and\\s+|i want you to\\s+|i need you to\\s+|you should\\s+|just\\s+|now\\s+|then\\s+|ok\\s+|okay\\s+)*'
const REQUEST_RE = new RegExp(`^\\s*${REQUEST_LEAD}(${ACTION_VERBS})\\b`, 'i')
const FOR_ME_RE = new RegExp(`\\b(${ACTION_VERBS})\\b[^?]*\\bfor me\\b`, 'i')
const SECRET_ASK_RE = /\b(seed|recovery|mnemonic|private key|secret key|backup|words)\b/i

/** The navigation a refused money request may still get: the screen where the person does it themselves. */
const VERB_SCREEN: Record<string, IntentId | null> = {
  send: 'wallet', transfer: 'wallet', withdraw: 'wallet', move: 'wallet', spend: 'wallet', drain: 'wallet', sweep: 'wallet',
  pay: 'repay', repay: 'repay',
  approve: 'borrowing-now', accept: 'borrowing-now', sign: 'borrowing-now', countersign: 'borrowing-now', lock: 'borrowing-now', fund: 'borrowing-now', confirm: 'borrowing-now',
  borrow: 'borrow', lend: 'lend', post: 'lend', cancel: 'borrowing-now',
  sell: 'market', buy: 'market', swap: 'market',
  release: 'pages', liquidate: 'passbook',
  export: 'settings', reveal: 'settings', show: null,
}

/**
 * A request for the agent to act (move money, sign, approve, reveal a secret) rather than a question
 * about how to: "send my BTC", "approve the loan", "can you repay it for me". `null` for a question.
 */
export function moneyAction(question: string): { verb: string; intent: AssistIntent | null; secret: boolean } | null {
  const q = question.trim()
  const m = REQUEST_RE.exec(q) ?? FOR_ME_RE.exec(q)
  if (!m) return null
  const verb = m[1].toLowerCase()
  const secret = SECRET_ASK_RE.test(q) && ['show', 'reveal', 'export', 'send'].includes(verb)
  // "show me the market" is navigation, not an action; only a secret makes `show` a refusal
  if (verb === 'show' && !secret) return null
  const go = secret ? null : VERB_SCREEN[verb]
  return { verb, intent: go ? { go } : null, secret }
}

// ---- messages ----

export interface AssistAsk {
  v: 1
  domain: typeof ASSIST_DOMAIN
  type: 'ASK'
  ask_id: Hex
  question: string
  context: AssistContext
  issued_at: number
}

export const REFUSALS = ['MONEY_ACTION', 'SECRET', 'RATE_LIMITED'] as const
export type Refusal = (typeof REFUSALS)[number]
/** Why a template answered instead of the model. Shown to the person; never silent. */
export const FALLBACKS = ['NO_MODEL', 'MODEL_TIMEOUT', 'MODEL_ERROR', 'MODEL_SCHEMA', 'PROVIDER_TIMEOUT', 'PROVIDER_UNREACHABLE', 'REPLY_INVALID', 'NO_ASSISTANT', 'NOT_SENT'] as const
export type Fallback = (typeof FALLBACKS)[number]

export interface AssistReply {
  v: 1
  domain: typeof ASSIST_DOMAIN
  type: 'REPLY'
  ask_id: Hex
  text: string
  intent: AssistIntent | null
  label: string
  source: 'model' | 'template'
  /** the model's name when source is model, e.g. qwen3-1.7b */
  model: string | null
  /** a refusal answers by template; it is not a fallback */
  refused: Refusal | null
  fallback_reason: Fallback | null
  /** help-corpus section ids the answer stands on */
  cites: string[]
  issued_at: number
}

export interface AssistInfo {
  v: 1
  domain: typeof ASSIST_DOMAIN
  type: 'INFO'
  assistant_pk: Hex
  /** what answers: modelLabel(model) or 'template' when the provider runs without a model */
  label: string
  corpus_hash: Hex
  network: 'regtest'
  test_data: true
  per_minute: number
  issued_at: number
}

export function askProblems(ask: unknown): string[] {
  if (!isObj(ask)) return ['ASK_SHAPE']
  const p: string[] = []
  const extra = onlyKeys(ask, ['v', 'domain', 'type', 'ask_id', 'question', 'context', 'issued_at'])
  if (extra.length) p.push(`ASK_FIELDS:${extra.join(',')}`)
  if (ask.v !== 1 || ask.domain !== ASSIST_DOMAIN || ask.type !== 'ASK') p.push('ASK_HEADER')
  if (!isHex(ask.ask_id, 32)) p.push('ASK_ID')
  if (typeof ask.question !== 'string' || !ask.question.trim() || ask.question.length > MAX_QUESTION) p.push('ASK_QUESTION')
  if (!time(ask.issued_at)) p.push('ASK_ISSUED_AT')
  p.push(...contextProblems(ask.context))
  return p
}

/** The reply's shape. The intent is checked separately against the context the phone sent (intentProblems). */
export function replyProblems(reply: unknown): string[] {
  if (!isObj(reply)) return ['REPLY_SHAPE']
  const p: string[] = []
  const extra = onlyKeys(reply, ['v', 'domain', 'type', 'ask_id', 'text', 'intent', 'label', 'source', 'model', 'refused', 'fallback_reason', 'cites', 'issued_at'])
  if (extra.length) p.push(`REPLY_FIELDS:${extra.join(',')}`)
  if (reply.v !== 1 || reply.domain !== ASSIST_DOMAIN || reply.type !== 'REPLY') p.push('REPLY_HEADER')
  if (!isHex(reply.ask_id, 32)) p.push('REPLY_ASK_ID')
  if (typeof reply.text !== 'string' || !reply.text.trim() || reply.text.length > MAX_TEXT) p.push('REPLY_TEXT')
  if (!isLabel(reply.label)) p.push('REPLY_LABEL')
  if (reply.source === 'model') {
    if (typeof reply.model !== 'string' || reply.label !== modelLabel(reply.model) || reply.fallback_reason !== null) p.push('REPLY_MODEL_LABEL')
  } else if (reply.source === 'template') {
    if (reply.label !== TEMPLATE_LABEL || reply.model !== null) p.push('REPLY_TEMPLATE_LABEL')
  } else p.push('REPLY_SOURCE')
  if (reply.refused !== null && !(REFUSALS as readonly unknown[]).includes(reply.refused)) p.push('REPLY_REFUSED')
  if (reply.fallback_reason !== null && !(FALLBACKS as readonly unknown[]).includes(reply.fallback_reason)) p.push('REPLY_FALLBACK')
  if (!Array.isArray(reply.cites) || reply.cites.length > 6 || !reply.cites.every((c) => typeof c === 'string' && /^[a-z0-9-]{1,32}$/.test(c))) p.push('REPLY_CITES')
  if (reply.intent !== null && !isObj(reply.intent)) p.push('REPLY_INTENT')
  if (!time(reply.issued_at)) p.push('REPLY_ISSUED_AT')
  return p
}

export function infoProblems(info: unknown): string[] {
  if (!isObj(info)) return ['INFO_SHAPE']
  const p: string[] = []
  if (onlyKeys(info, ['v', 'domain', 'type', 'assistant_pk', 'label', 'corpus_hash', 'network', 'test_data', 'per_minute', 'issued_at']).length) p.push('INFO_FIELDS')
  if (info.v !== 1 || info.domain !== ASSIST_DOMAIN || info.type !== 'INFO' || info.network !== 'regtest' || info.test_data !== true) p.push('INFO_HEADER')
  if (!isHex(info.assistant_pk, 32) || !isHex(info.corpus_hash, 32)) p.push('INFO_KEYS')
  if (!isLabel(info.label)) p.push('INFO_LABEL')
  if (!int(info.per_minute, 1, 1000) || !time(info.issued_at)) p.push('INFO_NUMBERS')
  return p
}

export function newAsk(question: string, context: AssistContext, nowMs = Date.now()): AssistAsk {
  return { v: 1, domain: ASSIST_DOMAIN, type: 'ASK', ask_id: randomHex(32), question: question.trim().slice(0, MAX_QUESTION), context, issued_at: Math.floor(nowMs / 1000) }
}

// ---- events ----

/**
 * On a public network every event says it is test data (lane D4's rule, the same text as its testLabel in
 * src/agents/relay.ts): ['network', <network>] and ['alt', …]. Empty when no public network is set.
 */
export const testLabel = (network: string): string => `Passbook test data: test USDT on ${network}, no value. Not real USDT.`
export function testDataTags(network: string | undefined | null): string[][] {
  if (!network) return []
  if (!/^[a-z0-9-]{1,32}$/.test(network)) throw new Error(`public network name ${JSON.stringify(network)} is not a plain name`)
  return [['network', network], ['alt', testLabel(network)]]
}

const tagOf = (e: { tags: string[][] }, name: string) => e.tags.find((t) => t[0] === name)?.[1]
const wireCopy = (e: NostrEvent): Event => ({ id: e.id, pubkey: e.pubkey, created_at: e.created_at, kind: e.kind, tags: e.tags.map((t) => [...t]), content: e.content, sig: e.sig })
export const authentic = (e: NostrEvent): boolean => { try { return verifyEvent(wireCopy(e)) } catch { return false } }

async function signed(signer: AssistSigner, template: { kind: number; created_at: number; tags: string[][]; content: string }): Promise<NostrEvent> {
  if (signer.signEvent) return signer.signEvent(template)
  const unsigned = { ...template, pubkey: signer.pubkey }
  const id = getEventHash(unsigned)
  return { ...unsigned, id, sig: await signer.signHash(id) }
}

/** A NIP-44 message of this protocol to `to`, tagged with the ask id. */
export async function assistEvent(signer: AssistSigner, kind: number, payload: AssistAsk | AssistReply, to: Hex, extraTags: string[][] = [], nowMs = Date.now()): Promise<NostrEvent> {
  const content = await signer.nip44Encrypt(to, JSON.stringify(payload))
  return signed(signer, { kind, created_at: Math.floor(nowMs / 1000), tags: [['t', TOPIC], ['p', to], ['n', payload.ask_id], ...extraTags], content })
}

/**
 * How long an INFO stands: three of the service's 10-minute republishes. It carries a NIP-40 expiration, and the
 * phone ignores an older one, so a provider that stopped is not shown as online from a stale announcement.
 */
export const INFO_TTL_SEC = 1800

export async function infoEvent(signer: AssistSigner, info: AssistInfo, nowMs = Date.now(), extraTags: string[][] = []): Promise<NostrEvent> {
  const at = Math.floor(nowMs / 1000)
  return signed(signer, { kind: ASSIST_KIND.INFO, created_at: at, tags: [['t', TOPIC], ['d', 'assistant'], ['expiration', String(at + INFO_TTL_SEC)], ...extraTags], content: JSON.stringify(info) })
}

/** Open a message of this protocol addressed to the signer: authentic, the right kind, to me, decrypted and parsed. Throws a code. */
export async function openAssistEvent(signer: AssistSigner, event: NostrEvent, kind: number): Promise<unknown> {
  if (event.kind !== kind) throw new Error('KIND')
  if (!authentic(event)) throw new Error('SIGNATURE')
  if (tagOf(event, 'p') !== signer.pubkey) throw new Error('NOT_FOR_ME')
  let text: string
  try { text = await signer.nip44Decrypt(event.pubkey, event.content) } catch { throw new Error('DECRYPT') }
  try { return JSON.parse(text) } catch { throw new Error('JSON') }
}

/** A current, valid INFO: authentic, by the key it names, and neither expired (NIP-40) nor older than INFO_TTL_SEC. */
export function readInfo(event: NostrEvent, nowMs = Date.now()): AssistInfo | null {
  if (event.kind !== ASSIST_KIND.INFO || !authentic(event)) return null
  const now = Math.floor(nowMs / 1000)
  const expires = Number(tagOf(event, 'expiration') ?? Infinity)
  if (!(expires > now)) return null
  try {
    const info = JSON.parse(event.content) as AssistInfo
    if (infoProblems(info).length || info.assistant_pk !== event.pubkey) return null
    return now - info.issued_at > INFO_TTL_SEC ? null : info
  } catch { return null }
}

export { tagOf }
