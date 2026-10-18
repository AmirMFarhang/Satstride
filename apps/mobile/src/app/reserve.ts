// The reserve: the wallet keeps a little of the person's bitcoin where loans and RGB
// payments need it, so the person never manages outputs (docs/RGB-WALLET-UX.md, section 5).
// Three places on this phone, all from the same seed:
//   - the main bitcoin account (WDK, BIP-84): the balance the person sees and spends;
//   - the Passbook key (BIP-86, m/86'/1'/0'/0/0): collateral is locked from here;
//   - the RGB wallet (rgb-lib): colored outputs that hold assets, vanilla bitcoin for RGB fees.
// When a loan or a receive needs bitcoin in one of the last two, it moves there from the
// main account first, inside the step the person approved, and waits for one block.
import type { Hex } from '../../../../src/core/crypto.js'
import { TX_FEE_SATS } from '../../../../src/escrow/escrow.js'
import type { ChainPort } from '../agent/ports'
import { activeNetwork, type NetworkName } from '../core/network'

export interface ReserveRules {
  /** below this the RGB wallet cannot pay a send's fee and its 1,000-sat witness output */
  vanillaMin: number
  /** what one top-up moves into the RGB wallet */
  vanillaTopUp: number
  /** free colored outputs kept ready for receives */
  freeSlotsMin: number
  slotsPerTopUp: number
  slotSats: number
  /** the fee of the transaction that creates the colored outputs, so vanillaMin is still there after it */
  slotFeeMargin: number
  /** a margin over the lock's own fee for the move to the Passbook key */
  collateralMargin: number
}

/**
 * Per network. Regtest has coins to spare. Mutinynet's faucet is rationed (the lender phone gets
 * about 15,000 sats): one 10,000-sat top-up and three 2,000-sat slots carry the lender's sends
 * (about 1,000 witness + fee each). vanillaMin is when to top up, so it sits just above one send:
 * higher, and every check after the first send would ask for another full top-up.
 */
export const RESERVES: Record<NetworkName, ReserveRules> = {
  regtest: { vanillaMin: 15_000, vanillaTopUp: 50_000, freeSlotsMin: 2, slotsPerTopUp: 3, slotSats: 5_000, slotFeeMargin: 0, collateralMargin: 1_000 },
  mutinynet: { vanillaMin: 2_000, vanillaTopUp: 10_000, freeSlotsMin: 1, slotsPerTopUp: 3, slotSats: 2_000, slotFeeMargin: 600, collateralMargin: 1_000 },
}
export const reserveRules = (name: NetworkName = activeNetwork().name): ReserveRules => RESERVES[name]

export interface Unspent { outpoint: string; sats: number; colorable: boolean; exists: boolean; allocations: { assetId: string | null; amount: number; settled: boolean }[]; pendingBlinded: number; free: boolean }
interface BtcSide { settled: number; future: number; spendable: number }

export interface ReservePorts {
  /** the main bitcoin account (WDK) */
  main: {
    balance(): Promise<bigint>
    quote(to: string, sats: bigint): Promise<bigint>
    sign(to: string, sats: bigint, quotedFee: bigint): Promise<string>
    broadcast(hex: string): Promise<{ txid: string; fee: bigint }>
  }
  rgb: {
    rgbAddress(): Promise<string>
    rgbBtcBalance(o?: { skipSync?: boolean }): Promise<{ vanilla: BtcSide; colored: BtcSide }>
    rgbUnspents(o?: { skipSync?: boolean }): Promise<Unspent[]>
    rgbCreateUtxos(o: { num?: number; size?: number; feeRate?: number }): Promise<number>
  }
  chain: ChainPort
  party: { address: string; script: Hex }
}

export interface ReserveView {
  /** sats in colored outputs that hold an asset */
  holding: number
  /** free colored outputs, ready for receives */
  freeSlots: number
  slots: number
  /** RGB-wallet bitcoin for fees, and the free colored outputs' sats */
  ready: number
  /** confirmed bitcoin on the Passbook key, ready to lock */
  forLoans: number
  pendingCollateral: number
}

export async function reserveView(p: ReservePorts, skipSync = true): Promise<ReserveView> {
  const [unspents, bal, partyUtxos] = await Promise.all([p.rgb.rgbUnspents({ skipSync }), p.rgb.rgbBtcBalance({ skipSync }), p.chain.utxos(p.party.script)])
  const colored = unspents.filter((u) => u.colorable && u.exists)
  const holding = colored.filter((u) => u.allocations.length > 0).reduce((s, u) => s + u.sats, 0)
  const free = colored.filter((u) => u.free)
  return {
    holding,
    freeSlots: free.length,
    slots: colored.length,
    ready: bal.vanilla.spendable + free.reduce((s, u) => s + u.sats, 0),
    forLoans: partyUtxos.filter((u) => u.height > 0).reduce((s, u) => s + u.value, 0),
    pendingCollateral: partyUtxos.filter((u) => u.height <= 0).reduce((s, u) => s + u.value, 0),
  }
}

async function confirmed(chain: ChainPort, txid: Hex, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const tx = await chain.getTx(txid).catch(() => null)
    if (tx?.height) return
    await new Promise((r) => setTimeout(r, 2500))
  }
  throw new Error(`still waiting for a block for ${txid.slice(0, 12)}…; try again in a moment`)
}

/**
 * Move `sats` of the person's own bitcoin from the main account to `to`, and wait for one block.
 * When the wallet cannot afford `sats` but can afford `atLeast`, it moves `atLeast`.
 */
async function move(p: ReservePorts, to: string, sats: number, say: (s: string) => void, atLeast = sats): Promise<Hex> {
  let amount = BigInt(sats)
  let fee = await p.main.quote(to, amount)
  const have = await p.main.balance()
  if (have < amount + fee && atLeast < sats) {
    amount = BigInt(atLeast)
    fee = await p.main.quote(to, amount)
  }
  if (have < amount + fee) throw new Error(`Not enough bitcoin: this needs ${(amount + fee).toString()} sats and your wallet has ${have.toString()}.`)
  const hex = await p.main.sign(to, amount, fee)
  const { txid } = await p.main.broadcast(hex)
  say('Waiting for one block')
  await confirmed(p.chain, txid as Hex, 180_000)
  return txid as Hex
}

/** The Passbook key holds at least `collateralSats` (plus the lock's fee), confirmed. Returns the top-up txid if one was needed. */
export async function ensureCollateral(p: ReservePorts, collateralSats: number, say: (s: string) => void = () => {}, r: ReserveRules = reserveRules()): Promise<Hex | null> {
  const need = collateralSats + TX_FEE_SATS
  const have = (await p.chain.utxos(p.party.script)).filter((u) => u.height > 0).reduce((s, u) => s + u.value, 0)
  if (have >= need) return null
  say('Moving bitcoin to your passbook key')
  return move(p, p.party.address, need - have + r.collateralMargin, say)
}

/** The RGB wallet has bitcoin for fees and free colored outputs for receives. Returns what it did. */
export async function ensureRgbReserve(p: ReservePorts, say: (s: string) => void = () => {}, r: ReserveRules = reserveRules(), waitMs = 180_000): Promise<{ toppedUp: Hex | null; created: number }> {
  let toppedUp: Hex | null = null
  const bal = await p.rgb.rgbBtcBalance({})
  const unspents = await p.rgb.rgbUnspents({ skipSync: true })
  const free = unspents.filter((u) => u.free && u.exists).length
  const slotsNeeded = free < r.freeSlotsMin ? r.slotsPerTopUp : 0
  const vanillaNeeded = r.vanillaMin + (slotsNeeded ? slotsNeeded * r.slotSats + r.slotFeeMargin : 0)
  if (bal.vanilla.spendable < vanillaNeeded) {
    say('Topping up the reserve')
    // a full top-up when the wallet has it; otherwise only what is missing
    toppedUp = await move(p, await p.rgb.rgbAddress(), Math.max(r.vanillaTopUp, vanillaNeeded), say, vanillaNeeded - bal.vanilla.spendable)
  }
  let created = 0
  if (slotsNeeded) {
    say('Preparing outputs for assets')
    created = Number(await p.rgb.rgbCreateUtxos({ num: slotsNeeded, size: r.slotSats, feeRate: 2 }))
    // the new outputs can receive once they are in a block
    const deadline = Date.now() + waitMs
    while (Date.now() < deadline && (await p.rgb.rgbUnspents({})).filter((u) => u.free && u.exists).length < r.freeSlotsMin) await new Promise((res) => setTimeout(res, 3000))
  }
  return { toppedUp, created }
}

/** Whether a receive of an asset can happen right now without the extra step. */
export async function rgbReady(p: ReservePorts, r: ReserveRules = reserveRules()): Promise<{ ready: boolean; freeSlots: number; vanilla: number }> {
  const [unspents, bal] = await Promise.all([p.rgb.rgbUnspents({ skipSync: true }), p.rgb.rgbBtcBalance({ skipSync: true })])
  const freeSlots = unspents.filter((u) => u.free && u.exists).length
  return { ready: freeSlots >= 1 && bal.vanilla.spendable >= r.vanillaMin, freeSlots, vanilla: bal.vanilla.spendable }
}
