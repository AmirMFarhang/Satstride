// Pairing from the dashboard's link, and going back to pairing at once when the node refuses the key.

import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native'
import { Phone } from '../src/ui/Phone'
import { PHONE_ONLY, SHARED } from '../src/core/strings'
import { BORROWER, FakeNode, memoryStore, pairedTo } from './helpers/fake-node'

const link = (exp: number) => `passbook://pair?v=1&node=http%3A%2F%2F127.0.0.1%3A4271&code=${'0f'.repeat(16)}&scope=borrower&borrower=${BORROWER}&exp=${exp}&ttl=43200000`

describe('pairing', () => {
  it('pairs from a link only after the borrower confirms, and keeps the key in secure storage', async () => {
    const node = new FakeNode()
    const store = memoryStore(null)
    await render(<Phone deps={{ store, lock: async () => ({ ok: true }), fetch: node.fetch, initialLink: link(Date.now() + 60_000), pollMs: 60_000 }} />)
    await screen.findByText(/Pair as borrower/)
    expect(node.calls).toHaveLength(0)
    await fireEvent.press(screen.getByTestId('pair'))
    await screen.findByText(SHARED.canBorrow)
    expect(store.saved).toHaveLength(1)
    expect(store.saved[0].node).toBe('http://127.0.0.1:4271')
    const claim = node.calls.find((c) => c.path === '/devices/claim')!
    expect(claim.body).toMatchObject({ code: '0f'.repeat(16), device_pk: store.saved[0].key.pubkey })
    expect(claim.headers['x-passbook-key']).toBe(store.saved[0].key.pubkey)
  })

  it('refuses an expired pairing link without calling the node', async () => {
    const node = new FakeNode()
    await render(<Phone deps={{ store: memoryStore(null), lock: async () => ({ ok: true }), fetch: node.fetch, initialLink: link(Date.now() - 1), pollMs: 60_000 }} />)
    await screen.findByText(/expired/)
    expect(screen.queryByTestId('pair')).toBeNull()
    expect(node.calls).toHaveLength(0)
  })

  it('never stacks polls on a slow node, and forgets a refused key exactly once', async () => {
    const node = new FakeNode()
    const base = node.fetch
    let inFlight = 0
    let most = 0
    node.fetch = (async (url: string, init: never) => {
      const me = url.endsWith('/devices/me')
      if (me) most = Math.max(most, ++inFlight)
      try {
        await new Promise((r) => setTimeout(r, 120))
        return await base(url, init)
      } finally {
        if (me) inFlight -= 1
      }
    }) as never
    const store = memoryStore(pairedTo())
    await render(<Phone deps={{ store, lock: async () => ({ ok: true }), fetch: node.fetch, pollMs: 10 }} />)
    await screen.findByText(SHARED.canBorrow, {}, { timeout: 10_000 })
    node.refusal = 'device key revoked; pair the phone again'
    await waitFor(() => expect(screen.getByText(PHONE_ONLY.pairTitle)).toBeTruthy(), { timeout: 10_000 })
    expect(most).toBe(1)
    expect(store.forgotten).toBe(1)
    await act(async () => {})
  })

  it('goes back to pairing at once, and forgets the key, when the node refuses it', async () => {
    const node = new FakeNode()
    const store = memoryStore(pairedTo())
    await render(<Phone deps={{ store, lock: async () => ({ ok: true }), fetch: node.fetch, pollMs: 50 }} />)
    await screen.findByText(SHARED.canBorrow)
    node.refusal = 'device key revoked; pair the phone again'
    // the next poll is refused; generous timeout for loaded CI machines
    await waitFor(() => expect(screen.getByText(PHONE_ONLY.pairTitle)).toBeTruthy(), { timeout: 10_000 })
    expect(screen.getByText(`${PHONE_ONLY.unpaired}: device key revoked; pair the phone again`)).toBeTruthy()
    expect(store.forgotten).toBe(1)
    await act(async () => {})
  })
})
