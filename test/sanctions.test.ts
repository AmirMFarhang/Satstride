// Offline sanctions screening (src/compliance/sanctions.ts) and the gate's use
// of it: a hit on a proven address or on a direct counterparty blocks the loan
// and the decision log names the list version. Also: the asset is a deployment
// choice, and loan receipts and the audit export link the decision log.

import assert from 'node:assert/strict'
import { cpSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { randomHex, randomKeyPair, type Hex } from '../src/core/crypto.js'
import { parseConfig } from '../src/core/config.js'
import { availableSanctionsScreen, bundledSanctionsScreen, DEFAULT_SANCTIONS_DIR, NoListSanctionsScreen, OfflineSanctionsScreen } from '../src/compliance/sanctions.js'
import type { GateTx } from '../src/governance/gate.js'
import { NodeGovernance } from '../src/governance/node.js'
import { demoDefaultPolicy, type GovernancePolicy } from '../src/governance/policy.js'
import { buildAuditBundle } from '../src/audit/export.js'
import { governanceLink, governanceLinkProblems } from '../src/registry/receipt.js'

const OFAC = 'bc1q05aktddf9ce4p7hh3stgsf253m4vweu7nkhtmw' // ofac-sdn-xbt snapshot, line 1 of the bech32 block
const OPENSANCTIONS = '1A7pDH1EdrkH9YZtsPnc8uzirBFnAN9Eay' // opensanctions-il_mod_crypto-btc only
const CLEAN = 'bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq' // not on either snapshot
const VERSION = 'ofac-sdn-xbt@2026-10-01+opensanctions-il_mod_crypto-btc@2026-10-17'

const transfer = (owner: Hex, amount = 600_000_000): GateTx => ({ signer: 'rgb:sanctions-unit', kind: 'rgb-transfer', recipient_owner: owner, summary: { kind: 'rgb-transfer', network: 'regtest', asset_id: 'rgb:test', amount, recipient_id: `rcpt:${randomHex(8)}`, witness: true, witness_sats: 1000, transport_endpoints: [], invoice_sha256: randomHex() } })

const required = (gatePk: Hex, ownerPk: Hex): GovernancePolicy => ({ ...demoDefaultPolicy(gatePk, ownerPk), sanctions: 'required' })

describe('the offline sanctions snapshot', () => {
  it('loads the pinned lists, names their version and finds addresses on either', async () => {
    const screen = bundledSanctionsScreen()
    assert.equal(screen.listVersion, VERSION)
    assert.deepEqual(screen.lists.map((l) => [l.list_id, l.entries]), [['ofac-sdn-xbt', 532], ['opensanctions-il_mod_crypto-btc', 52]])
    assert.equal(screen.lookup(OFAC)[0].list_id, 'ofac-sdn-xbt')
    assert.equal(screen.lookup(OFAC.toUpperCase()).length, 1, 'bech32 is case-insensitive')
    assert.equal(screen.lookup('1A7PDH1EDRKH9YZTSPNC8UZIRBFNAN9EAY').length, 0, 'base58 is not')
    assert.equal(screen.lookup(OPENSANCTIONS)[0].entry.name, 'MOHAMMED RAMADAN HASAN ABUKWAIK')
    assert.equal(screen.lookup('19D1iGzDr7FyAdiy3ZZdxMd6ttHj1kj6WW').length, 2, 'on both lists')
    const r = await screen.screen({ proven_addresses: [CLEAN], counterparties: [{ address: CLEAN, of: CLEAN }] })
    assert.equal(r.status, 'clear')
    assert.equal(r.list_version, VERSION)
  })

  it('refuses a snapshot whose bytes differ from the pinned hash', () => {
    const dir = mkdtempSync(join(tmpdir(), 'passbook-sanctions-'))
    try {
      cpSync(DEFAULT_SANCTIONS_DIR, dir, { recursive: true })
      writeFileSync(join(dir, 'ofac-sdn-xbt-20261001.txt'), `${CLEAN}\n`)
      assert.throws(() => OfflineSanctionsScreen.fromSnapshot(dir), /does not match its pinned hash/)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
})

describe('a sanctions hit blocks the loan and logs the list version', () => {
  for (const [label, subject, hop] of [
    ['a proven address', { proven_addresses: [OFAC] }, 0],
    ['a 1-hop counterparty', { proven_addresses: [CLEAN], counterparties: [{ address: OPENSANCTIONS, of: CLEAN, txid: 'ab'.repeat(32) }] }, 1],
  ] as const) {
    it(`on ${label}`, async () => {
      const borrower = randomKeyPair().pubkey
      const gov = new NodeGovernance({ ownerKey: randomKeyPair(), dir: null, sanctions: bundledSanctionsScreen(), policy: required })
      const refused = await gov.decide([transfer(borrower)], { action: 'fund', initiator: { agent: 'lender1' }, counterparty: borrower, screening: { subject_pk: borrower, ...subject } }).then(() => null, (e) => e.decision)
      assert.ok(refused && !refused.allowed, 'the fund is refused')
      assert.match(refused.reason, new RegExp(`sanctions: HIT on ${VERSION.replace(/[+.]/g, '\\$&')}`))
      const logged = gov.gate.log.entries().find((e) => e.kind === 'sanctions-result' && e.action_id === refused.action_id)!
      assert.equal(logged.result, 'hit')
      const detail = logged.detail as { list_version: string; hits: { hop: number; via?: string }[] }
      assert.equal(detail.list_version, VERSION)
      assert.equal(detail.hits[0].hop, hop)
      if (hop === 1) assert.equal(detail.hits[0].via, CLEAN)
      assert.equal(gov.gate.store.read().reservations.length, 0, 'nothing reserved, nothing signed')
    })
  }

  it('lets a clear borrower through, logging the clear result; and refuses when required and nothing was screened', async () => {
    const borrower = randomKeyPair().pubkey
    const gov = new NodeGovernance({ ownerKey: randomKeyPair(), dir: null, sanctions: bundledSanctionsScreen(), policy: required })
    const ok = await gov.decide([transfer(borrower)], { action: 'fund', initiator: { agent: 'lender1' }, counterparty: borrower, screening: { proven_addresses: [CLEAN] } })
    assert.ok(ok.allowed)
    assert.equal(gov.gate.log.entries().find((e) => e.kind === 'sanctions-result' && e.action_id === ok.action_id)!.result, 'clear')
    await assert.rejects(gov.decide([transfer(borrower)], { action: 'fund', initiator: { agent: 'lender1' }, counterparty: borrower }), /policy requires screening and the request carries no addresses/)
  })
})

describe('without a list, nothing is called clear', () => {
  it('reports NOT SCREENED: allowed when the policy screens when provided, refused when it requires screening', async () => {
    const borrower = randomKeyPair().pubkey
    const subject = { screening: { proven_addresses: [OFAC] } }
    const lax = new NodeGovernance({ ownerKey: randomKeyPair(), dir: null, sanctions: new NoListSanctionsScreen('snapshot missing') })
    const ok = await lax.decide([transfer(borrower)], { action: 'fund', initiator: { agent: 'lender1' }, counterparty: borrower, ...subject })
    assert.match(ok.gate_checks.find((c) => c.check === 'sanctions')!.detail, /^NOT SCREENED: not screened: snapshot missing/)
    const strict = new NodeGovernance({ ownerKey: randomKeyPair(), dir: null, sanctions: new NoListSanctionsScreen(), policy: required })
    await assert.rejects(strict.decide([transfer(borrower)], { action: 'fund', initiator: { agent: 'lender1' }, counterparty: borrower, ...subject }), /NOT SCREENED.*the policy requires screening/)
    assert.equal(availableSanctionsScreen().listVersion, VERSION, 'the bundled snapshot loads in this checkout')
  })
})

describe('asset by jurisdiction', () => {
  const base = (asset: string) => `scorer:\n  provider: in-process\n  min_trust_for_lenders: dev-inprocess\n  approved_builds: x.json\nsettlement:\n  default: cosign-rgb\n  enabled: [cosign-rgb]\nnegotiation:\n  enabled: true\n  max_rounds: 3\ncompliance:\n  identity: none\n  sanctions: none\n  consent_receipts: required\n  approvals: { maker_checker_above_usdt: 5000 }\n  data_retention_days: 0\nasset:\n  id_from: infra/state.json\n${asset}`
  it('is chosen per deployment; the demo default is test USDT', () => {
    const demo = parseConfig(base(''), { checkFiles: false })
    assert.deepEqual({ ...demo.asset, id_from: undefined }, { id_from: undefined, ticker: 'USDT', label: 'test USDT', precision: 6, jurisdiction: 'regtest-demo' })
    const eu = parseConfig(base("  ticker: EURC\n  label: 'EURC (MiCA EMT)'\n  precision: 6\n  jurisdiction: eu\n"), { checkFiles: false })
    assert.equal(eu.asset.ticker, 'EURC')
    assert.equal(eu.asset.jurisdiction, 'eu')
    assert.throws(() => parseConfig(base('  ticker: usdt\n'), { checkFiles: false }), /asset.ticker/)
    assert.throws(() => parseConfig(base('  issuer: tether\n'), { checkFiles: false }), /asset.issuer/)
  })
})

describe('receipts and the audit export link the decision log', () => {
  it('names every entry about the loan, and a tampered log fails both', async () => {
    const borrower = randomKeyPair().pubkey
    const gov = new NodeGovernance({ ownerKey: randomKeyPair(), dir: null, sanctions: bundledSanctionsScreen() })
    const loanId = randomHex(32)
    // a request without terms has no loan id; log one entry that names the loan the way a funded loan's entries do
    const d = await gov.decide([transfer(borrower)], { action: 'fund', initiator: { agent: 'lender1' }, counterparty: borrower, screening: { proven_addresses: [CLEAN] } })
    gov.gate.log.append({ kind: 'scorer-result', action_id: d.action_id, loan_id: loanId, policy_version: 1, input_hashes: {}, decided_by: { kind: 'service', id: 'external' }, result: 'QUALIFY', detail: {} })
    const log = gov.gate.log.entries()
    const link = governanceLink(log, loanId)!
    assert.equal(link.policy_version, 1)
    assert.ok(link.entries.some((e) => e.kind === 'gate-decision') && link.entries.some((e) => e.kind === 'sanctions-result') && link.entries.some((e) => e.kind === 'signature') === false)
    assert.deepEqual(governanceLinkProblems(link, log), [])
    const tampered = log.map((e, i) => (i === 1 ? { ...e, result: 'deny' } : e))
    assert.ok(governanceLinkProblems(link, tampered).length > 0)
    const audit = (over: object) => buildAuditBundle({ decision_log: log, ...over }, { blocksPerMonth: 30, maxRounds: 3, deploymentMakerCheckerMicro: 0 }).checks.find((c) => c.id === 'decision-log')!
    assert.match(audit({}).detail, /no node key to verify the log against/, 'a log with no key from outside it is not verified')
    assert.match(audit({ decision_log_node_pk: randomKeyPair().pubkey }).detail, /written by another node key/)
    const bundle = buildAuditBundle({ decision_log: log, decision_log_node_pk: gov.gate.pubkey }, { blocksPerMonth: 30, maxRounds: 3, deploymentMakerCheckerMicro: 0 })
    assert.deepEqual(bundle.checks.find((c) => c.id === 'decision-log'), { id: 'decision-log', ok: false, detail: 'no decision-log entry about this loan' }, 'without a term sheet there is no loan id to link, and the export says so')
  })
})
