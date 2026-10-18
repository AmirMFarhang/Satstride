// Agent session keys. An agent never holds the node's money key: for each
// negotiation it gets a short-lived session key, granted and signed by the
// node, scoped to that negotiation and to a set of actions. Every request the
// agent makes to the gate is signed with it, and the Signer the agent uses for
// its negotiation messages refuses once the session is revoked or expired. The
// kill switch (`passbook agent stop`) revokes every session of the agent and
// freezes it at the gate; open loans keep their on-chain paths.

import { hashObject, isHex, randomKeyPair, signHash, signObject, verifyObject, type Hex, type KeyPair } from '../core/crypto.js'
import type { GovernedAction, Signer } from '../wallet/signer.js'
import type { GateStore } from './store.js'

export interface SessionGrant {
  v: 1
  domain: 'passbook-agent-session-v1'
  agent_id: string
  session_pk: Hex
  /** One negotiation (or loan id), and the actions the agent may ask for in it. */
  scope: { negotiation_id: Hex | null; actions: GovernedAction[] }
  issued_at: number
  expires_at: number
  node_pk: Hex
  sig: Hex
}

export interface AgentSession {
  grant: SessionGrant
  /** In memory only; never written to the store. */
  key: KeyPair
}

export class AgentStopped extends Error {
  constructor(readonly agentId: string, detail: string) {
    super(`agent ${agentId} is stopped: ${detail}`)
    this.name = 'AgentStopped'
  }
}

export function issueSession(store: GateStore, nodeKey: KeyPair, agentId: string, scope: SessionGrant['scope'], ttlSeconds: number, now = Math.floor(Date.now() / 1000)): AgentSession {
  return store.transact((s) => {
    const frozen = s.frozen[agentId]
    if (frozen) throw new AgentStopped(agentId, `frozen at ${new Date(frozen.at * 1000).toISOString()} by ${frozen.by}; no new sessions`)
    const key = randomKeyPair()
    const grant = signObject({ v: 1 as const, domain: 'passbook-agent-session-v1' as const, agent_id: agentId, session_pk: key.pubkey, scope, issued_at: now, expires_at: now + ttlSeconds, node_pk: nodeKey.pubkey }, nodeKey.secretKey)
    s.sessions.push({ grant })
    // keep the record small: drop sessions that ended over a day ago
    s.sessions = s.sessions.filter((r) => r.grant.expires_at > now - 86_400 || r.grant === grant)
    return { grant, key }
  })
}

/** Why a session cannot act now, or null when it can. Reads the store, so a stop from another process counts at once. */
export function sessionProblem(store: GateStore, grant: SessionGrant, nodePk: Hex, now = Math.floor(Date.now() / 1000)): string | null {
  if (!grant || grant.domain !== 'passbook-agent-session-v1' || grant.node_pk !== nodePk || !isHex(grant.session_pk, 32) || !verifyObject(grant, nodePk)) return 'SESSION_NOT_GRANTED_BY_THIS_NODE'
  if (now >= grant.expires_at) return 'SESSION_EXPIRED'
  const s = store.read()
  if (s.frozen[grant.agent_id]) return 'AGENT_STOPPED'
  const record = s.sessions.find((r) => r.grant.session_pk === grant.session_pk)
  if (!record) return 'SESSION_UNKNOWN'
  if (record.revoked_at !== undefined) return 'SESSION_REVOKED'
  return null
}

export function signRequest<T extends object>(session: AgentSession, request: T): T & { sig: Hex } {
  return signObject(request, session.key.secretKey)
}

/**
 * The Signer an agent uses for its negotiation messages: the party key, but
 * only while the session is live. After `passbook agent stop`, the agent's
 * next message is refused here, before anything is signed or sent.
 */
export class SessionSigner implements Signer {
  readonly kind = 'local-key' as const
  readonly pubkey: Hex
  constructor(private readonly party: KeyPair, private readonly session: AgentSession, private readonly store: GateStore, private readonly nodePk: Hex) {
    this.pubkey = party.pubkey
  }
  async signHash(hashHex: Hex): Promise<Hex> {
    const problem = sessionProblem(this.store, this.session.grant, this.nodePk)
    if (problem) throw new AgentStopped(this.session.grant.agent_id, `${problem}; message ${hashHex.slice(0, 12)}… refused`)
    return signHash(hashHex, this.party.secretKey)
  }
}

export const grantHash = (g: SessionGrant): Hex => hashObject(g)
