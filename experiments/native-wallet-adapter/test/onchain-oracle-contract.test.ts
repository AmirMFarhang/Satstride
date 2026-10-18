import assert from 'node:assert/strict'
import { test } from 'node:test'
import { validateOnchainTermsV3 } from '../src/settlement/onchain-v3-contract.js'
import { verifyQuote } from '../src/oracle/oracle.js'
import { jointTerms } from './onchain-fixtures.js'
import { liveOracle } from './oracle-venues.js'

test('joint terms accept the complete signed #60 index quote without dropping provenance', async () => {
  const t = jointTerms(), oracle = await liveOracle()
  t.oracle_quote = oracle.quote(t.open_height)
  const before = structuredClone(t.oracle_quote)
  validateOnchainTermsV3(t)
  assert.deepEqual(t.oracle_quote, before)
  assert.equal(verifyQuote(t.oracle_quote, oracle.pubkey), true)
  const injected = structuredClone(t)
  Object.assign(injected.oracle_quote.usdt_usd!.sources[0], { hidden: true })
  assert.throws(() => validateOnchainTermsV3(injected), /unknown/)
  const malformed = structuredClone(t)
  malformed.oracle_quote.sources![0].bid_cents = malformed.oracle_quote.sources![0].ask_cents! + 1
  assert.throws(() => validateOnchainTermsV3(malformed), /crossed/)
  const missing = structuredClone(t)
  delete missing.oracle_quote.usdt_usd
  assert.throws(() => validateOnchainTermsV3(missing), /full index/)
  const average = structuredClone(t)
  average.oracle_quote.averages!.fast = { window_ms: 300_000, price_cents: 10_000_000, from: 0, to: 100, samples: 1 }
  assert.throws(() => validateOnchainTermsV3(average), /time window/)
})
