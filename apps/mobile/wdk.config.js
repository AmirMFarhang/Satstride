// The Bare worklet bundle (wdk-worklet-bundler, HRPC transport for React Native).
// - bitcoin / bitcoin-mutinynet: WDK's BTC module (BIP-84) on regtest / Mutinynet.
// - passbook: this app's own module (worklet/index.js). WDK hands it the seed once;
//   it keeps the BIP-32 root and runs the borrower's RGB wallet (rgb-lib, watch-only)
//   and signs its PSBTs. Keys never leave the worklet.
// allowed*Methods list the only calls the UI thread may make: no key export, no
// arbitrary account or module methods.
/** @type {import('@tetherto/wdk-worklet-bundler').WdkBundleConfig} */
module.exports = {
  networks: {
    bitcoin: { package: '@tetherto/wdk-wallet-btc' },
    // the same BTC module on Mutinynet, under its own key: WDK keeps addresses per network key,
    // so a regtest address is never shown on Mutinynet (src/core/network.ts btcKey)
    'bitcoin-mutinynet': { package: '@tetherto/wdk-wallet-btc' },
  },
  modules: {
    passbook: { package: 'passbook-worklet' },
  },
  allowedMethods: {
    bitcoin: {
      methods: ['getAddress', 'getBalance', 'quoteSendTransaction', 'signTransaction', 'sendTransaction', 'getTransfers'],
    },
    'bitcoin-mutinynet': {
      methods: ['getAddress', 'getBalance', 'quoteSendTransaction', 'signTransaction', 'sendTransaction', 'getTransfers'],
    },
  },
  allowedModuleMethods: {
    passbook: {
      methods: [
        'info',
        // RGB (M2)
        'rgbAddress', 'rgbBtcBalance', 'rgbCreateUtxos', 'rgbBlindReceive', 'rgbWitnessReceive', 'rgbRefresh', 'rgbAssets',
        'rgbTransfers', 'rgbDecodeInvoice', 'rgbSend', 'rgbIssueNia', 'rgbFailPending', 'rgbSendStatus', 'rgbUnspents',
        // the lender's per-loan repayment accounts (M6)
        'lenderRepayKeys', 'lenderRepayRestore', 'lenderRepayRefresh', 'lenderRepayTransfers', 'lenderRepayAssets',
        'rgbRestoreBackup',
        // the party key (M3): each computes what it signs from structured input
        'partySignObject', 'partySignPassbookHash', 'partySignRequest', 'partySignEvent', 'partyNip44Encrypt',
        'partyNip44Decrypt', 'partySignKeyPath', 'partySignEscrowLeaf',
        // the chain source (M3): the laptop's electrs
        'chainHeight', 'chainUtxos', 'chainHistory', 'chainRawTx', 'chainBroadcast',
        'close',
      ],
    },
  },
  // react-native-bare-kit 0.16 does not link addons itself: the bundler links exactly the
  // addons the bundle names into bare-kit's addons folder, which its Gradle build packages.
  output: {
    addons: { android: './node_modules/react-native-bare-kit/android/src/main/addons' },
  },
  options: {
    targets: ['android-arm64'],
    linkAddons: true,
  },
}
