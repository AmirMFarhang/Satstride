// Mainnet is read, never spent. The credit agent reads Bitcoin mainnet history
// and verifies mainnet signatures, while loans settle on the loan chain
// (regtest in the demo, signet on Mutinynet). This guard makes sure no code
// path builds or signs a mainnet transaction while the loan chain is regtest
// or signet, and that the agent never takes a mainnet key or seed: proofs only.
//
// - txNetworkProblems / assertTxNetworks: checked when the credit agent (CLI or
//   server panel) starts; it refuses to run if the escrow or the RGB wallet
//   would sign for mainnet while the loan chain is regtest or signet.
// - assertTxNetwork: for any future transaction builder (network profiles).
// - refuseSecret: anything that looks like a private key, an extended private
//   key or a seed phrase is refused before it is parsed, logged or stored.
// test/networks-guard.test.ts also scans src/ so a new transaction builder
// without an explicit network, or mainnet parameters outside the read-only
// address formatter, fails the build.

import type { ChainId } from './types.js'

export type LoanChain = 'regtest' | 'signet' | 'bitcoin'

/** The chain loans settle on: PASSBOOK_LOAN_CHAIN, else regtest (the demo). Mainnet loans are not part of this release. */
export function loanChainFromEnv(env: NodeJS.ProcessEnv = process.env): LoanChain {
  const v = env.PASSBOOK_LOAN_CHAIN ?? 'regtest'
  if (v !== 'regtest' && v !== 'signet' && v !== 'bitcoin') throw new Error(`PASSBOOK_LOAN_CHAIN must be regtest, signet or bitcoin, got ${v}`)
  return v
}

export class MainnetTransactionRefused extends Error {
  constructor(what: string, loanChain: LoanChain) {
    super(`refusing to build or sign a mainnet transaction (${what}) while the loan chain is ${loanChain}; the credit agent reads mainnet, it never spends there`)
    this.name = 'MainnetTransactionRefused'
  }
}

/** bitcoinjs network params: mainnet's bech32 prefix is 'bc'. */
export function assertTxNetwork(network: { bech32: string }, loanChain: LoanChain = loanChainFromEnv(), what = 'transaction'): void {
  if (network.bech32 === 'bc' && loanChain !== 'bitcoin') throw new MainnetTransactionRefused(what, loanChain)
}

/** Every transaction builder Passbook has today, against the loan chain. Empty when nothing would sign for mainnet. */
export function txNetworkProblems(args: { loanChain: LoanChain; escrowBech32: string; rgbNetwork: string }): string[] {
  const problems: string[] = []
  if (args.loanChain !== 'bitcoin') {
    if (args.escrowBech32 === 'bc') problems.push(`escrow transactions would use mainnet while the loan chain is ${args.loanChain}`)
    if (args.rgbNetwork === 'mainnet') problems.push(`the RGB wallet would sign for mainnet while the loan chain is ${args.loanChain}`)
  }
  return problems
}

export function assertTxNetworks(args: { loanChain: LoanChain; escrowBech32: string; rgbNetwork: string }): void {
  const p = txNetworkProblems(args)
  if (p.length) throw new MainnetTransactionRefused(p.join('; '), args.loanChain)
}

/** History chains are read-only and separate from the loan chain; any of them may be mainnet. */
export function historyChainAllowed(chain: ChainId): boolean {
  return chain === 'bitcoin' || chain === 'signet' || chain === 'regtest'
}

// Anchored: a whole field that is a key, not a substring of a long signature.
const SECRET_PATTERNS: [RegExp, string][] = [
  [/^[5KLc9][1-9A-HJ-NP-Za-km-z]{50,51}$/, 'a WIF private key'],
  [/^[xyztuv]prv[1-9A-HJ-NP-Za-km-z]{100,112}$/, 'an extended private key'],
  [/^(0x)?[0-9a-f]{64}$/i, 'a 32-byte hex secret'],
]

/** True when the text looks like 12-24 lowercase words, i.e. a seed phrase. */
function looksLikeSeedPhrase(text: string): boolean {
  const words = text.trim().split(/\s+/)
  return words.length >= 12 && words.length <= 24 && words.every((w) => /^[a-z]{3,8}$/.test(w))
}

/**
 * Refuses input that looks like a key or a seed. Used on every free-text field
 * the borrower fills in (signatures, addresses). Never echoes the input back.
 * `allowHex32` is for fields that legitimately carry a 32-byte hex value.
 */
export function refuseSecret(input: string, field: string, opts: { allowHex32?: boolean } = {}): void {
  if (looksLikeSeedPhrase(input)) throw new Error(`${field}: that looks like a seed phrase. Never paste a seed or a private key; Passbook needs only a signature.`)
  for (const [re, what] of SECRET_PATTERNS) {
    if (opts.allowHex32 && what === 'a 32-byte hex secret') continue
    if (re.test(input.trim())) throw new Error(`${field}: that looks like ${what}. Never paste a private key; Passbook needs only a signature.`)
  }
}
