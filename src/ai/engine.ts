// Which model answers. PASSBOOK_AI picks the primary reasoner; whatever it is,
// GuardedReasoner validates every output and falls back to the rules engine.
//   unset | rules   the rules engine only
//   qvac            QVAC SDK in this process (qvac-sdk-reasoner.ts)
//   qvac-http       a QVAC OpenAI-compatible server (qvac-reasoner.ts)
// No cloud API is ever an option.

import { QvacReasoner } from './qvac-reasoner.js'
import { QvacSdkReasoner } from './qvac-sdk-reasoner.js'
import { RuleReasoner } from './rule-reasoner.js'
import type { Reasoner } from './types.js'

export function primaryReasonerFromEnv(): Reasoner {
  switch (process.env.PASSBOOK_AI ?? 'rules') {
    case 'rules':
      return new RuleReasoner()
    case 'qvac':
      return QvacSdkReasoner.fromEnv()
    case 'qvac-http':
      return QvacReasoner.fromEnv()
    default:
      throw new Error(`PASSBOOK_AI must be rules, qvac or qvac-http, not ${process.env.PASSBOOK_AI}`)
  }
}
