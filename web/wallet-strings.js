// Every word the wallet panel shows, in one place: the web panel (web/wallet.js)
// and the Android thin client (apps/android) use the same screens and the same
// words. Plain data only, no code, so it can be read as JSON after stripping the
// first and last lines.
//
// Rules: {coin} and {asset} are filled from the node's network profile
// ("regtest BTC", "test USDT (regtest)"). No string here may name the dollar
// asset as plain "USDT": the asset is always {asset} (test/wallet-web.test.ts
// checks it).

export default {
  "app.title": "Passbook wallet",
  "badge.test": "test coins",
  "badge.title": "Network: {network}. Test coins only, no real value.",
  "nav.home": "Home",
  "nav.receive": "Receive",
  "nav.send": "Send",
  "nav.history": "History",
  "nav.about": "About",
  "nav.back": "Back",
  "nav.lock": "Lock",

  "loading": "Loading…",
  "disabled.title": "No wallet on this node",
  "disabled.body": "This Passbook node runs without the wallet panel (PASSBOOK_WALLET=off).",
  "session.title": "Open from your operator link",
  "session.body": "The wallet only answers requests signed with your node's operator session. Open the link your node printed at start-up (it ends in #session=…) in this tab.",

  "welcome.title": "Your wallet on your own node",
  "welcome.body": "One seed holds your {coin} and your {asset}. It stays encrypted on this node.",
  "welcome.create": "Create a new wallet",
  "welcome.restore": "Restore from my words",

  "create.title": "Choose a passphrase",
  "create.body": "It encrypts your seed on this node. At least 8 characters. It can't be recovered: without it, only your 12 words open the wallet.",
  "create.passphrase": "Passphrase",
  "create.repeat": "Repeat the passphrase",
  "create.go": "Create wallet",
  "create.mismatch": "The two passphrases differ.",

  "words.title": "Write down these 12 words",
  "words.body": "They are the only backup. Anyone with them can spend this wallet. They are shown once.",
  "words.done": "I wrote them down",

  "backup.title": "Prove your backup",
  "backup.body": "Type words {positions} from your paper. Needed before your first loan.",
  "backup.word": "Word {n}",
  "backup.passphrase": "Passphrase",
  "backup.go": "Check",
  "backup.ok": "Backup proven. You can borrow.",
  "backup.bad": "Those words don't match. Check your paper and try again.",
  "backup.banner": "Prove your backup before your first loan.",
  "backup.banner.go": "Prove it now",

  "restore.title": "Restore from your words",
  "restore.words": "Your 12 or 24 words, in order",
  "restore.passphrase": "New passphrase for this node",
  "restore.go": "Restore",

  "unlock.title": "Unlock your wallet",
  "unlock.passphrase": "Passphrase",
  "unlock.go": "Unlock",

  "home.coin": "Bitcoin",
  "home.asset": "Dollars",
  "home.pending": "pending",
  "home.rgbcoin": "Bitcoin held for RGB outputs",
  "home.assetid": "Contract",
  "home.noasset": "No {asset} contract is configured on this node yet.",

  "receive.title": "Receive",
  "receive.btc": "Your {coin} address",
  "receive.rgb": "Receive {asset}",
  "receive.rgb.body": "A blinded invoice hides which output receives. Leave the amount empty to accept any amount.",
  "receive.rgb.amount": "Amount in {asset}, optional",
  "receive.rgb.go": "Make invoice",
  "receive.rgb.prepare": "Prepare RGB outputs",
  "receive.rgb.prepare.body": "Uses a little of the {coin} held for RGB to create outputs that can receive {asset}.",
  "receive.copy": "Copy",
  "receive.copied": "Copied",
  "receive.explorer": "See on the explorer",

  "send.title": "Send",
  "send.what": "What to send",
  "send.kind.btc": "{coin}",
  "send.kind.rgb": "{asset}",
  "send.to.btc": "To a {network} address",
  "send.to.rgb": "RGB invoice",
  "send.amount.btc": "Amount in {coin}",
  "send.amount.rgb": "Amount in {asset}",
  "send.review": "Review",

  "review.title": "Check before you sign",
  "review.to": "To",
  "review.type": "Type",
  "review.amount": "Amount",
  "review.fee": "Network fee",
  "review.total": "Total",
  "review.asset": "Contract",
  "review.proxy": "Proof goes through",
  "review.network": "Network",
  "review.gate": "Checked by",
  "review.gate.adapter": "interim gate until the governance gate merges",
  "review.irreversible": "Can't be undone.",
  "review.irreversible.body": "Once signed and broadcast, this payment can't be cancelled or reversed.",
  "review.confirm": "Sign and send",
  "review.cancel": "Cancel",
  "review.expires": "This preview expires in 5 minutes.",

  "result.sent": "Sent",
  "result.sent.body": "Broadcast on {network}. It confirms in the next blocks.",
  "result.failed": "Not sent",
  "result.txid": "Transaction",
  "result.home": "Done",

  "history.title": "History",
  "history.empty": "Nothing yet.",
  "history.attempts": "Send attempts",
  "history.status.sent": "sent",
  "history.status.refused": "refused",
  "history.status.failed": "failed",
  "history.status.unknown": "unknown, check before retrying",

  "about.title": "About this wallet",
  "about.body": "This web wallet is the screen over YOUR OWN Passbook node. It talks only to this node, through its signed API: every request carries your operator session's signature. The node keeps your seed encrypted and does the signing. The Passbook platform never holds your keys.",
  "about.network": "Network",
  "about.test": "{network} is a test network. Its coins and its {asset} have no value.",
  "about.endpoints": "Endpoints",
  "about.modules": "Wallet modules (exact versions)",
  "about.gate": "Send gate",
  "about.built": "Built: create/restore with an encrypted seed, backup check, balances, receive, send with a decoded preview and a gate. Designed, not built: Lightning sends, hardware signers."
}
