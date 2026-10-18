// Prints the x-only public key of a secret key file (the check node's operator key), so the platform can be told
// which operator's check bills it accepts before the check node starts (infra/service-provider.sh, bill at close).
import { readFileSync } from 'node:fs'
import { keyPairFromSecret } from '../src/core/crypto.js'

const file = process.argv[2]
if (!file) { console.error('usage: service-provider-operator-pk.ts <secret file>'); process.exit(2) }
console.log(keyPairFromSecret(readFileSync(file, 'utf8').trim()).pubkey)
