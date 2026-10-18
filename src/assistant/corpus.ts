// The help corpus the agent on call stands on: the phone app's screen map and short
// extracts of the docs (docs/SERVICE-PROVIDER.md, docs/CHECK-MARKET.md,
// docs/ESCROW.md, src/registry/ladder.ts). The thresholds are read from the code
// that enforces them, so the text cannot drift from the rules. The provider's model
// is grounded in the sections it is given; the template engine on either end
// answers from the same text. Browser-safe.

import { hashObject, type Hex } from '../core/crypto.js'
import { CURE_BLOCKS, FUND_TIMEOUT_BLOCKS, LADDER_BPS, LIQUIDATION_BPS, MARGIN_CALL_BPS } from '../registry/ladder.js'
import type { IntentId } from './protocol.js'

export interface HelpSection {
  id: string
  title: string
  /** lower-case words and phrases that point a question here */
  keywords: string[]
  text: string
  /** the navigation that fits a question answered by this section */
  intent?: IntentId
}

/** 6500 -> "65%" */
export const pctText = (bps: number): string => `${Number((bps / 100).toFixed(2))}%`
const pct = pctText
const ladder = LADDER_BPS.map(pct).join(', ')

export const HELP_CORPUS: readonly HelpSection[] = [
  {
    id: 'screens',
    title: 'Where things are',
    keywords: ['where', 'find', 'screen', 'tab', 'menu', 'navigate', 'open', 'settings', 'gear'],
    text:
      'Passbook has four tabs at the bottom. Passbook: your limit, your pages (one per loan), the Borrow button and the loan in progress. ' +
      'Market: the lenders\' offers read from the Nostr relay, ranked against your own borrowing rules. Lend: post an offer and watch your loans as a lender. ' +
      'Wallet: your bitcoin and test USDT, Receive and Send. The gear on any tab opens Settings (wallet health, your recovery words).',
    intent: 'passbook',
  },
  {
    id: 'repay',
    title: 'Repaying',
    keywords: ['repay', 'pay back', 'payback', 'pay', 'owe', 'repayment', 'how much', 'settle', 'close the loan'],
    text:
      'To repay, open the Passbook tab and tap "Pay page N" (or "If bitcoin falls" during a margin call). The Pay screen shows what you owe in test USDT: the principal plus the lender\'s interest, nothing else. ' +
      'You confirm it yourself; it can\'t be undone. Repayment is atomic: your payment and the release of your bitcoin collateral are tied together, so you never pay without getting your bitcoin back. ' +
      'The page is then stamped on time or late and your ladder moves.',
    intent: 'repay',
  },
  {
    id: 'deadlines',
    title: 'Deadlines',
    keywords: ['deadline', 'due', 'when', 'late', 'maturity', 'blocks left', 'time left', 'grace', 'expire', 'miss', 'default'],
    text:
      'Each loan has a due height (a block number, about 10 minutes per block on Bitcoin; regtest blocks come when the test chain mines them). ' +
      'Repay before it and the page is stamped on time. After the due height and the grace blocks, the lender may use the default split you signed at the start: ' +
      'the lender takes the debt\'s worth of bitcoin at the open price and you get the rest back in the same transaction. A default resets your ladder to the first step. ' +
      `If a lender locks your collateral and does not fund within ${FUND_TIMEOUT_BLOCKS} blocks, you and the platform can take it back.`,
    intent: 'passbook',
  },
  {
    id: 'ladder',
    title: 'The ladder',
    keywords: ['ladder', 'step', 'limit', 'more', 'increase', 'grow', 'borrow more', 'credit line', 'history', 'on time'],
    text:
      `Your limit is a share of your bitcoin's value that grows with your repayment history: the steps are ${ladder} loan-to-value. ` +
      'Each loan repaid on time climbs one step, a late repayment holds your step, and a default or liquidation sends you back to the first step. ' +
      'The history is checked against the chain on your phone, so no one can edit it.',
    intent: 'passbook',
  },
  {
    id: 'ltv',
    title: 'Loan-to-value and margin calls',
    keywords: ['ltv', 'loan to value', 'loan-to-value', 'collateral', 'margin', 'margin call', 'price', 'bitcoin falls', 'liquidat', 'drop', 'crash'],
    text:
      'Loan-to-value (LTV) is what you owe divided by what your locked bitcoin is worth at the oracle\'s signed price. ' +
      `If bitcoin falls and the LTV reaches ${pct(MARGIN_CALL_BPS)}, you get a margin call: you have ${CURE_BLOCKS} blocks to repay or add collateral. ` +
      `At ${pct(LIQUIDATION_BPS)} the lender and the platform may liquidate. The "If bitcoin falls" row on your loan shows the prices where that happens.`,
    intent: 'margin',
  },
  {
    id: 'check',
    title: 'The credit check',
    keywords: ['check', 'credit check', 'compex', 'check node', 'score', 'scoring', 'consent', 'qvac', 'fraud'],
    text:
      'Before a lender funds, a check node runs a credit check with Compex\'s Credit Desk on a local QVAC model. You choose the check node and see a consent screen first: the operator, the release it runs, the data categories and who pays. ' +
      'The lender pays for the check; you never pay and never need Lightning. Your bundle is sealed to the operator\'s key, you approve the exact Compex contract version, ' +
      'and the result comes back signed (DSSE). Your phone verifies the signature and that the result names exactly the loan you asked for.',
    intent: 'borrowing-now',
  },
  {
    id: 'outcomes',
    title: 'QUALIFY, ESCALATE and DECLINE',
    keywords: ['declined', 'decline', 'denied', 'rejected', 'refused', 'escalate', 'escalated', 'qualify', 'why not', 'why was i', 'no deal', 'not approved'],
    text:
      'A check ends QUALIFY, ESCALATE or DECLINE. Only QUALIFY is funded. ESCALATE is not a no: the check could not decide safely and stops rather than guess. ' +
      'A new wallet usually escalates because it has no history a trusted observer has proven yet. DECLINE means the checks found a reason not to lend now. ' +
      'Code decides these outcomes, never a chat model, and nobody can override them in the app. A negotiation can also end with no deal when the lender\'s terms and your rules do not meet.',
    intent: 'passbook',
  },
  {
    id: 'negotiation',
    title: 'How the phone negotiates',
    keywords: ['negotiat', 'apr', 'interest', 'rate', 'offer', 'counter', 'rules', 'policy', 'agent'],
    text:
      'Your phone\'s agent negotiates with the lender over Nostr inside the rules you signed: the amount, the term, the highest APR and the highest share of your bitcoin it may lock. ' +
      'Code picks every number and never goes past your rules; each message is signed and the transcript is shown live. You approve the term sheet yourself before anything is locked.',
    intent: 'borrow',
  },
  {
    id: 'privacy',
    title: 'Who sees my data',
    keywords: ['privacy', 'private', 'data', 'who sees', 'share', 'shared', 'tracking', 'store', 'logs', 'my information', 'personal'],
    text:
      'Your keys and recovery words never leave this phone. The lender sees your application and the check result, not your wallet. ' +
      'The check node\'s operator opens the bundle you sealed to it, only the data categories you consented to. ' +
      'This help agent gets your question, the screen you are on and your loans\' states (no keys, addresses or history); "What I shared" shows exactly that. ' +
      'The provider keeps no copy of your question: its log holds the time, the outcome and a hash.',
    intent: 'settings',
  },
  {
    id: 'keys',
    title: 'Keys and recovery words',
    keywords: ['seed', 'recovery', 'words', 'mnemonic', 'private key', 'backup', 'restore', 'lost phone'],
    text:
      'Your recovery words are the only way to restore this wallet. Write them down on paper and never type them into a chat, a website or a message, not even to this agent. ' +
      'No one from Passbook will ever ask for them. Settings shows them after you unlock the phone.',
    intent: 'settings',
  },
  {
    id: 'test-coins',
    title: 'Test coins',
    keywords: ['real', 'money', 'worth', 'test', 'regtest', 'testnet', 'usdt', 'fake', 'mainnet', 'value'],
    text:
      'Everything here runs on a test network (regtest): the bitcoin and the USDT are test coins with no value, and the badge at the top says so. ' +
      'There is no mainnet in this build.',
    intent: 'wallet',
  },
  {
    id: 'receive',
    title: 'Getting coins in',
    keywords: ['receive', 'deposit', 'address', 'top up', 'fund my wallet', 'get bitcoin', 'get usdt'],
    text: 'Open the Wallet tab and tap Receive: it shows a bitcoin address and an RGB invoice for test USDT as a QR code.',
    intent: 'receive',
  },
  {
    id: 'agent',
    title: 'What this agent can do',
    keywords: ['help', 'what can you', 'who are you', 'assistant', 'agent'],
    text:
      'I answer questions about the app and can open a screen for you. I can\'t move money, sign, approve or see your keys: those take your own tap on the screen that does it. ' +
      'Each answer says whether the provider\'s QVAC model wrote it or it is a template.',
    intent: 'passbook',
  },
]

export const CORPUS_IDS: readonly string[] = HELP_CORPUS.map((s) => s.id)
export const corpusHash = (): Hex => hashObject(HELP_CORPUS)
export const section = (id: string): HelpSection | undefined => HELP_CORPUS.find((s) => s.id === id)

/** The sections a question points to, best first (keyword hits, longer phrases weigh more). */
export function retrieve(question: string, n = 3): HelpSection[] {
  const q = ` ${question.toLowerCase().replace(/[^a-z0-9%.\- ]+/g, ' ').replace(/\s+/g, ' ')} `
  const scored = HELP_CORPUS.map((s, i) => {
    let score = 0
    for (const k of s.keywords) if (q.includes(k.includes(' ') || k.length > 5 ? k : ` ${k}`)) score += k.split(' ').length + (k.length > 6 ? 1 : 0)
    return { s, score, i }
  }).filter((x) => x.score > 0)
  scored.sort((a, b) => b.score - a.score || a.i - b.i)
  return scored.slice(0, n).map((x) => x.s)
}
