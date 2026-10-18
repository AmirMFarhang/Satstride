// Canvas 4: receive bitcoin or test USDT. An asset request is a blinded RGB invoice for one
// payment; it needs a free output in the reserve, and when there is none the wallet
// prepares one first (canvas 6, "one extra step"), from the person's own bitcoin.
import React, { useEffect, useState } from 'react'
import { Share, Text, View } from 'react-native'
import * as Clipboard from 'expo-clipboard'
import { parseUnits, USDT_PRECISION } from '../../core/amounts'
import { useApp } from '../../app/session'
import { ensureRgbReserve, rgbReady } from '../../app/reserve'
import { Button, Chip, Field, FlowTop, IconButton, Note, P, Problem, Screen, Segmented, Sheet, Working } from '../kit'
import { NETWORK } from '../../wallet/config'
import { useNav } from '../nav'
import { Qr } from '../Qr'
import { C, t } from '../theme'
import { usd } from '../format'
import { requirePhoneLock } from '../../wallet/phone-lock'

const LIFETIME_S = 30 * 60

export function Receive({ params }: { params: Record<string, unknown> }) {
  const s = useApp()
  const nav = useNav()
  const [kind, setKind] = useState<'btc' | 'usdt'>(params.kind === 'btc' ? 'btc' : 'usdt')
  const [info, setInfo] = useState(false)
  return (
    <Screen top={<FlowTop title="Receive" onBack={nav.pop} right={<IconButton name="info" label="How receiving works" onPress={() => setInfo(true)} side="right" />} />}>
      <Segmented label="What to receive" value={kind} onChange={setKind} options={[{ id: 'btc', label: 'Bitcoin' }, { id: 'usdt', label: 'test USDT' }]} />
      {kind === 'btc' ? <ReceiveBtc address={s.btc.address} /> : <ReceiveUsdt />}
      <Sheet visible={info} onClose={() => setInfo(false)} title="How receiving works">
        <P>Bitcoin: this address takes any number of payments.</P>
        <P>test USDT: each request takes one payment and expires after 30 minutes. Make a new one any time. Keep the app open until the payment shows up.</P>
        <P small>Receiving an asset costs you nothing: it lands on an output the wallet keeps ready from your reserve.</P>
      </Sheet>
    </Screen>
  )
}

function CopyShare({ value }: { value: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <View style={{ flexDirection: 'row', gap: 12 }}>
      <Button kind="secondary" label={copied ? 'Copied' : 'Copy'} onPress={async () => { await Clipboard.setStringAsync(value); setCopied(true) }} style={{ flex: 1 }} />
      <Button kind="secondary" label="Share" onPress={() => void Share.share({ message: value })} style={{ flex: 1 }} />
    </View>
  )
}

function ReceiveBtc({ address }: { address: string | null | undefined }) {
  if (!address) return <Working label="Reading the address" />
  return (
    <>
      <View style={{ alignItems: 'center', gap: 12 }}>
        <Qr value={`bitcoin:${address}`} label="QR code of your bitcoin address" />
        <Text style={[t.mono, { textAlign: 'center' }]} selectable>{address}</Text>
        <Text style={t.small}>{NETWORK.name} only · {NETWORK.btcUnit}</Text>
      </View>
      <CopyShare value={address} />
    </>
  )
}

function ReceiveUsdt() {
  const s = useApp()
  const [ready, setReady] = useState<boolean | null>(null)
  const [amount, setAmount] = useState('20')
  const [editing, setEditing] = useState(false)
  const [invoice, setInvoice] = useState<{ invoice: string; expires: number; amount: bigint } | null>(null)
  const [now, setNow] = useState(Date.now())
  const [busy, setBusy] = useState<string | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  useEffect(() => { void rgbReady(s.reserve()).then((r) => setReady(r.ready)).catch((e) => setProblem((e as Error).message)) }, [s])
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer) }, [])
  const units = parseUnits(amount)
  const make = async () => {
    if (units === null) return setProblem(`Enter an amount with at most ${USDT_PRECISION} decimals.`)
    setProblem(null); setBusy('Making the request')
    try {
      // open to any asset: several test assets share the ticker USDT (an issuer's, a lender's)
      const inv = await s.module.rgbBlindReceive({ assetId: null, amount: Number(units), durationSeconds: LIFETIME_S })
      setInvoice({ invoice: inv.invoice, expires: Date.now() + LIFETIME_S * 1000, amount: units })
    } catch (e) { setProblem((e as Error).message) } finally { setBusy(null) }
  }
  const prepare = async () => {
    const lock = await requirePhoneLock('Sign: prepare your wallet to receive assets')
    if (!lock.ok) return setProblem(lock.reason)
    setProblem(null); setBusy('Preparing')
    try { await ensureRgbReserve(s.reserve(), (w) => setBusy(w)); setReady(true) } catch (e) { setProblem((e as Error).message) } finally { setBusy(null) }
  }
  if (ready === false) {
    return (
      <>
        <Note tone="warn" icon="info" title="One extra step first" sub="Your wallet needs a little reserved bitcoin to hold assets. It moves some of your bitcoin into the reserve and waits for a block." />
        <Button label="Prepare to receive" busy={!!busy} onPress={() => void prepare()} />
        <Working label={busy} />
        <Problem>{problem}</Problem>
      </>
    )
  }
  if (!invoice) {
    return (
      <>
        <Field label="Amount (test USDT)" value={amount} onChangeText={setAmount} keyboardType="decimal-pad" />
        <Button label="Make a request" busy={!!busy} disabled={ready === null || units === null} onPress={() => void make()} />
        <Working label={busy ?? (ready === null ? 'Checking the reserve' : null)} />
        <Problem>{problem}</Problem>
      </>
    )
  }
  const left = Math.max(0, Math.floor((invoice.expires - now) / 1000))
  return (
    <>
      <View style={{ alignItems: 'center', gap: 12 }}>
        <Qr value={invoice.invoice} label="QR code of the payment request" />
        <View style={{ flexDirection: 'row', gap: 10, alignItems: 'center' }}>
          <Text style={[t.mid, { fontSize: 22 }]}>{usd(invoice.amount)}</Text>
          <Chip label="Change" onPress={() => { setInvoice(null); setEditing(!editing) }} />
        </View>
        <Text style={[t.small, left === 0 ? { color: C.warn } : null]}>{left ? `Expires in ${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}` : 'Expired. Make a new one.'}</Text>
      </View>
      <CopyShare value={invoice.invoice} />
      <Problem>{problem}</Problem>
    </>
  )
}
