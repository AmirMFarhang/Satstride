// The network badge is on every screen, and no screen labels a test asset plain "USDT".

import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native'
import { Phone, type Deps } from '../src/ui/Phone'
import { NOT_PAIRED_BADGE } from '../src/core/network'
import { PHONE_ONLY, SHARED } from '../src/core/strings'
import { FakeNode, fixture, memoryStore, pairedTo } from './helpers/fake-node'

const deps = (node: FakeNode, paired = true): Deps => ({ store: memoryStore(paired ? pairedTo() : null), lock: async () => ({ ok: true }), fetch: node.fetch, pollMs: 60_000 })

/** Every text on screen, joined. */
const allText = () => screen.toJSON() ? JSON.stringify(screen.toJSON()).match(/"children":\["[^"]*"/g)?.join(' ') ?? '' : ''

function expectBadge(text: string) {
  expect(screen.getByTestId('network-badge')).toHaveTextContent(text)
  expect(allText()).not.toMatch(/\d USDT\b/)
}

describe('network badge on every screen', () => {
  it('pairing screen: not paired yet', async () => {
    await render(<Phone deps={deps(new FakeNode(), false)} />)
    await screen.findByText(PHONE_ONLY.pairTitle)
    expectBadge(NOT_PAIRED_BADGE)
  })

  it('passbook, a closed page, wallet and offers', async () => {
    const node = new FakeNode()
    await render(<Phone deps={deps(node)} />)
    await screen.findByText(SHARED.canBorrow)
    expectBadge('REGTEST · test coins')
    expect(screen.getByTestId('connection')).toHaveTextContent(`${PHONE_ONLY.connected} · 127.0.0.1:4271`)
    expect(screen.getByTestId('hero-big')).toHaveTextContent('1,100 test USDT (regtest)')

    await fireEvent.press(screen.getByText('Page 1 · 600.00 test USDT (regtest)'))
    await screen.findByText(SHARED.paidOnTime)
    expectBadge('REGTEST · test coins')
    await fireEvent.press(screen.getByText(SHARED.backToPassbook))

    await fireEvent.press(screen.getByText(SHARED.wallet))
    await screen.findByText(SHARED.assets.toUpperCase())
    expectBadge('REGTEST · test coins')
    expect(screen.getByText('$ test USDT (regtest)')).toBeTruthy()
    expect(screen.getByText(/test USDT \(regtest\) sent/)).toBeTruthy()

    await fireEvent.press(screen.getByText(PHONE_ONLY.offers))
    await screen.findByText('12.00% APR · up to 1,000.00 test USDT (regtest) · 30 blocks')
    expectBadge('REGTEST · test coins')
  })

  it('an open loan with its status', async () => {
    const node = new FakeNode()
    node.closedPage = false
    node.openLoan = true
    await render(<Phone deps={deps(node)} />)
    await screen.findByText(SHARED.open)
    expectBadge('REGTEST · test coins')
    expect(screen.getByText('605.92 test USDT (regtest)')).toBeTruthy()
    expect(screen.getByText(PHONE_ONLY.loanStatus.toUpperCase())).toBeTruthy()
  })

  it('stop 1, stop 2, the term sheet and stop 3', async () => {
    const node = new FakeNode()
    node.waiting = { waiting: 'approve', items: [{ txid: '11'.repeat(32), amount: 2_500_000_000, height: 300 }], lender_pk: fixture.waiting.lender_pk }
    const view = await render(<Phone deps={deps(node)} />)
    await screen.findByText(SHARED.shareAndApply)
    expectBadge('REGTEST · test coins')
    await view.unmount()

    node.waiting = fixture.waiting
    await render(<Phone deps={deps(node)} />)
    await screen.findByText(SHARED.approveAndLock)
    expectBadge('REGTEST · test coins')
    await fireEvent.press(screen.getByTestId('read-termsheet'))
    await screen.findByText(PHONE_ONLY.termSheet)
    expectBadge('REGTEST · test coins')
    expect(screen.getByText('Borrow 600.00 test USDT (regtest) against 0.01211840 BTC')).toBeTruthy()
    expect(screen.getByText(fixture.waiting.loan_id)).toBeTruthy()
    await screen.unmount()

    node.waiting = { waiting: 'confirm', stop: 'repay', loan_id: 'c1'.repeat(32), lender_pk: fixture.waiting.lender_pk, debt: 605_920_000, collateral_sats: 1_211_840 }
    await render(<Phone deps={deps(node)} />)
    await screen.findByText('Pay 605.92 test USDT (regtest)')
    expectBadge('REGTEST · test coins')
  })

  it('shows an atomic loan’s Lightning invoice expiry before approving, on stop 2 and in the term sheet', async () => {
    const node = new FakeNode()
    const expires = Math.floor(Date.now() / 1000) + 86_400
    node.waiting = { ...fixture.waiting, atomic_repayment: { expires_at: expires, payment_hash: 'ab'.repeat(32) } }
    await render(<Phone deps={deps(node)} />)
    await screen.findByText(SHARED.approveAndLock)
    expect(screen.getByText(SHARED.invoiceExpires)).toBeTruthy()
    expect(screen.getByText(new Date(expires * 1000).toLocaleString())).toBeTruthy()
    expect(screen.getByText(SHARED.satsExtra)).toBeTruthy()
    await fireEvent.press(screen.getByTestId('read-termsheet'))
    await screen.findByText(PHONE_ONLY.termSheet)
    expect(screen.getByText(SHARED.invoiceExpires)).toBeTruthy()
  })

  it('never shows a lender’s or checker’s approval on the phone', async () => {
    const node = new FakeNode()
    node.waiting = { ...fixture.waiting, stop: 'lender-approve' }
    await render(<Phone deps={deps(node)} />)
    await screen.findByText(SHARED.canBorrow)
    expect(screen.queryByText(SHARED.approveAndLock)).toBeNull()
    await act(async () => {})
  })
})

describe('the node’s network profile', () => {
  it('uses the wallet panel’s profile when the node publishes one', async () => {
    const node = new FakeNode()
    const base = node.fetch
    node.fetch = (async (url: string, init: never) => (url.endsWith('/wallet/api/network') ? { status: 200, json: async () => ({ network: { name: 'mutinynet', label: 'Mutinynet', asset: 'test USDT (mutinynet)', coin: 'mutinynet BTC' }, wallet_panel: true }) } : base(url, init))) as never
    await render(<Phone deps={deps(node)} />)
    await waitFor(() => expect(screen.getByTestId('network-badge')).toHaveTextContent('MUTINYNET · test coins'))
    expectBadge('MUTINYNET · test coins')
    expect(screen.getByTestId('hero-big')).toHaveTextContent('1,100 test USDT (mutinynet)')
  })
})

describe('platform API off', () => {
  it('keeps the badge and says the node reads its own records', async () => {
    const node = new FakeNode()
    const base = node.fetch
    node.fetch = (async (url: string, init: never) => (url.endsWith('/state') ? { status: 503, json: async () => ({ error: 'platform API is offline' }) } : url.endsWith('/demo/local') ? { status: 200, json: async () => ({ state: { chain: 'bitcoind', height: 512, price_cents: 10_000_000, loans: [] }, passbook: { pages: [], ladder: { step: 0, allowed_ltv_bps: 5000 } } }) } : base(url, init))) as never
    await render(<Phone deps={deps(node)} />)
    await waitFor(() => expect(screen.getByText(PHONE_ONLY.platformOff)).toBeTruthy())
    expectBadge('REGTEST · test coins')
  })
})
