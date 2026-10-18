// Canvas 5 (send test USDT), 6 (one extra step first) and 7 (send bitcoin). Every send is
// read back before it is signed, signed on this phone behind its lock, and can't be undone.
import React, { useEffect, useState } from 'react'
import { Text, View } from 'react-native'
import { checkRecipient, dustFor } from '../../core/network'
import { parseUnits } from '../../core/amounts'
import { NETWORK } from '../../wallet/config'
import { requirePhoneLock } from '../../wallet/phone-lock'
import { useApp } from '../../app/session'
import { ensureRgbReserve, reserveRules, rgbReady } from '../../app/reserve'
import { useWalletView } from '../../app/views'
import { parseAmbiguous, requestedAmount } from '../../core/sends'
import { pendingSends, type PendingSend } from '../../wallet/pending-sends'
import { Button, Chip, Disclosure, Field, FlowTop, Hero, KV, Note, P, Problem, Row, Rows, Screen, Undo, Working } from '../kit'
import { useNav } from '../nav'
import { t } from '../theme'
import { btc, satsText, short, usd, usdNum } from '../format'
import { pickSendAsset } from '../../lender/assets'

type Decoded = Awaited<ReturnType<ReturnType<typeof useApp>['module']['rgbDecodeInvoice']>>

export function SendUsdt() {
  const s = useApp()
  const nav = useNav()
  const w = useWalletView()
  const [text, setText] = useState('')
  const [decoded, setDecoded] = useState<Decoded | null>(null)
  const [typed, setTyped] = useState('')
  const [ready, setReady] = useState<boolean | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  const [sent, setSent] = useState<{ txid: string } | null>(null)
  useEffect(() => { void rgbReady(s.reserve()).then((r) => setReady(r.vanilla >= reserveRules().vanillaMin)).catch(() => setReady(null)) }, [s])

  const read = async () => {
    setProblem(null)
    try {
      const d = await s.module.rgbDecodeInvoice(text.trim())
      if (!d?.recipientId) throw new Error('That is not an RGB request this wallet can read.')
      // the worklet checks it again before signing; rgb-lib names Mutinynet Signet
      if (d.network && String(d.network).toLowerCase() !== NETWORK.rgbNetwork.toLowerCase()) throw new Error(`That request is for ${d.network}, not ${NETWORK.name}.`)
      if (pendingSends.list().some((x) => x.invoice === text.trim())) throw new Error('A payment to this request was signed and may have been broadcast. Check it first (Wallet tab).')
      setDecoded(d)
    } catch (e) { setProblem((e as Error).message) }
  }

  // an invoice with a fixed amount is paid exactly that amount (the field is not shown then)
  const fixed = decoded ? requestedAmount(decoded.assignment) : null
  const amount = fixed ?? (typed ? Number(parseUnits(typed) ?? 0) : 0)
  const assets = w.data?.assets ?? []
  const asset = decoded?.assetId ? assets.find((a) => a.assetId === decoded.assetId) : pickSendAsset(assets, amount)
  const witness = !!decoded && decoded.recipientId.includes(':wvout:')
  const minutes = decoded?.expirationTimestamp ? Math.max(0, Math.round((decoded.expirationTimestamp * 1000 - Date.now()) / 60000)) : null

  const send = async () => {
    if (!decoded || !asset || !amount) return
    if (asset.spendable < amount) return setProblem(`Only ${usd(asset.spendable)} can be sent now.`)
    const lock = await requirePhoneLock(`Sign: send ${usdNum(amount)} test ${asset.ticker}`)
    if (!lock.ok) return setProblem(lock.reason)
    setProblem(null); setBusy('Sending')
    try {
      if (!ready) await ensureRgbReserve(s.reserve(), (x) => setBusy(x))
      setBusy('Signing and sending')
      try {
        const r = await s.module.rgbSend({ invoice: text.trim(), assetId: asset.assetId, amount })
        setSent({ txid: r.txid })
      } catch (e) {
        // signed and maybe broadcast: never back to an enabled Send; kept until it is resolved
        const amb = parseAmbiguous((e as Error).message)
        if (!amb) throw e
        pendingSends.add({ ...amb, invoice: text.trim(), assetId: asset.assetId, amount, at: Math.floor(Date.now() / 1000) })
        nav.replace('send-check', { txid: amb.txid })
      }
    } catch (e) { setProblem((e as Error).message) } finally { setBusy(null) }
  }

  if (sent) {
    return (
      <Screen top={<FlowTop title="Sent" onBack={nav.root} />} bottom={<Button label="Done" onPress={nav.root} />}>
        <Hero value={`${usdNum(amount)} test USDT`} sub="signed on this phone and sent" />
        <Rows><Row k="Transaction" v={short(sent.txid, 8)} mono /></Rows>
        <P muted>It settles after a block, once the receiver has it.</P>
      </Screen>
    )
  }
  if (!decoded) {
    return (
      <Screen top={<FlowTop title="Send" onBack={nav.pop} right={<Chip label="Bitcoin" onPress={() => nav.replace('send-btc')} />} />} bottom={<Button label="Continue" disabled={!text.trim()} onPress={() => void read()} />}>
        <Field label="Payment request" value={text} onChangeText={setText} multiline placeholder="rgb:…" style={{ minHeight: 110, textAlignVertical: 'top' }} />
        <P small>Paste the request the receiver shared with you.</P>
        <Problem>{problem}</Problem>
      </Screen>
    )
  }
  return (
    <Screen top={<FlowTop title="Send" onBack={() => setDecoded(null)} />} bottom={<>
      <Button label={ready === false ? 'Prepare and send' : 'Send'} busy={!!busy} disabled={!asset || !amount} onPress={() => void send()} />
      <Undo text="Payments can't be undone" />
    </>}>
      <Hero value={amount ? `${usdNum(amount)} test USDT` : 'Amount?'} sub={`to request ··${decoded.recipientId.slice(-4)}`} />
      {fixed === null ? <Field label="Amount (test USDT)" value={typed} onChangeText={setTyped} keyboardType="decimal-pad" /> : null}
      {ready === false ? <Note tone="warn" icon="info" title="One extra step first" sub="The wallet tops up its reserve from your bitcoin and waits for a block, then sends." /> : null}
      <Disclosure label="Cost" value="network fee only">
        <KV k="Network fee" v={`about ${2} sat/vB, from your reserve`} />
        {witness ? <KV k="Bitcoin that carries it" v={`${satsText(1000)}, to the receiver with the USDT`} /> : null}
        {minutes !== null ? <KV k="Request valid for" v={`${minutes} min`} /> : null}
        <KV k="Asset" v={asset ? `test ${asset.ticker} · ${asset.assetId.slice(0, 14)}…` : 'none of it in this wallet'} />
        <P small>Every asset payment on Bitcoin rides on a little bitcoin.</P>
      </Disclosure>
      <Working label={busy} />
      <Problem>{problem ?? (!asset ? 'This wallet holds none of the asset that request asks for.' : null)}</Problem>
    </Screen>
  )
}

export function SendBitcoin() {
  const s = useApp()
  const nav = useNav()
  const [to, setTo] = useState('')
  const [amount, setAmount] = useState('')
  const [draft, setDraft] = useState<{ to: string; sats: bigint; fee: bigint } | null>(null)
  const [sent, setSent] = useState<{ txid: string; fee: bigint } | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  const balance = s.btc.balance

  const review = async (max = false) => {
    setProblem(null)
    const r = checkRecipient(to, NETWORK)
    if (!r.ok) return setProblem(r.reason)
    setBusy('Working out the fee')
    try {
      let sats: bigint
      if (max) {
        if (!balance) throw new Error('Nothing to send.')
        const fee = await s.btc.quote(r.address, balance - 2000n)
        sats = balance - fee
      } else {
        const u = parseUnits(amount, 8)
        if (u === null) throw new Error('Enter an amount in test BTC, at most 8 decimals.')
        sats = u
      }
      const dust = dustFor(r.address, NETWORK)
      if (sats < dust) throw new Error(`At least ${dust} sats to this address (smaller outputs are dust).`)
      const fee = await s.btc.quote(r.address, sats)
      if (balance !== null && sats + fee > balance) throw new Error(`Not enough: ${satsText(sats + fee)} with the fee, ${satsText(balance)} in the wallet.`)
      setDraft({ to: r.address, sats, fee })
    } catch (e) { setProblem((e as Error).message) } finally { setBusy(null) }
  }
  const send = async () => {
    if (!draft) return
    const lock = await requirePhoneLock(`Sign: send ${btc(draft.sats)}`)
    if (!lock.ok) return setProblem(lock.reason)
    setBusy('Signing and sending')
    try { const hex = await s.btc.sign(draft.to, draft.sats, draft.fee); setSent(await s.btc.broadcast(hex)); void s.btc.refresh() } catch (e) { setProblem((e as Error).message) } finally { setBusy(null) }
  }

  if (sent) {
    return (
      <Screen top={<FlowTop title="Sent" onBack={nav.root} />} bottom={<Button label="Done" onPress={nav.root} />}>
        <Hero value={draft ? btc(draft.sats) : 'Sent'} sub="signed on this phone and sent" />
        <Rows>
          <Row k="Transaction" v={short(sent.txid, 8)} mono />
          <Row k="Network fee" v={satsText(sent.fee)} />
        </Rows>
      </Screen>
    )
  }
  return (
    <Screen top={<FlowTop title="Send bitcoin" onBack={nav.pop} />} bottom={draft ? <>
      <Button label="Send" busy={!!busy} onPress={() => void send()} />
      <Button kind="ghost" label="Change" onPress={() => setDraft(null)} />
      <Undo text="Payments can't be undone" />
    </> : <Button label="Review" busy={!!busy} disabled={!to.trim()} onPress={() => void review()} />}>
      {draft ? (
        <>
          <Hero value={btc(draft.sats)} sub={`to ${short(draft.to, 8)}`} />
          <Rows>
            <Row k="Network fee" v={satsText(draft.fee)} />
            <Row k="Leaves this wallet" v={btc(draft.sats + draft.fee)} />
          </Rows>
        </>
      ) : (
        <>
          <Field label="To" value={to} onChangeText={setTo} placeholder={`${NETWORK.hrp}1…`} hint={`A ${NETWORK.name} address. Mainnet and other networks' addresses are refused.`} />
          <Field label="Amount (test BTC)" value={amount} onChangeText={setAmount} keyboardType="decimal-pad" placeholder="0.001" />
          <View style={{ flexDirection: 'row', gap: 8, alignItems: 'center' }}>
            <Chip label="Max" onPress={() => void review(true)} />
            <Text style={t.small}>{balance !== null ? `${btc(balance)} available` : ''}</Text>
          </View>
          <P small>{NETWORK.name === 'regtest' ? 'Regtest has no fee market' : 'Mutinynet fees are low'}: every send pays {2} sat/vB.</P>
        </>
      )}
      <Working label={busy} />
      <Problem>{problem}</Problem>
    </Screen>
  )
}

/** A signed send whose broadcast is unknown: check it; cancel it only if it never left this phone. */
export function SendCheck({ params }: { params: Record<string, unknown> }) {
  const s = useApp()
  const nav = useNav()
  const pending = pendingSends.list().find((x) => x.txid === params.txid) ?? pendingSends.list()[0]
  const [state, setState] = useState<{ state: string; rgbStatus: string | null } | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  if (!pending) return <Screen top={<FlowTop title="Payment" onBack={nav.root} />} bottom={<Button label="Done" onPress={nav.root} />}><P muted>No payment of unknown state.</P></Screen>
  const check = async () => {
    setProblem(null); setBusy('Checking the network')
    try {
      const st = await s.module.rgbSendStatus({ txid: pending.txid })
      if (st.state === 'broadcast') { pendingSends.remove(pending.txid); nav.replace('send-check-done', { txid: pending.txid }); return }
      setState(st)
    } catch (e) { setProblem((e as Error).message) } finally { setBusy(null) }
  }
  const cancel = async () => {
    setProblem(null); setBusy('Cancelling')
    try {
      const [o] = await s.module.rgbFailPending({ batchTransferIdx: pending.batchTransferIdx })
      if (!o || o.refused) throw new Error(`Not cancelled: ${o?.refused ?? 'no such unsent payment'}. Check again later.`)
      pendingSends.remove(pending.txid)
      nav.root()
    } catch (e) { setProblem((e as Error).message) } finally { setBusy(null) }
  }
  return (
    <Screen top={<FlowTop title="Payment state unknown" onBack={nav.root} />} bottom={<>
      <Button label="Check again" busy={!!busy} onPress={() => void check()} />
      {state?.state === 'not-seen' && pending.batchTransferIdx !== null ? <Button kind="secondary" label="Cancel it (it never left)" disabled={!!busy} onPress={() => void cancel()} /> : null}
    </>}>
      <Hero value={`${usdNum(pending.amount)} test USDT`} sub="signed on this phone; sending it failed" />
      <Note tone="warn" icon="alert" title="It may already be on the network" sub="Nothing is signed again for this request until this is resolved." />
      <Rows>
        <Row k="Transaction" v={short(pending.txid, 8)} mono />
        <Row k="Last check" v={!state ? 'not yet' : state.state === 'broadcast' ? 'on the network' : state.state === 'not-seen' ? 'not on the network' : "couldn't tell"} />
        {state?.rgbStatus ? <Row k="rgb-lib" v={state.rgbStatus} /> : null}
      </Rows>
      <Working label={busy} />
      <Problem>{problem}</Problem>
    </Screen>
  )
}

export function SendCheckDone({ params }: { params: Record<string, unknown> }) {
  const nav = useNav()
  return (
    <Screen top={<FlowTop title="Sent" onBack={nav.root} />} bottom={<Button label="Done" onPress={nav.root} />}>
      <Hero value="On the network" sub="the payment went out after all" />
      <Rows><Row k="Transaction" v={short(String(params.txid), 8)} mono /></Rows>
    </Screen>
  )
}

export type { PendingSend }
