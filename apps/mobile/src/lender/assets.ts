// Which RGB asset in this wallet is the test USDT to lend or send. Only the ticker qualifies an asset:
// a test-USDT issuer calls it USDT (regtest) or TUSDT (the Mutinynet issuer, "Passbook test USDT
// (mutinynet, no value)"). A PB-IOU (PBIOU) or any other asset never counts, whoever names it. The
// market's asset ids (the relay's offers, this lender's own offer) are public and unverified, so they
// only choose between assets that already qualify; they never make an asset USDT.
export const TEST_USDT_TICKERS: readonly string[] = ['USDT', 'TUSDT']
/** Never test USDT, whatever else says so: the borrower's PB-IOU notes. */
export const NEVER_USDT_TICKERS: readonly string[] = ['PBIOU']

interface AssetLike { assetId: string; ticker: string; spendable: number }

const ids = (list: Iterable<string | null | undefined>) => new Set([...list].filter((x): x is string => !!x))

/** A test-USDT asset, by its ticker alone. */
export function isTestUsdt(a: Pick<AssetLike, 'ticker'>): boolean {
  return !NEVER_USDT_TICKERS.includes(a.ticker) && TEST_USDT_TICKERS.includes(a.ticker)
}

/** The asset to lend: among test-USDT assets, the market's with something spendable first, else the one held most of. */
export function pickLendAsset<T extends AssetLike>(assets: readonly T[], preferIds: Iterable<string | null | undefined> = []): T | null {
  const prefer = ids(preferIds)
  const usdt = assets.filter(isTestUsdt).sort((a, b) => b.spendable - a.spendable)
  return usdt.find((a) => prefer.has(a.assetId) && a.spendable > 0) ?? usdt[0] ?? null
}

/** The asset a request without an asset id is paid from: test USDT that covers the amount, else any test USDT. */
export function pickSendAsset<T extends AssetLike>(assets: readonly T[], amount: number): T | undefined {
  return assets.find((a) => isTestUsdt(a) && a.spendable >= amount) ?? assets.find(isTestUsdt)
}
