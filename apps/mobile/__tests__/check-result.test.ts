import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { PassbookCheckOutputs } from '../../../src/scorer/types.ts'
import { checkResultWords } from '../src/app/check-result.ts'

const checks: PassbookCheckOutputs['checks'] = ['reconcile', 'investigation', 'categorise', 'affordability', 'inflows', 'headroom', 'injection'].map((id) => ({ id, ok: true })) as PassbookCheckOutputs['checks']

test('an ESCALATE with seven passing checks explains human review without blaming the history or income', () => {
  const words = checkResultWords({ recommendation: 'ESCALATE', checks })
  assert.match(words.title, /person.*review/)
  assert.match(words.detail, /All reported checks passed/)
  assert.match(words.detail, /lender lends only on QUALIFY/)
  assert.match(words.detail, /nothing was sent and nothing was locked/)
  assert.doesNotMatch(words.title + words.detail, /not enough|could not confirm|history|affordability|income/i)
})

test('a failed affordability check does not become a history failure or a claim that all checks passed', () => {
  const words = checkResultWords({ recommendation: 'ESCALATE', checks: checks.map((check) => ({ ...check, ok: check.id !== 'affordability' })) })
  assert.match(words.detail, /person to review/)
  assert.doesNotMatch(words.detail, /All reported checks passed|history/)
})

test('missing checks never imply that checks passed, and a decline remains a decline', () => {
  assert.doesNotMatch(checkResultWords({ recommendation: 'ESCALATE', checks: [] }).detail, /All reported checks passed/)
  const decline = checkResultWords({ recommendation: 'DECLINE', checks })
  assert.match(decline.detail, /did not qualify this loan/)
  assert.doesNotMatch(decline.detail, /All reported checks passed|asks for a person/)
})
