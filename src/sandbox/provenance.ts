// What produced a sandbox result, named the same way in the consent receipt,
// inside the sandbox, and in the term sheet: a container image whose sha256
// digest the platform attests (SANDBOX_URL), or the in-process sandbox. Both
// are dev-inprocess trust (src/scorer/trust.ts); neither is attested hardware.

import type { Hex } from '../core/crypto.js'

export type SandboxProvider = 'container' | 'in-process'

export const sandboxProvider = (imageDigest: string): SandboxProvider => (/^sha256:[0-9a-f]{64}$/.test(imageDigest) ? 'container' : 'in-process')

export const sandboxScorerId = (sandboxPk: Hex, imageDigest: string): string => `passbook-sandbox:${sandboxProvider(imageDigest)}:${sandboxPk.slice(0, 16)}`
