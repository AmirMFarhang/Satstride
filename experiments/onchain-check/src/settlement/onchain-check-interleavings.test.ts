import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  enumerateOnchainCheckStates, findOnchainCheckTrace, initialOnchainCheckState,
  nextOnchainCheckStates, onchainCheckFacts, onchainCheckInvariantErrors,
  onchainCheckStateKey, replayOnchainCheckTrace,
  type OnchainCheckModelEvent, type OnchainCheckOperatorPolicy,
} from './onchain-check-interleavings.js'

const honest = { operatorPolicy: 'honest-bounded' as const }

describe('bounded on-chain check payment interleavings (analysis only)', () => {
  it('retains the shortest honest publication -> verified report -> refund counterexample', () => {
    const found = findOnchainCheckTrace((s) => s.canonicalSpend === 'refund' && s.reportVerified, honest)
    assert.ok(found)
    assert.deepEqual(found.trace, [
      'confirm-funding', 'publish-valid-claim', 'verify-report',
      'pass-claim-cutoff', 'reach-refund-height', 'confirm-refund',
    ])
    assert.equal(found.state.validClaimPublishedAt, 'claim-window', 'the operator followed its disclosure cutoff')
    assert.deepEqual(onchainCheckFacts(found.state), {
      fundingInputSpent: true, boxCreated: true, boxUnspent: false,
      canonicalRgbPayment: false, canonicalRgbRefund: true, canonicalRgbLoss: false,
      keyObserved: true, reportVerified: true,
    })
    assert.deepEqual(replayOnchainCheckTrace(found.trace, honest), found.state)
  })

  it('retains the shortest confirmed claim -> reorg -> refund counterexample', () => {
    const found = findOnchainCheckTrace((s) => s.claimReorgSeen && s.canonicalSpend === 'refund' && s.reportVerified, honest)
    assert.ok(found)
    assert.deepEqual(found.trace, [
      'confirm-funding', 'publish-valid-claim', 'verify-report', 'confirm-valid-claim',
      'reorg-claim', 'pass-claim-cutoff', 'reach-refund-height', 'confirm-refund',
    ])
    const previouslyPaid = replayOnchainCheckTrace(found.trace.slice(0, 4), honest)
    assert.equal(onchainCheckFacts(previouslyPaid).canonicalRgbPayment, true)
    assert.equal(onchainCheckFacts(found.state).canonicalRgbPayment, false)
    assert.equal(found.state.keyObserved, true)
    assert.equal(found.state.reportVerified, true)
  })

  it('distinguishes a Bitcoin-valid disclosure from a valid RGB payment', () => {
    const found = findOnchainCheckTrace((s) => s.canonicalSpend === 'rgb-invalid-claim' && s.reportVerified)
    assert.ok(found)
    assert.deepEqual(found.trace, [
      'confirm-funding', 'publish-rgb-invalid-claim', 'verify-report', 'confirm-rgb-invalid-claim',
    ])
    assert.equal(onchainCheckFacts(found.state).canonicalRgbLoss, true)
    assert.equal(onchainCheckFacts(found.state).canonicalRgbPayment, false)
    assert.equal(found.state.reportVerified, true, 'good report bytes do not validate an RGB allocation')
    assert.equal(findOnchainCheckTrace((s) => s.rgbInvalidClaimPublished, honest), null, 'an honest prevalidating operator never exports this spend')
  })

  it('does not turn refund eligibility or a local cutoff into claim expiry', () => {
    const found = findOnchainCheckTrace((s) => s.canonicalSpend === 'valid-rgb-claim' && s.validClaimPublishedAt === 'refund-eligible')
    assert.ok(found)
    assert.deepEqual(found.trace, [
      'confirm-funding', 'pass-claim-cutoff', 'reach-refund-height',
      'publish-valid-claim', 'confirm-valid-claim',
    ])
    const heldClaim = replayOnchainCheckTrace([
      'confirm-funding', 'publish-valid-claim', 'pass-claim-cutoff', 'reach-refund-height',
    ], honest)
    const enabled = nextOnchainCheckStates(heldClaim, honest).map((t) => t.event)
    assert.ok(enabled.includes('confirm-valid-claim'), 'a previously published honest claim can still win')
    assert.ok(enabled.includes('confirm-refund'), 'refund competes for the same Q')
    assert.ok(!enabled.includes('publish-valid-claim'), 'the local guard is not a consensus rule')
  })

  it('rolls back funding and every descendant asset transfer while preserving information', () => {
    const prefix: OnchainCheckModelEvent[] = ['confirm-funding', 'publish-valid-claim', 'verify-report', 'confirm-valid-claim']
    const paid = replayOnchainCheckTrace(prefix, honest)
    assert.equal(onchainCheckFacts(paid).canonicalRgbPayment, true)
    const reorged = replayOnchainCheckTrace([...prefix, 'reorg-funding'], honest)
    assert.deepEqual(onchainCheckFacts(reorged), {
      fundingInputSpent: false, boxCreated: false, boxUnspent: false,
      canonicalRgbPayment: false, canonicalRgbRefund: false, canonicalRgbLoss: false,
      keyObserved: true, reportVerified: true,
    })
    assert.equal(reorged.validClaimPublishedAt, 'claim-window', 'exported claim survives removal of its funding ancestor')
    const reconfirmed = replayOnchainCheckTrace([...prefix, 'reorg-funding', 'confirm-funding', 'confirm-valid-claim'], honest)
    assert.equal(onchainCheckFacts(reconfirmed).canonicalRgbPayment, true, 'the same retained transaction can become executable again')

    const refundReorged = replayOnchainCheckTrace([
      'confirm-funding', 'pass-claim-cutoff', 'reach-refund-height', 'confirm-refund', 'reorg-funding',
    ])
    assert.equal(onchainCheckFacts(refundReorged).canonicalRgbRefund, false)
    assert.equal(onchainCheckFacts(refundReorged).fundingInputSpent, false)
  })

  it('requires independent report verification even after a correct key and valid payment', () => {
    const paid = replayOnchainCheckTrace(['confirm-funding', 'publish-valid-claim', 'confirm-valid-claim'], honest)
    assert.equal(paid.keyObserved, true)
    assert.equal(paid.reportVerified, false)
    assert.equal(onchainCheckFacts(paid).canonicalRgbPayment, true)
    assert.throws(() => replayOnchainCheckTrace(['verify-report']), /MODEL_EVENT_NOT_ENABLED/)
    const refund = replayOnchainCheckTrace(['confirm-funding', 'pass-claim-cutoff', 'reach-refund-height', 'confirm-refund'], honest)
    assert.equal(refund.keyObserved, false)
    assert.equal(refund.reportVerified, false)
  })

  it('prevents both Q spends on one canonical chain but retains claims after refund reorg', () => {
    const refundable: OnchainCheckModelEvent[] = [
      'confirm-funding', 'publish-valid-claim', 'pass-claim-cutoff', 'reach-refund-height',
    ]
    const claim = replayOnchainCheckTrace([...refundable, 'confirm-valid-claim'], honest)
    const refund = replayOnchainCheckTrace([...refundable, 'confirm-refund'], honest)
    assert.ok(!nextOnchainCheckStates(claim, honest).some((t) => t.event === 'confirm-refund'))
    assert.ok(!nextOnchainCheckStates(refund, honest).some((t) => t.event === 'confirm-valid-claim'))
    const switched = replayOnchainCheckTrace([...refundable, 'confirm-refund', 'reorg-refund', 'confirm-valid-claim'], honest)
    assert.equal(onchainCheckFacts(switched).canonicalRgbPayment, true)
    assert.equal(onchainCheckFacts(switched).canonicalRgbRefund, false)
  })

  for (const operatorPolicy of ['adversarial', 'honest-bounded'] as const satisfies readonly OnchainCheckOperatorPolicy[]) {
    it(`enumerates the complete finite ${operatorPolicy} graph with shortest traces and monotone information`, () => {
      const options = { operatorPolicy }
      const all = enumerateOnchainCheckStates(options)
      const byKey = new Map(all.map((item) => [onchainCheckStateKey(item.state), item]))
      assert.equal(byKey.size, all.length)
      assert.deepEqual(all[0], { state: initialOnchainCheckState(), trace: [] })
      assert.ok(all.some(({ state }) => state.reportVerified && state.canonicalSpend === 'refund'))
      assert.ok(all.some(({ state }) => onchainCheckFacts(state).canonicalRgbPayment))
      assert.ok(all.some(({ state }) => state.fundingReorgSeen && state.reportVerified))
      for (const item of all) {
        assert.deepEqual(onchainCheckInvariantErrors(item.state), [], JSON.stringify(item))
        assert.deepEqual(replayOnchainCheckTrace(item.trace, options), item.state)
        const facts = onchainCheckFacts(item.state)
        assert.ok(!(facts.canonicalRgbPayment && facts.canonicalRgbRefund))
        for (const next of nextOnchainCheckStates(item.state, options)) {
          const reached = byKey.get(onchainCheckStateKey(next.state))
          assert.ok(reached, 'BFS must include every enabled successor')
          assert.ok(reached.trace.length <= item.trace.length + 1, 'no edge can reveal a shorter omitted path')
          if (item.state.keyObserved) assert.equal(next.state.keyObserved, true)
          if (item.state.reportVerified) assert.equal(next.state.reportVerified, true)
          if (item.state.validClaimPublishedAt !== null) assert.equal(next.state.validClaimPublishedAt, item.state.validClaimPublishedAt)
          if (item.state.rgbInvalidClaimPublished) assert.equal(next.state.rgbInvalidClaimPublished, true)
        }
      }
    })
  }

  it('rejects impossible model states and unsupported operator modes', () => {
    const invalid = { ...initialOnchainCheckState(), reportVerified: true, canonicalSpend: 'valid-rgb-claim' as const }
    assert.deepEqual(onchainCheckInvariantErrors(invalid), [
      'SPEND_WITHOUT_FUNDING', 'VERIFIED_REPORT_WITHOUT_KEY', 'CLAIM_WITHOUT_PUBLICATION',
    ])
    assert.throws(() => nextOnchainCheckStates(invalid), /INVALID_MODEL_STATE/)
    assert.throws(() => enumerateOnchainCheckStates({ operatorPolicy: 'unconditional' as OnchainCheckOperatorPolicy }), /UNKNOWN_OPERATOR_POLICY/)
  })
})
