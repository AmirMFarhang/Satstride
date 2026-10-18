// M7 option A (regtest test data): the phone uses a seeded test persona's history proof only as the
// platform's own observer signed it, and carries it (with the persona's seeded income records) in the
// check bundle only while it runs that persona's key and asset; a wallet of its own carries none.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mnemonicToSeedSync, validateMnemonic } from '@scure/bip39'
import { wordlist } from '@scure/bip39/wordlists/english.js'
import { keyPairFromLabel, signObject, type Hex } from '../../../src/core/crypto.ts'
import { PhoneBorrower, type PhoneAgentState } from '../src/agent/borrower.ts'
import type { PartySigner } from '../src/agent/ports.ts'
import { eligiblePersona, personaProblems, personaRecord } from '../src/app/persona.ts'

const require = createRequire(import.meta.url)
const { rootFromSeed } = require('../worklet/keys.js')
const { PartyKey } = require('../worklet/party.js')
const WORDS = 'legal winner thank year wave sausage worth useful legal winner thank yellow'
const party = new PartyKey(rootFromSeed(mnemonicToSeedSync(WORDS)))
const key = { pubkey: party.pubkey, btc: party.btcOutput(), signObject: async (v: object) => party.signObject(v), signPassbookHash: async (h: Hex) => party.signPassbookHash(h) } as unknown as PartySigner
const observer = keyPairFromLabel('m7-observer')
const ASSET = 'rgb:usdt'
const valid = (w: string) => validateMnemonic(w, wordlist)

function proof(over: Record<string, unknown> = {}, signer = observer) {
  return signObject({ v: 1, assurance: 'trusted_wallet_snapshot', observer_pk: signer.pubkey, borrower_pk: party.pubkey, asset_id: ASSET, wallet_xpubs_hash: 'aa'.repeat(32), observed_from_zero: true, first_transfer_txid: null, opening_balance: 0, current_balance: 0, height: 300, transfers: [], allocations: [], native_snapshot_hash: 'bb'.repeat(32), btc_history: { status: 'verified' }, ...over }, signer.secretKey)
}
const inflow = { txid: 'cc'.repeat(32), amount: 1_000_000_000, payer_pk: 'dd'.repeat(32), payer_sig: 'ee'.repeat(64), memo: 'salary' }
const pkg = (h: unknown, over: Record<string, unknown> = {}) => ({ v: 1, kind: 'passbook-test-persona', label: 'Seeded regtest test persona', network: 'regtest', persona: 'fatima', words: WORDS, rgb_fingerprint: 'de4ba57b', rgb_backup_b64: 'YmFja3Vw', rgb_backup_password: 'p', asset_id: ASSET, observer_pk: observer.pubkey, inflows: [inflow], history_proof: h, issued_at: 1, ...over })

test("a persona package is used only when its proof is exactly as this platform's observer signed it", () => {
  assert.deepEqual(personaProblems(pkg(proof()), observer.pubkey, valid), [])
  const other = keyPairFromLabel('m7-other-observer')
  assert.match(personaProblems(pkg(proof({}, other), { observer_pk: other.pubkey }), observer.pubkey, valid).join(), /not this platform's key|not from this platform's observer/)
  const edited = { ...proof(), current_balance: 999 }
  assert.match(personaProblems(pkg(edited), observer.pubkey, valid).join(), /signature does not verify/)
  assert.match(personaProblems(pkg(proof({ observed_from_zero: false })), observer.pubkey, valid).join(), /not observed from zero/)
  assert.match(personaProblems(pkg(proof(), { network: 'mainnet' }), observer.pubkey, valid).join(), /not a test persona package/)
  assert.match(personaProblems(pkg(proof(), { network: 'mutinynet' }), observer.pubkey, valid, 'regtest').join(), /a mutinynet test persona, and this phone runs regtest/)
  assert.match(personaProblems(pkg(proof(), { words: 'not words at all' }), observer.pubkey, valid).join(), /not a valid recovery phrase/)
})

function borrower(state: PhoneAgentState) {
  const platform = { quote: async () => ({ price_cents: 10_000_000, height: 300, oracle_pk: observer.pubkey, sig: '00' }) }
  const rgb = { transfers: async () => [], balance: async () => ({ settled: 0, future: 0, spendable: 0 }) }
  const chain = { getHeight: async () => 300, getTx: async () => null }
  return new PhoneBorrower(key, platform as never, {} as never, chain as never, rgb as never, ASSET, state)
}
const offer = { id: 'o', lender_pk: 'ff'.repeat(32), payload: { asset_id: ASSET, apr_bps: 1200, term_blocks: 30, grace_blocks: 5, requirements: { inflow_months: 3 } } } as never

test("the bundle carries the observer's proof as issued and the seeded income records only for the persona's own key", async () => {
  const h = proof()
  const persona = personaRecord(pkg(h) as never)
  const b = await borrower({ loans: {}, labels: {}, persona }).buildSandboxBundle(offer, 100_000_000)
  assert.equal(b.history_proof, h, 'the proof object travels exactly as issued')
  assert.deepEqual(b.candidate_inflows, [{ txid: inflow.txid, amount: inflow.amount, payer_pk: inflow.payer_pk, payer_sig: inflow.payer_sig }], 'the memo stays on the phone')
  // another key's proof is never carried
  const foreign = personaRecord(pkg(proof({ borrower_pk: keyPairFromLabel('someone').pubkey })) as never)
  const b2 = await borrower({ loans: {}, labels: {}, persona: foreign }).buildSandboxBundle(offer, 100_000_000)
  assert.equal(b2.history_proof, undefined)
  assert.deepEqual(b2.candidate_inflows, [])
  // a wallet of its own: no proof, no records (its check honestly escalates)
  const own = await borrower({ loans: {}, labels: {} }).buildSandboxBundle(offer, 100_000_000)
  assert.equal(own.history_proof, undefined)
  assert.deepEqual(own.candidate_inflows, [])
})

test('the bundle declares only the outflows the persona declares; no invented rent', async () => {
  const none = await borrower({ loans: {}, labels: {}, persona: personaRecord(pkg(proof()) as never) }).buildSandboxBundle(offer, 100_000_000)
  assert.deepEqual(none.scheduled_outflows, [], 'a persona without declared outflows declares none')
  const own = await borrower({ loans: {}, labels: {} }).buildSandboxBundle(offer, 100_000_000)
  assert.deepEqual(own.scheduled_outflows, [], 'nor does a wallet of its own')
  const rent = { label: 'rent', every_blocks: 30, amount: 50_000_000 }
  const withRent = await borrower({ loans: {}, labels: {}, persona: personaRecord(pkg(proof(), { declared_outflows: [rent] }) as never) }).buildSandboxBundle(offer, 100_000_000)
  assert.deepEqual(withRent.scheduled_outflows, [{ ...rent, next_height: 310 }])
  assert.deepEqual(personaProblems(pkg(proof(), { declared_outflows: [rent] }), observer.pubkey, valid), [])
  assert.match(personaProblems(pkg(proof(), { declared_outflows: [{ label: 'rent', every_blocks: 0, amount: -1 }] }), observer.pubkey, valid).join(), /declared outflows are malformed/)
})

test('declared outflows must be safe integers; the screens use the same eligibility as the bundle', () => {
  assert.match(personaProblems(pkg(proof(), { declared_outflows: [{ label: 'rent', every_blocks: 30, amount: 1e20 }] }), observer.pubkey, valid).join(), /declared outflows are malformed/)
  assert.match(personaProblems(pkg(proof(), { declared_outflows: [{ label: 'rent', every_blocks: 1e20, amount: 1 }] }), observer.pubkey, valid).join(), /declared outflows are malformed/)
  const rec = personaRecord(pkg(proof(), { declared_outflows: [{ label: 'rent', every_blocks: 30, amount: 1 }] }) as never)
  assert.equal(eligiblePersona(rec, party.pubkey, ASSET), rec)
  assert.equal(eligiblePersona(rec, keyPairFromLabel('someone').pubkey, ASSET), null, "another key's persona declares nothing")
  assert.equal(eligiblePersona(rec, party.pubkey, 'rgb:other'), null)
  assert.equal(eligiblePersona(rec, party.pubkey, undefined), null)
})
