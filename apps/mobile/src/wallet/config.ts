// What the WDK worklet is started with. The seed is generated, encrypted and used
// inside the Bare worklet (WDK); the UI thread only ever receives addresses,
// balances and signed transactions.
import type { WdkConfigs } from '@tetherto/wdk-react-native-core'
import { Directory, Paths } from 'expo-file-system'
import { REGTEST, assertTestNetwork, profileFor, setActiveNetwork, type NetworkProfile } from '../core/network'
import { networkSettings } from './flags'

/** The one wallet this app holds: the borrower's. */
export const WALLET_ID = 'passbook-borrower'

/** Why the saved network settings were not used this run (they fall back to regtest), if they were refused. */
export let NETWORK_PROBLEM: string | null = null
function loadNetwork(): NetworkProfile {
  const s = networkSettings.get()
  try { return profileFor(s.name, { platform: s.platform, platformPk: s.platformPk, relays: s.relays, proxy: s.proxy }) } catch (e) { NETWORK_PROBLEM = (e as Error).message; return REGTEST }
}
/** The test network this app run talks to, chosen at start (Settings or the provider's link). */
export const NETWORK = loadNetwork()
assertTestNetwork(NETWORK)
setActiveNetwork(NETWORK)

/** Test networks relay at 1 sat/vB; 2 leaves room, like the laptop's wallet panel. */
export const FEE_RATE_SAT_VB = 2

/** An app-private directory (no backup, see app.json allowBackup) as a plain path; it must exist before rgb-lib opens it. */
export function appDir(...segments: string[]): string {
  const dir = new Directory(Paths.document, ...segments)
  try { dir.create({ intermediates: true, idempotent: true }) } catch { /* reported by rgb-lib when it opens */ }
  return decodeURIComponent(dir.uri.replace(/^file:\/\//, '')).replace(/\/$/, '')
}
/** rgb-lib's data directory for the wallet's own RGB wallet: one per network (regtest keeps its M2 directory). */
export const RGB_DIR = NETWORK.name === 'regtest' ? 'rgb' : `rgb-${NETWORK.name}`
const rgbDataDir = () => appDir(RGB_DIR)
/** The lender's per-loan repayment accounts, one rgb-lib wallet each (M6), per network. */
export const loansDataDir = () => appDir(NETWORK.name === 'regtest' ? 'rgb-loans' : `rgb-loans-${NETWORK.name}`)

export const wdkConfigs: WdkConfigs = {
  networks: {
    // WDK's worklet requires the network key and the blockchain field to be the same name
    [NETWORK.btcKey]: {
      blockchain: NETWORK.btcKey,
      config: {
        network: NETWORK.btcNetwork,
        bip: 84,
        client: {
          type: 'electrum',
          clientConfig: { host: NETWORK.electrum.host, port: NETWORK.electrum.port, protocol: NETWORK.electrum.protocol === 'ssl' ? 'ssl' : 'tcp', maxRetry: 2 },
        },
      },
    },
  },
  // the Passbook module in the worklet (worklet/index.js): the RGB wallet's endpoints, no keys
  modules: {
    passbook: {
      // the network's name and address prefix: the party key's own output and PSBT summaries use them
      network: { name: NETWORK.name, hrp: NETWORK.hrp },
      rgb: {
        network: NETWORK.rgbNetwork,
        dataDir: rgbDataDir(),
        loansDir: loansDataDir(),
        indexerUrl: NETWORK.rgbIndexer,
        proxyEndpoint: NETWORK.proxy,
      },
      // the borrower agent's chain source (M3): Electrum over TCP, like the BTC wallet
      electrum: { host: NETWORK.electrum.host, port: NETWORK.electrum.port },
    },
  },
}
