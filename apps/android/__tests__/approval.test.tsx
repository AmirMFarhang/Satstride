// Approving on the phone needs the phone's lock, then sends the shared
// fixture's request (the same body the dashboard sends), signed by the device key.

import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native'
import { schnorr } from '@noble/curves/secp256k1.js'
import { hexToBytes } from '@noble/hashes/utils.js'
import { Phone } from '../src/ui/Phone'
import { requestDigest } from '../src/core/signing'
import { PHONE_ONLY, SHARED } from '../src/core/strings'
import { FakeNode, fixture, memoryStore, pairedTo } from './helpers/fake-node'

async function setup(lockResult: { ok: true } | { ok: false; message: string }) {
  const node = new FakeNode()
  node.waiting = fixture.waiting
  const paired = pairedTo()
  const lock = jest.fn(async () => lockResult)
  await render(<Phone deps={{ store: memoryStore(paired), lock, fetch: node.fetch, pollMs: 60_000 }} />)
  return { node, paired, lock }
}

describe('the approval screen', () => {
  it('asks for the phone’s lock, then posts the fixture request signed by the device key', async () => {
    const { node, paired, lock } = await setup({ ok: true })
    await fireEvent.press(await screen.findByTestId('approve'))
    await waitFor(() => expect(node.answers).toHaveLength(1))
    expect(lock).toHaveBeenCalledWith(PHONE_ONLY.lockPrompt)
    expect(node.answers[0]).toEqual(fixture.request)
    const call = node.calls.find((c) => c.path === '/demo/confirm')!
    expect(call.headers['x-passbook-key']).toBe(paired.key.pubkey)
    const digest = requestDigest('POST', '/demo/confirm', Number(call.headers['x-passbook-ts']), call.headers['x-passbook-nonce'], JSON.stringify(fixture.request))
    expect(schnorr.verify(hexToBytes(call.headers['x-passbook-sig']), hexToBytes(digest), hexToBytes(paired.key.pubkey))).toBe(true)
    await screen.findByText(/Approved on this phone/)
  })

  it('sends nothing when the phone is not unlocked', async () => {
    const { node, lock } = await setup({ ok: false, message: PHONE_ONLY.lockCancelled })
    await fireEvent.press(await screen.findByTestId('approve'))
    await screen.findByText(PHONE_ONLY.lockCancelled)
    expect(lock).toHaveBeenCalled()
    expect(node.calls.some((c) => c.path === '/demo/confirm')).toBe(false)
  })

  it('refuses to approve on a phone with no screen lock', async () => {
    const { node } = await setup({ ok: false, message: PHONE_ONLY.lockNeeded })
    await fireEvent.press(await screen.findByTestId('approve'))
    await screen.findByText(PHONE_ONLY.lockNeeded)
    expect(node.calls.some((c) => c.path === '/demo/confirm')).toBe(false)
  })

  it('never brings an answered stop back from a poll that started before the answer', async () => {
    const node = new FakeNode()
    node.waiting = fixture.waiting
    const base = node.fetch
    // a slow /demo: the node reads its state at once and the answer arrives late, so a poll
    // in flight when the borrower taps still carries stop 2
    node.fetch = (async (url: string, init: never) => {
      const res = await base(url, init)
      if (url.endsWith('/demo')) {
        const body = await res.json()
        await new Promise((r) => setTimeout(r, 250))
        return { status: res.status, json: async () => body }
      }
      return res
    }) as never
    await render(<Phone deps={{ store: memoryStore(pairedTo()), lock: async () => ({ ok: true }), fetch: node.fetch, pollMs: 20 }} />)
    await fireEvent.press(await screen.findByTestId('approve', {}, { timeout: 5_000 }))
    await waitFor(() => expect(node.answers).toHaveLength(1))
    await screen.findByText(/Approved on this phone/, {}, { timeout: 5_000 })
    // for the next second the stop must not come back with its button live
    for (let i = 0; i < 40; i++) {
      await act(async () => { await new Promise((r) => setTimeout(r, 25)) })
      expect(screen.queryByTestId('approve')).toBeNull()
    }
    expect(node.answers).toEqual([fixture.request])
  })

  it('declines without the lock: declining commits nothing', async () => {
    const { node, lock } = await setup({ ok: true })
    await fireEvent.press(await screen.findByTestId('decline'))
    await waitFor(() => expect(node.answers).toEqual([{ ...fixture.request, accept: false }]))
    expect(lock).not.toHaveBeenCalled()
    expect(screen.queryByText(SHARED.approveAndLock)).toBeNull()
  })
})
