// Add-on 4 Part B: one policy gate for every money-moving or rule-changing
// action, enforced at the signing layer (what you see is what you sign),
// signed versioned policies, the kill switch, the hash-chained decision log and
// `passbook why`. Each test below fails on the code before this change.

import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it } from 'node:test'
import { generateMnemonic } from '@scure/bip39'
import { wordlist } from '@scure/bip39/wordlists/english.js'
import { bytesToHex, hexToBytes, keyPairFromSecret, randomHex, randomKeyPair, sha256Hex, signObject, type Hex, type KeyPair } from '../src/core/crypto.js'
import { termsHash, type LoanTerms } from '../src/core/terms.js'
import { buildEscrowSpend, escrowFor, finalizeEscrowSpend, keyPathOutput, keyPathSigner, leafSigner, partiesOf, psbtSummary, releaseOutputs, signLeaf, verifyLeafSignature } from '../src/escrow/escrow.js'
import { appendMessage, negotiationId, type NegotiationMessage } from '../src/market/negotiate.js'
import { Oracle } from '../src/oracle/oracle.js'
import { Agent } from '../src/agents/agent.js'
import { L2_POLICY, LenderAgent } from '../src/agents/lender.js'
import type { PlatformClient } from '../src/agents/platform-client.js'
import type { BitcoindChain } from '../src/chain/bitcoind.js'
import { RuleReasoner } from '../src/ai/rule-reasoner.js'
import type { Relay } from '../src/agents/relay.js'
import type { Party } from '../src/wallet/party.js'
import { authorizeSignature, enrollSigner, keySignerId, partyKeyFromSeed, SigningRefused, summaryHash } from '../src/wallet/signer.js'
import { approveSigning, PolicyGate, type GateTx } from '../src/governance/gate.js'
import { FileDecisionLog, MemoryDecisionLog, readLog, verifyLog } from '../src/governance/log.js'
import { NodeGovernance, gateKeyFor } from '../src/governance/node.js'
import { approvePolicy, classifyChange, demoDefaultPolicy, type GateRule, type GovernancePolicy } from '../src/governance/policy.js'
import { AgentStopped } from '../src/governance/sessions.js'
import { FileGateStore, MemoryGateStore } from '../src/governance/store.js'
import { whyLines } from '../src/governance/why.js'
import { runGovernanceCli } from '../src/governance/cli.js'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const tmp = (name: string) => mkdtempSync(join(tmpdir(), `passbook-gov-${name}-`))

function loanTerms(b: KeyPair, l: KeyPair, p: KeyPair, v: 1 | 2 = 2): { terms: LoanTerms; preimage: Hex } {
  const preimage = randomHex(32)
  const terms: LoanTerms = {
    v, borrower_pk: b.pubkey, lender_pk: l.pubkey, platform_pk: p.pubkey, asset_id: 'rgb:governance-unit', principal: 600_000_000, fee: 6_000_000, collateral_sats: 1_212_000,
    oracle_quote: new Oracle(p, 10_000_000).quote(100), open_height: 100, maturity_height: 130, grace_blocks: 5, recovery_height: 155, ladder_step: 0, ltv_bps: 5000, prev_passbook_txid: null, nonce: randomHex(32),
    ...(v === 2 ? { atomic_repayment: { invoice: 'lnbcrt-unit', btc_amount_msat: 3_000_000 as const, payment_hash: sha256Hex(hexToBytes(preimage)), expires_at: 2_000_000_000, payee_pubkey: '02'.padEnd(66, '1') } } : {}),
  }
  return { terms, preimage }
}

const escrowOut = (t: LoanTerms) => ({ txid: randomHex(32), vout: 0, value: t.collateral_sats })

function rgbTx(signer: string, amount: number, owner?: Hex, assetId = 'rgb:governance-unit'): GateTx {
  return { signer, kind: 'rgb-transfer', ...(owner ? { recipient_owner: owner } : {}), summary: { kind: 'rgb-transfer', network: 'regtest', asset_id: assetId, amount, recipient_id: `rcpt:${randomHex(8)}`, witness: true, witness_sats: 1000, transport_endpoints: [], invoice_sha256: randomHex() } }
}

function rule(over: Partial<GateRule> & Pick<GateRule, 'id' | 'actions'>): GateRule {
  return { description: over.id, initiators: { kinds: ['agent'] }, networks: ['regtest'], ...over }
}

const withRules = (rules: GateRule[], extra: Partial<GovernancePolicy> = {}) => (gatePk: Hex, ownerPk: Hex): GovernancePolicy => ({ ...demoDefaultPolicy(gatePk, ownerPk), rules, ...extra })

describe('what you see is what you sign: the signing layer', () => {
  it('refuses a call without a gate token bound to the decoded transaction hash', async () => {
    const [B, L, P, forger] = [randomKeyPair(), randomKeyPair(), randomKeyPair(), randomKeyPair()]
    const { terms } = loanTerms(B, L, P)
    const parties = partiesOf(terms)
    const gov = new NodeGovernance({ ownerKey: L, dir: null })
    const out = escrowOut(terms)
    const psbt = buildEscrowSpend({ escrow: out, parties, leaf: 'A', outputs: releaseOutputs(terms) })
    const code = (c: string) => (e: unknown) => e instanceof SigningRefused && e.code === c

    assert.throws(() => signLeaf(psbt, parties, 'A', L.secretKey), code('NO_GATE_TOKEN'))
    assert.throws(() => leafSigner(L.secretKey), /governed by a policy gate/, 'no raw signer for a governed key')
    assert.throws(() => keyPathSigner(L.secretKey), /governed by a policy gate/)

    // a real token for a different decoded transaction does not sign this one
    const other = buildEscrowSpend({ escrow: out, parties, leaf: 'A', outputs: releaseOutputs(terms, 600) })
    const ctx = { action: 'release' as const, initiator: { agent: 'lender1' }, terms, counterparty: B.pubkey }
    const forOther = await gov.decide([{ signer: keySignerId(L.pubkey), kind: 'bitcoin-psbt', summary: psbtSummary(other, { parties, leaf: 'A' }) }], ctx)
    assert.throws(() => signLeaf(psbt, parties, 'A', L.secretKey, forOther.tokens[0]), code('DECODED_HASH_MISMATCH'))

    // a token minted by anyone but this key's gate is refused
    const mine = summaryHash(psbtSummary(psbt, { parties, leaf: 'A' }))
    const { sig: _sig, ...unsigned } = forOther.tokens[0]
    assert.throws(() => signLeaf(psbt, parties, 'A', L.secretKey, signObject({ ...unsigned, decoded_hash: mine }, forger.secretKey)), code('TOKEN_SIGNATURE'))
    assert.throws(() => signLeaf(psbt, parties, 'A', L.secretKey, signObject({ ...unsigned, decoded_hash: mine, gate_pk: forger.pubkey }, forger.secretKey)), code('TOKEN_SIGNATURE'))

    // through the gate it signs exactly once
    const decision = await gov.decide([{ signer: keySignerId(L.pubkey), kind: 'bitcoin-psbt', summary: psbtSummary(psbt, { parties, leaf: 'A' }) }], ctx)
    signLeaf(psbt, parties, 'A', L.secretKey, decision.tokens[0])
    assert.ok(verifyLeafSignature(psbt, parties, 'A', 'lender'))
    assert.throws(() => signLeaf(psbt, parties, 'A', L.secretKey, decision.tokens[0]), code('TOKEN_REUSED'))
    const kinds = gov.gate.log.entries().map((e) => `${e.kind}:${e.result}`)
    assert.ok(kinds.includes('signature:signed') && kinds.includes('gate-decision:would-allow') && kinds.includes('gate-decision:allow'), 'dry run first, then the decision, then the signature, all logged')

    // the RGB send path checks the same way (rgb/wallet.ts send calls authorizeSignature with its decoded transfer)
    const wallet = `rgb:${randomHex(16)}`
    enrollSigner(wallet, gov.gate.pubkey)
    const transfer = rgbTx(wallet, 1_000, B.pubkey)
    assert.throws(() => authorizeSignature(wallet, transfer.summary, undefined), code('NO_GATE_TOKEN'))
    const sent = await gov.decide([transfer], { action: 'fund', initiator: { agent: 'lender1' }, counterparty: B.pubkey })
    assert.throws(() => authorizeSignature(wallet, { ...transfer.summary, amount: 1_001 }, sent.tokens[0]), code('DECODED_HASH_MISMATCH'))
    authorizeSignature(wallet, transfer.summary, sent.tokens[0])
    assert.throws(() => enrollSigner(wallet, forger.pubkey), /another gate/, 'enrolment cannot move to another gate')
  })

  it('refuses a PSBT that differs from the approved summary, and approvals sign that summary', async () => {
    const [B, L, P] = [randomKeyPair(), randomKeyPair(), randomKeyPair()]
    const { terms } = loanTerms(B, L, P)
    const parties = partiesOf(terms)
    const gov = new NodeGovernance({ ownerKey: L, dir: null })
    const out = escrowOut(terms)
    const approved = buildEscrowSpend({ escrow: out, parties, leaf: 'A', outputs: releaseOutputs(terms) })
    const tx = (p: typeof approved): GateTx => ({ signer: keySignerId(L.pubkey), kind: 'bitcoin-psbt', summary: psbtSummary(p, { parties, leaf: 'A' }) })
    // the owner acting by hand needs their own approval of these decoded transactions (rule owner-any)
    const human = { action: 'release' as const, initiator: { human: L }, terms, counterparty: B.pubkey }
    await assert.rejects(gov.decide([tx(approved)], human), /approvals: 0 distinct listed approver/)
    const decision = await gov.decide([tx(approved)], { ...human, approvals: async (txs) => [approveSigning(L, txs)] })
    assert.equal(decision.allowed_by, 'owner-any')

    const redirected = buildEscrowSpend({ escrow: out, parties, leaf: 'A', outputs: [{ script: keyPathOutput(randomKeyPair().pubkey).script, value: terms.collateral_sats - 500 }] })
    const relocked = buildEscrowSpend({ escrow: out, parties, leaf: 'A', outputs: releaseOutputs(terms), locktime: 999 })
    const otherLeaf = buildEscrowSpend({ escrow: out, parties, leaf: 'B', outputs: releaseOutputs(terms) })
    for (const p of [redirected, relocked]) assert.throws(() => signLeaf(p, parties, 'A', L.secretKey, decision.tokens[0]), (e: unknown) => e instanceof SigningRefused && e.code === 'DECODED_HASH_MISMATCH')
    assert.throws(() => signLeaf(otherLeaf, parties, 'B', L.secretKey, decision.tokens[0]), (e: unknown) => e instanceof SigningRefused && e.code === 'DECODED_HASH_MISMATCH')
    // an approval of a different transaction does not count
    await assert.rejects(gov.decide([tx(relocked)], { ...human, approvals: [approveSigning(L, [tx(approved)])] }), /approvals: 0 distinct/)
    signLeaf(approved, parties, 'A', L.secretKey, decision.tokens[0])
    assert.ok(verifyLeafSignature(approved, parties, 'A', 'lender'))
  })

  it('no other code path in src/ reaches a transaction signer', () => {
    const files = spawnSync('git', ['ls-files', 'src'], { cwd: ROOT, encoding: 'utf8' }).stdout.split('\n').filter((f) => f.endsWith('.ts'))
    const offenders = (re: RegExp, allowed: string[]) => files.filter((f) => !allowed.includes(f) && re.test(readFileSync(join(ROOT, f), 'utf8')))
    assert.deepEqual(offenders(/signTaprootInput\(/, ['src/escrow/escrow.ts']), [])
    assert.deepEqual(offenders(/\.signPsbt\(/, ['src/rgb/wallet.ts']), [])
    assert.deepEqual(offenders(/import \{[^}]*\bsign(Leaf|KeyPath)\b[^}]*\} from '[./]+escrow\/escrow\.js'/s, ['src/governance/node.ts']), [], 'only the node governance signs escrow transactions')
    // the wallet panel's own wallet: its policy gate decides on the confirmed preview before this send (GovernedSendGate); signer-level enrolment of the panel is designed
    assert.deepEqual(offenders(/\brgb\.send\(\{/, ['src/rgb/lightning-liquidity.ts', 'src/wallet/income.ts', 'src/wallet/panel.ts']), [], 'agents send RGB through sendRgb (the gate)')
  })
})

describe('cumulative limits', () => {
  it('hold under 20 concurrent requests in one process: exactly the allowed total passes', async () => {
    const dir = tmp('cap')
    try {
      const amount = 100_000_000
      const gov = new NodeGovernance({ ownerKey: randomKeyPair(), dir, policy: withRules([rule({ id: 'fund-capped', actions: ['fund'], limits: { per_day: 10 * amount, per_counterparty_per_day: 10 * amount } })]) })
      const borrower = randomKeyPair().pubkey
      const decisions = await Promise.all(Array.from({ length: 20 }, () => gov.request([rgbTx('rgb:cap', amount)], { action: 'fund', initiator: { agent: 'lender1' }, counterparty: borrower }).then((r) => gov.gate.authorize(r))))
      assert.equal(decisions.filter((d) => d.allowed).length, 10)
      for (const d of decisions.filter((x) => !x.allowed)) assert.match(d.reason, /daily-limit/)
      const held = new FileGateStore(dir).read().reservations.filter((r) => r.status !== 'released')
      assert.equal(held.reduce((n, r) => n + r.amount, 0), 10 * amount)
      // a request that was never signed gives its reservation back; the budget opens again by exactly that much
      gov.gate.settle(decisions.find((d) => d.allowed)!.action_id, 'not-signed')
      const again = await gov.gate.authorize(await gov.request([rgbTx('rgb:cap', amount)], { action: 'fund', initiator: { agent: 'lender1' }, counterparty: borrower }))
      assert.ok(again.allowed)
      assert.ok(!(await gov.gate.authorize(await gov.request([rgbTx('rgb:cap', amount)], { action: 'fund', initiator: { agent: 'lender1' }, counterparty: borrower }))).allowed)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it('hold across processes sharing one node store: two processes x 10 concurrent requests, 10 pass', async () => {
    const dir = tmp('cap-procs')
    try {
      const owner = randomKeyPair()
      const amount = 50_000_000
      // install the policy once; the children find it in the store
      new NodeGovernance({ ownerKey: owner, dir, policy: withRules([rule({ id: 'fund-capped', actions: ['fund'], limits: { per_day: 10 * amount } })]) })
      const child = join(dir, 'child.mts')
      writeFileSync(child, `
import { NodeGovernance } from ${JSON.stringify(join(ROOT, 'src/governance/node.ts'))}
import { keyPairFromSecret, randomHex } from ${JSON.stringify(join(ROOT, 'src/core/crypto.ts'))}
const gov = new NodeGovernance({ ownerKey: keyPairFromSecret(process.env.OWNER!), dir: process.env.DIR! })
const tx = () => ({ signer: 'rgb:cap', kind: 'rgb-transfer' as const, summary: { kind: 'rgb-transfer' as const, network: 'regtest' as const, asset_id: 'rgb:x', amount: ${amount}, recipient_id: randomHex(8), witness: true, witness_sats: 1000, transport_endpoints: [], invoice_sha256: randomHex() } })
const out = await Promise.all(Array.from({ length: 10 }, async () => (await gov.gate.authorize(await gov.request([tx()], { action: 'fund', initiator: { agent: 'lender1' } }))).allowed))
console.log(JSON.stringify(out.filter(Boolean).length))
`)
      const run = () => new Promise<number>((done, fail) => {
        const p = spawn(process.execPath, ['--import', 'tsx', child], { cwd: ROOT, env: { ...process.env, OWNER: bytesToHex(owner.secretKey), DIR: dir }, stdio: ['ignore', 'pipe', 'inherit'] })
        let text = ''
        p.stdout.on('data', (b) => { text += b })
        p.on('exit', (c) => (c === 0 ? done(Number(text.trim().split('\n').at(-1))) : fail(new Error(`child exited ${c}`))))
      })
      const [a, b] = await Promise.all([run(), run()])
      assert.equal(a + b, 10, `processes allowed ${a} + ${b}`)
      assert.equal(new FileGateStore(dir).read().reservations.reduce((n, r) => n + r.amount, 0), 10 * amount)
      assert.deepEqual(verifyLog(readLog(join(dir, 'decision-log.jsonl'))), [], 'both processes appended to one intact chain')
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
})

describe('limits, store integrity and spent tokens survive change and restarts', () => {
  it('a limit added by a new policy version counts what was already moved today (the demo scenario)', async () => {
    const owner = randomKeyPair()
    const gov = new NodeGovernance({ ownerKey: owner, dir: null })
    const borrower = randomKeyPair().pubkey
    const fund = (amount: number) => gov.decide([rgbTx('rgb:limit', amount, borrower)], { action: 'fund', initiator: { agent: 'lender2' }, counterparty: borrower })
    assert.ok((await fund(600)).allowed, 'the default policy has no limit')
    const current = gov.gate.activePolicy()!
    const money = current.policy.rules.find((r) => r.id === 'agent-loan-money')!
    const next = { ...current.policy, version: 2, prev_hash: current.policy_hash, rules: [...current.policy.rules.filter((r) => r.id !== money.id), { ...money, actions: money.actions.filter((x) => x !== 'fund') }, { ...money, id: 'agent-fund-daily', actions: ['fund' as const], limits: { per_day: 900 } }] }
    assert.equal(gov.gate.changePolicy(next, [approvePolicy(owner, next)]).record!.change, 'tighten')
    const refused = await fund(600).then(() => null, (e) => e.decision)
    assert.ok(refused, 'the second 600 the same day is over 900')
    assert.match(refused.reason, /daily-limit: 600 used today \+ 600 = 1200 of 900/)
    assert.ok((await fund(300)).allowed, 'up to the limit is fine')
  })

  it('a hand-edited store allows nothing', async () => {
    const dir = tmp('tamper')
    try {
      const owner = randomKeyPair()
      const gov = new NodeGovernance({ ownerKey: owner, dir, policy: withRules([rule({ id: 'fund-capped', actions: ['fund'], limits: { per_day: 1_000 } })]) })
      const file = join(dir, 'gate-store.json')
      const state = JSON.parse(readFileSync(file, 'utf8'))
      state.policies[0].policy.rules[0].limits.per_day = 1_000_000_000
      writeFileSync(file, JSON.stringify(state))
      const d = await gov.decide([rgbTx('rgb:t', 5_000, owner.pubkey)], { action: 'fund', initiator: { agent: 'lender1' } }).then(() => null, (e) => e.decision)
      assert.ok(d && !d.allowed)
      assert.match(d.reason, /policy: version 1 does not verify: policy hash does not match/)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it('a token stays spent after a restart (another process, same node store)', async () => {
    const dir = tmp('spent')
    try {
      const owner = randomKeyPair()
      const gov = new NodeGovernance({ ownerKey: owner, dir })
      const borrower = randomKeyPair().pubkey
      const tx = rgbTx(`rgb:${randomHex(8)}`, 1_000, borrower)
      enrollSigner(tx.signer, gov.gate.pubkey)
      const d = await gov.decide([tx], { action: 'fund', initiator: { agent: 'lender1' }, counterparty: borrower })
      authorizeSignature(tx.signer, tx.summary, d.tokens[0])
      const child = join(dir, 'reuse.mts')
      writeFileSync(child, `
import { NodeGovernance } from ${JSON.stringify(join(ROOT, 'src/governance/node.ts'))}
import { keyPairFromSecret } from ${JSON.stringify(join(ROOT, 'src/core/crypto.ts'))}
import { authorizeSignature, enrollSigner } from ${JSON.stringify(join(ROOT, 'src/wallet/signer.ts'))}
const input = JSON.parse(process.env.INPUT!)
const gov = new NodeGovernance({ ownerKey: keyPairFromSecret(process.env.OWNER!), dir: process.env.DIR! })
enrollSigner(input.signer, gov.gate.pubkey)
try { authorizeSignature(input.signer, input.summary, input.token); console.log('SIGNED') } catch (e) { console.log((e as { code?: string }).code ?? String(e)) }
`)
      const out = spawnSync(process.execPath, ['--import', 'tsx', child], { cwd: ROOT, encoding: 'utf8', env: { ...process.env, OWNER: bytesToHex(owner.secretKey), DIR: dir, INPUT: JSON.stringify({ signer: tx.signer, summary: tx.summary, token: d.tokens[0] }) } })
      assert.equal(out.stdout.trim(), 'TOKEN_REUSED', out.stderr)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
})

describe('review fixes: every action counts, commit after signing, no outbound path after a stop, log bound to the node key', () => {
  it('two concurrent fund actions on the same loan both count toward the limit; an identical transaction in flight gets no second token', async () => {
    const [B, L, P] = [randomKeyPair(), randomKeyPair(), randomKeyPair()]
    const { terms } = loanTerms(B, L, P, 1)
    const gov = new NodeGovernance({ ownerKey: L, dir: null, policy: withRules([rule({ id: 'fund-capped', actions: ['fund'], limits: { per_day: 900 } })]) })
    const ctx = { action: 'fund' as const, initiator: { agent: 'lender1' }, terms, counterparty: B.pubkey }
    const both = await Promise.all([600, 600].map(async (amount) => gov.gate.authorize(await gov.request([rgbTx('rgb:same-loan', amount, B.pubkey)], ctx))))
    assert.deepEqual(both.map((d) => d.allowed).sort(), [false, true], 'one 600 fits under 900; the second same-loan action counts in full')
    assert.match(both.find((d) => !d.allowed)!.reason, /daily-limit: 600 used today \+ 600 = 1200 of 900/)
    assert.deepEqual(gov.gate.store.read().reservations.map((r) => r.amount), [600])
    const tx = rgbTx('rgb:same-loan', 100, B.pubkey)
    assert.ok((await gov.gate.authorize(await gov.request([tx], ctx))).allowed)
    const again = await gov.gate.authorize(await gov.request([tx], ctx))
    assert.ok(!again.allowed)
    assert.match(again.reason, /in-flight: the same transaction is already authorized/)
  })

  it('a signature that fails after authorisation gives the reservation back, logs the failure, and its token cannot be replayed', async () => {
    const [B, L, P] = [randomKeyPair(), randomKeyPair(), randomKeyPair()]
    const { terms } = loanTerms(B, L, P, 1)
    const parties = partiesOf(terms)
    const gov = new NodeGovernance({ ownerKey: L, dir: null, policy: withRules([rule({ id: 'release-capped', actions: ['release'], limits: { per_day: terms.collateral_sats } })]) })
    const psbt = buildEscrowSpend({ escrow: escrowOut(terms), parties, leaf: 'A', outputs: releaseOutputs(terms) })
    const tx: GateTx = { signer: keySignerId(L.pubkey), kind: 'bitcoin-psbt', summary: psbtSummary(psbt, { parties, leaf: 'A' }) }
    const ctx = { action: 'release' as const, initiator: { agent: 'lender1' }, terms, counterparty: B.pubkey }
    const d = await gov.decide([tx], ctx)
    // break the PSBT's leaf metadata without changing its decoded summary: signTaprootInput now throws
    psbt.data.inputs[0].tapLeafScript![0].script = escrowFor(parties).leaves.B.script
    assert.throws(() => signLeaf(psbt, parties, 'A', L.secretKey, d.tokens[0]), /Can not sign|no tapLeafScript|leaf/i)
    assert.equal(gov.gate.store.read().reservations[0].status, 'released', 'the allowance comes back')
    const failed = gov.gate.log.entries().find((e) => e.kind === 'signature')!
    assert.equal(failed.result, 'failed')
    assert.ok(!gov.gate.log.entries().some((e) => e.kind === 'signature' && e.result === 'signed'), 'no false signature entry')
    assert.throws(() => signLeaf(buildEscrowSpend({ escrow: { txid: tx.summary.inputs[0].txid, vout: 0, value: terms.collateral_sats }, parties, leaf: 'A', outputs: releaseOutputs(terms) }), parties, 'A', L.secretKey, d.tokens[0]), (e: unknown) => e instanceof SigningRefused && e.code === 'TOKEN_REUSED')
    // the released allowance is usable again, and a real signature commits it
    const fresh = buildEscrowSpend({ escrow: { txid: tx.summary.inputs[0].txid, vout: 0, value: terms.collateral_sats }, parties, leaf: 'A', outputs: releaseOutputs(terms) })
    await gov.signLeaf(fresh, parties, 'A', L.secretKey, ctx)
    assert.ok(verifyLeafSignature(fresh, parties, 'A', 'lender'))
    assert.deepEqual(gov.gate.store.read().reservations.map((r) => r.status), ['released', 'committed'])
  })

  it('a stopped agent cannot publish an offer or any other message', async () => {
    const L = randomKeyPair()
    const gov = new NodeGovernance({ ownerKey: L, dir: null })
    const published: unknown[] = []
    const relay = { publish: async (e: unknown) => { published.push(e); return e }, publishPublic: async (_k: number, p: unknown) => { published.push(p) }, send: async (_k: number, p: unknown) => { published.push(p) }, close() {} } as unknown as Relay
    const platform = { fees: async () => ({ blocked: false, fees: [] }), note: async () => {} } as unknown as PlatformClient
    const lender = new LenderAgent({ party: { role: 'lender1', key: L, rgb: { dataDir: '/nonexistent/rgb' } } as unknown as Party, relay, platform, chain: { getHeight: async () => 100 } as unknown as BitcoindChain, reasoner: new RuleReasoner(), policy: L2_POLICY, assetId: 'rgb:offer-unit', mine: async () => {}, governance: gov })
    await lender.publishOffer()
    assert.equal(published.length, 1)
    gov.gate.stopAgent('lender1', 'unit-test')
    await assert.rejects(lender.publishOffer(), AgentStopped)
    await assert.rejects(lender.relay.publish({} as never), AgentStopped)
    await assert.rejects(lender.relay.send(1, {}, randomKeyPair().pubkey), AgentStopped)
    assert.equal(published.length, 1, 'nothing left after the stop')
  })

  it('log verification is bound to the node key: a chain rewritten under another key fails', () => {
    const node = randomKeyPair()
    const forger = randomKeyPair()
    const real = new MemoryDecisionLog(node)
    const forged = new MemoryDecisionLog(forger)
    for (const result of ['allow', 'deny']) { real.append({ kind: 'gate-decision', action_id: 'act_x', policy_version: 1, input_hashes: {}, decided_by: { kind: 'gate' }, result, detail: {} }); forged.append({ kind: 'gate-decision', action_id: 'act_x', policy_version: 1, input_hashes: {}, decided_by: { kind: 'gate' }, result: 'allow', detail: {} }) }
    assert.deepEqual(verifyLog(real.entries(), node.pubkey), [])
    assert.match(verifyLog(forged.entries(), node.pubkey).join(), /entry 0: written by another node key/)
    const mixed = [real.entries()[0], { ...forged.entries()[1], prev_hash: real.entries()[0].hash }]
    assert.match(verifyLog(mixed).join(), /entry 1: written by another node key than entry 0/)
    assert.match(whyLines(forged.entries(), 'act_x', node.pubkey).join('\n'), /CHAIN BROKEN/)
  })

  it('passbook log verify checks each node against its own gate key', async () => {
    const wallets = tmp('logkey')
    try {
      const seed = generateMnemonic(wordlist)
      mkdirSync(join(wallets, 'lender1'), { recursive: true })
      writeFileSync(join(wallets, 'lender1', 'seed'), `${seed}\n`)
      const owner = partyKeyFromSeed(seed)
      const dir = join(wallets, 'lender1', 'governance')
      new NodeGovernance({ ownerKey: owner, dir })
      const lines: string[] = []
      assert.equal(await runGovernanceCli(['log', 'verify', '--wallets', wallets], (l) => lines.push(l)), 0)
      assert.match(lines.join(), new RegExp(`every entry signed by ${gateKeyFor(owner).pubkey.slice(0, 16)}`))
      // rewrite the whole chain under another key: the CLI fails it
      const forger = new FileDecisionLog(join(wallets, 'forged'), randomKeyPair())
      forger.append({ kind: 'policy-change', action_id: 'act_f', policy_version: 1, input_hashes: {}, decided_by: { kind: 'quorum' }, result: 'applied', detail: {} })
      writeFileSync(join(dir, 'decision-log.jsonl'), readFileSync(join(wallets, 'forged', 'decision-log.jsonl')))
      const after: string[] = []
      assert.equal(await runGovernanceCli(['log', 'verify', '--wallets', wallets, '--node', 'lender1'], (l) => after.push(l)), 1)
      assert.match(after.join(), /BROKEN: entry 0: written by another node key/)
    } finally { rmSync(wallets, { recursive: true, force: true }) }
  })
})

describe('replayed requests', () => {
  it('a signed request is decided once; a replay or a stale request gets no token', async () => {
    const gov = new NodeGovernance({ ownerKey: randomKeyPair(), dir: null })
    const borrower = randomKeyPair().pubkey
    const req = await gov.request([rgbTx('rgb:replay', 1_000, borrower)], { action: 'fund', initiator: { agent: 'lender1' }, counterparty: borrower })
    assert.ok((await gov.gate.dryRun(req)).allowed, 'a dry run does not consume the request')
    assert.ok((await gov.gate.authorize(req)).allowed)
    const replay = await gov.gate.authorize(req)
    assert.ok(!replay.allowed)
    assert.match(replay.gate_checks.find((c) => c.check === 'request')!.detail, /already decided \(replay\)/)
    assert.match(replay.gate_checks.find((c) => c.check === 'in-flight')!.detail, /already authorized .* not yet signed/, 'the identical transaction is also still awaiting its signature')
    const stale = await gov.request([rgbTx('rgb:replay', 1_000, borrower)], { action: 'fund', initiator: { agent: 'lender1' }, counterparty: borrower })
    const session = gov.session('lender1', null)
    const old = signObject({ ...stale, sig: undefined, requested_at: stale.requested_at - 3_600 }, session.key.secretKey)
    assert.match((await gov.gate.authorize(old)).reason, /outside 300 s of now/)
  })
})

describe('signed, versioned policies', () => {
  it('refuses a change without quorum; tightening applies at once, loosening waits; each loan records its version', async () => {
    let now = 1_800_000_000
    const [K1, K2, K3, outsider] = [randomKeyPair(), randomKeyPair(), randomKeyPair(), randomKeyPair()]
    const owner = randomKeyPair()
    const key = gateKeyFor(owner)
    const gate = new PolicyGate({ key, ownerPk: owner.pubkey, store: new MemoryGateStore(), log: new MemoryDecisionLog(key), now: () => now })
    const v1: GovernancePolicy = { ...demoDefaultPolicy(key.pubkey, owner.pubkey, now), rules: [rule({ id: 'fund', actions: ['fund'], limits: { per_day: 1_000 } })], quorum: { threshold: 2, keys: [K1.pubkey, K2.pubkey, K3.pubkey] }, loosen_delay_seconds: 3_600 }
    assert.throws(() => gate.install(v1, [approvePolicy(K1, v1)]), /quorum 1\/2/)
    const r1 = gate.install(v1, [approvePolicy(K1, v1), approvePolicy(K2, v1)])
    const next = (base: GovernancePolicy, perDay: number): GovernancePolicy => ({ ...base, version: base.version + 1, prev_hash: gate.policies().at(-1)!.policy_hash, rules: [rule({ id: 'fund', actions: ['fund'], limits: { per_day: perDay } })], created_at: now })

    const tighter = next(v1, 500)
    for (const approvals of [[approvePolicy(K1, tighter)], [approvePolicy(K1, tighter), approvePolicy(outsider, tighter)], [approvePolicy(K1, tighter), approvePolicy(K2, v1)]]) {
      const refused = gate.changePolicy(tighter, approvals)
      assert.equal(refused.record, null)
      assert.match(refused.problems.join(), /quorum: 1 of 2/)
    }
    assert.equal(gate.activePolicy()!.policy.version, 1)
    const applied = gate.changePolicy(tighter, [approvePolicy(K1, tighter), approvePolicy(K3, tighter)])
    assert.equal(applied.record!.change, 'tighten')
    assert.equal(gate.activePolicy()!.policy.version, 2, 'tightening applies at once')

    const looser = next(tighter, 5_000)
    const scheduled = gate.changePolicy(looser, [approvePolicy(K2, looser), approvePolicy(K3, looser)])
    assert.equal(scheduled.record!.change, 'loosen')
    assert.equal(scheduled.record!.effective_at, now + 3_600)
    assert.equal(gate.activePolicy()!.policy.version, 2, 'loosening waits')

    // a loan decided now records version 2
    const [B, L, P] = [randomKeyPair(), owner, randomKeyPair()]
    const { terms } = loanTerms(B, L, P, 1)
    const session = gate.openSession('lender1', { negotiation_id: termsHash(terms), actions: ['fund'] })
    const req = signObject({ v: 1 as const, domain: 'passbook-gate-request-v1' as const, action: 'fund' as const, initiator: { kind: 'agent' as const, agent_id: 'lender1', session: session.grant }, network: 'regtest' as const, txs: [rgbTx('rgb:v', 400)], loan: { id: termsHash(terms), terms }, counterparty: B.pubkey, requested_at: now }, session.key.secretKey)
    const d = await gate.authorize(req)
    assert.ok(d.allowed, d.reason)
    assert.equal(d.policy_version, 2)
    assert.equal(gate.store.read().loans[termsHash(terms)].policy_version, 2)
    assert.ok(!(await gate.authorize(signObject({ ...req, txs: [rgbTx('rgb:v', 600)], loan: null, requested_at: now + 1 }, session.key.secretKey))).allowed, 'version 2 caps the day at 500')

    now += 3_599
    assert.equal(gate.activePolicy()!.policy.version, 2)
    now += 2
    assert.equal(gate.activePolicy()!.policy.version, 3, 'the loosening applies after its delay')

    // adding a quorum key is a key change and waits too
    const rekey = { ...next(looser, 5_000), quorum: { threshold: 2, keys: [K1.pubkey, K2.pubkey, K3.pubkey, outsider.pubkey] } }
    const keyChange = gate.changePolicy(rekey, [approvePolicy(K1, rekey), approvePolicy(K2, rekey)])
    assert.equal(keyChange.record!.change, 'loosen')
    const logged = gate.log.entries().filter((e) => e.kind === 'policy-change')
    assert.deepEqual(logged.map((e) => e.result), ['refused', 'applied', 'refused', 'refused', 'refused', 'applied', 'scheduled', 'scheduled'])
    assert.equal((logged.at(-1)!.detail as { action: string }).action, 'key-change')
    assert.ok(r1.policy_hash)
  })
})

describe('classifying a policy change', () => {
  it('a new rule inside an existing grant tightens; a new grant loosens; widening a field loosens', () => {
    const owner = randomKeyPair().pubkey, gate = randomKeyPair().pubkey
    const v1 = demoDefaultPolicy(gate, owner)
    const money = v1.rules.find((r) => r.id === 'agent-loan-money')!
    const split = { ...v1, version: 2, rules: [...v1.rules.filter((r) => r.id !== money.id), { ...money, actions: money.actions.filter((a) => a !== 'fund') }, { ...money, id: 'agent-fund-daily', actions: ['fund' as const], assets: ['rgb:x'], limits: { per_day: 900 } }] }
    assert.equal(classifyChange(v1, split).change, 'tighten', classifyChange(v1, split).reasons.join('; '))
    const grant = { ...v1, version: 2, rules: [...v1.rules, rule({ id: 'agent-keys', actions: ['key-change'] })] }
    assert.equal(classifyChange(v1, grant).change, 'loosen')
    const wider = { ...split, version: 3, rules: split.rules.map((r) => (r.id === 'agent-fund-daily' ? { ...r, limits: { per_day: 901 } } : r)) }
    assert.deepEqual(classifyChange(split, wider), { change: 'loosen', reasons: ['rule agent-fund-daily widened: limits.per_day'] })
    const noLimit = { ...split, version: 3, rules: split.rules.map((r) => (r.id === 'agent-fund-daily' ? { ...r, limits: undefined } : r)) }
    assert.equal(classifyChange(split, noLimit).change, 'loosen', 'dropping a limit widens')
  })
})

describe('the decision log and passbook why', () => {
  it('passbook why lists every rule evaluated, its result and the approvals', async () => {
    const wallets = tmp('why')
    try {
      const dir = join(wallets, 'lender1', 'governance')
      mkdirSync(dir, { recursive: true })
      const gov = new NodeGovernance({ ownerKey: randomKeyPair(), dir, policy: withRules([
        rule({ id: 'fund-daily', description: 'the agent may fund up to 1,000 a day', actions: ['fund'], limits: { per_day: 1_000 } }),
        rule({ id: 'fund-big-with-two', description: 'above that, two approvals', initiators: { kinds: ['human'] }, actions: ['fund'], approvals: { count: 2 } }),
        rule({ id: 'release-only', actions: ['release'] }),
      ]) })
      const borrower = randomKeyPair().pubkey
      const ok = await gov.decide([rgbTx('rgb:why', 800)], { action: 'fund', initiator: { agent: 'lender1' }, counterparty: borrower })
      const denied = await gov.decide([rgbTx('rgb:why', 800)], { action: 'fund', initiator: { agent: 'lender1' }, counterparty: borrower }).catch((e) => e.decision)
      assert.ok(ok.allowed && !denied.allowed)
      const text = whyLines(gov.gate.log.entries(), denied.action_id).join('\n')
      for (const want of ['fund-daily', 'FAIL daily-limit', '800 used today + 800 = 1600 of 1000', 'fund-big-with-two: not applicable', 'release-only: not applicable', 'policy version 1', 'hash chain intact']) assert.ok(text.includes(want), `why mentions ${want}:\n${text}`)
      const lines: string[] = []
      assert.equal(await runGovernanceCli(['why', denied.action_id, '--wallets', wallets], (l) => lines.push(l)), 0)
      assert.ok(lines.join('\n').includes('FAIL daily-limit'))
      const cli = spawnSync(process.execPath, ['--import', 'tsx', 'src/cli/passbook.ts', 'why', ok.action_id, '--wallets', wallets], { cwd: ROOT, encoding: 'utf8' })
      assert.equal(cli.status, 0, cli.stderr)
      assert.match(cli.stdout, /Decision act_[0-9a-f]+: fund by agent lender1 -> ALLOW/)
      assert.match(cli.stdout, /allowed by rule fund-daily/)
    } finally { rmSync(wallets, { recursive: true, force: true }) }
  })

  it('tampering with a log entry breaks the chain', () => {
    const dir = tmp('log')
    try {
      const key = randomKeyPair()
      const log = new FileDecisionLog(dir, key)
      for (const result of ['allow', 'deny', 'allow']) log.append({ kind: 'gate-decision', action_id: `act_${randomHex(4)}`, policy_version: 1, input_hashes: {}, decided_by: { kind: 'gate' }, result, detail: { amount: 1 } })
      assert.deepEqual(verifyLog(log.entries(), key.pubkey), [])
      const file = join(dir, 'decision-log.jsonl')
      const lines = readFileSync(file, 'utf8').trim().split('\n')
      const edit = (i: number, f: (e: Record<string, unknown>) => void) => { const copy = [...lines]; const e = JSON.parse(copy[i]); f(e); copy[i] = JSON.stringify(e); return copy.map((l) => JSON.parse(l)) }
      assert.match(verifyLog(edit(1, (e) => { e.result = 'allow' })).join(), /entry 1: content does not match its hash/)
      // re-hashing without the node key leaves the signature and the next link broken
      const rehashed = edit(1, (e) => { e.result = 'allow'; const { hash: _h, sig: _s, ...body } = e; e.hash = sha256Hex(JSON.stringify(body)) })
      assert.ok(verifyLog(rehashed).some((p) => /entry 1: (node signature|content)/.test(p)))
      const dropped = lines.filter((_, i) => i !== 1).map((l) => JSON.parse(l))
      assert.match(verifyLog(dropped).join(), /entry 1: sequence 2, expected 1/)
      assert.match(verifyLog(dropped).join(), /broken link/)
      assert.match(verifyLog(log.entries(), randomKeyPair().pubkey).join(), /another node key/)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
})

describe('the kill switch', () => {
  it('stops an agent mid-negotiation, revokes its session key and refuses its next message; open loans keep E, A and D', async () => {
    const wallets = tmp('kill')
    try {
      const seed = generateMnemonic(wordlist)
      mkdirSync(join(wallets, 'lender1'), { recursive: true })
      writeFileSync(join(wallets, 'lender1', 'seed'), `${seed}\n`)
      const L = partyKeyFromSeed(seed)
      const [B, P] = [randomKeyPair(), randomKeyPair()]
      const { terms, preimage } = loanTerms(B, L, P, 2)
      const lenderGov = new NodeGovernance({ ownerKey: L, dir: join(wallets, 'lender1', 'governance') })
      const borrowerGov = new NodeGovernance({ ownerKey: B, dir: null })
      const sent: unknown[] = []
      const relay = { send: async (_k: number, payload: unknown) => { sent.push(payload) }, close() {} } as unknown as Relay
      const agent = new Agent({ party: { role: 'lender1', key: L, rgb: { dataDir: join(wallets, 'lender1', 'rgb') } } as unknown as Party, relay, reasoner: new RuleReasoner(), mine: async () => {}, governance: lenderGov })

      // mid-negotiation: the agent signs with a session-scoped signer
      const id = negotiationId(B.pubkey, randomHex(32))
      const session = lenderGov.session('lender1', id)
      const signer = lenderGov.gate.sessionSigner(L, session)
      const chain: NegotiationMessage[] = []
      await appendMessage(chain, signer, 'OFFER', { position: { apr_bps: 1200 } }, id)
      await agent.relay.send(1, { offer: 1 }, B.pubkey)
      const lines: string[] = []
      assert.equal(await runGovernanceCli(['agent', 'stop', 'lender1', '--wallets', wallets, '--by', 'unit-test'], (l) => lines.push(l)), 0)
      assert.match(lines.join(), /stopped lender1; revoked 1 session key/)

      await assert.rejects(appendMessage(chain, signer, 'COUNTER', { position: { apr_bps: 1150 } }), (e: unknown) => e instanceof AgentStopped && /SESSION_REVOKED|AGENT_STOPPED/.test((e as Error).message))
      assert.equal(chain.length, 1, 'the refused message was never signed')
      await assert.rejects(agent.relay.send(1, { offer: 2 }, B.pubkey), AgentStopped)
      assert.equal(sent.length, 1, 'its next message never left')
      assert.throws(() => lenderGov.session('lender1', termsHash(terms)), AgentStopped, 'no new session for a stopped agent')
      const parties = partiesOf(terms)
      const out = escrowOut(terms)
      const release = buildEscrowSpend({ escrow: out, parties, leaf: 'A', outputs: releaseOutputs(terms) })
      const stale = signObject({ v: 1 as const, domain: 'passbook-gate-request-v1' as const, action: 'release' as const, initiator: { kind: 'agent' as const, agent_id: 'lender1', session: session.grant }, network: 'regtest' as const, txs: [{ signer: keySignerId(L.pubkey), kind: 'bitcoin-psbt' as const, summary: psbtSummary(release, { parties, leaf: 'A' }) }], loan: null, counterparty: B.pubkey, requested_at: 1 }, session.key.secretKey)
      const refused = await lenderGov.gate.authorize(stale)
      assert.ok(!refused.allowed)
      assert.ok(refused.gate_checks.some((c) => c.check === 'agent-active' && !c.ok))

      // funds stay safe: the escrow still has its exits, and the people behind them can use them
      const escrow = escrowFor(parties)
      assert.ok(escrow.leaves.A && escrow.leaves.D && escrow.leaves.E)
      // E: the borrower repaid over Lightning and releases alone
      const viaE = buildEscrowSpend({ escrow: out, parties, leaf: 'E', outputs: releaseOutputs(terms) })
      await borrowerGov.signLeaf(viaE, parties, 'E', B.secretKey, { action: 'release', initiator: { agent: 'borrower' }, terms, counterparty: L.pubkey })
      finalizeEscrowSpend(viaE, parties, 'E', preimage)
      assert.equal(bytesToHex(viaE.extractTransaction().ins[0].witness[1]), preimage, 'leaf E witness carries the preimage: [sig, preimage, script, control]')
      // A: the lender's owner co-signs by hand with their own approval, although the agent is stopped
      await lenderGov.signLeaf(release, parties, 'A', L.secretKey, { action: 'release', initiator: { human: L }, terms, counterparty: B.pubkey, approvals: async (txs) => [approveSigning(L, txs)] })
      await borrowerGov.signLeaf(release, parties, 'A', B.secretKey, { action: 'release', initiator: { agent: 'borrower' }, terms, counterparty: L.pubkey })
      finalizeEscrowSpend(release, parties, 'A')
      // D: after the recovery height the borrower alone
      const viaD = buildEscrowSpend({ escrow: out, parties, leaf: 'D', outputs: releaseOutputs(terms) })
      await borrowerGov.signLeaf(viaD, parties, 'D', B.secretKey, { action: 'release', initiator: { agent: 'borrower' }, terms, counterparty: L.pubkey })
      finalizeEscrowSpend(viaD, parties, 'D')
      assert.equal(viaD.locktime, terms.recovery_height)

      const kill = readLog(join(wallets, 'lender1', 'governance', 'decision-log.jsonl')).find((e) => e.kind === 'kill-switch')!
      assert.equal(kill.decided_by.id, 'unit-test')
      assert.deepEqual((kill.detail as { revoked_sessions: string[] }).revoked_sessions, [session.grant.session_pk])
      // stopping every agent of every node
      assert.equal(await runGovernanceCli(['agent', 'stop', '--all', '--wallets', wallets], () => {}), 0)
      assert.ok(lenderGov.gate.agentStopped('any-other-agent'))
    } finally { rmSync(wallets, { recursive: true, force: true }) }
  })
})

describe('the gate key and the RGB signer id', () => {
  it('derives a stable gate key from the party key', () => {
    const owner = keyPairFromSecret(randomHex(32))
    assert.equal(gateKeyFor(owner).pubkey, gateKeyFor(keyPairFromSecret(bytesToHex(owner.secretKey))).pubkey)
    assert.notEqual(gateKeyFor(owner).pubkey, owner.pubkey)
  })
})
