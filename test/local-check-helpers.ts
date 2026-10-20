import type { Event, Filter } from 'nostr-tools'
import type { CheckTransport } from '../src/checknode/borrower-check.js'
import type { MemoryHub } from '../src/checknode/bus.js'
import { SandboxCheckEngine, type CheckEngine } from '../src/checknode/engine.js'
import { SandboxScorerEngine } from '../src/scorer/providers.js'
import { PlaybookReasoner } from '../src/ai/playbook-reasoner.js'
import { investigationFixture } from '../src/sandbox/investigation-fixtures.js'
import { signObject } from '../src/core/crypto.js'
import type { PassbookCheckOutputs } from '../src/scorer/types.js'
import { NOW, SOURCE } from './checknode-helpers.js'
export interface LocalCheckOptions { outputs?: (o:PassbookCheckOutputs)=>unknown; fail?:boolean }
export function localCheckEngine(o: LocalCheckOptions={}, f=investigationFixture('fatima')) {
 const calls:string[]=[]
 const engine=new SandboxCheckEngine(new SandboxScorerEngine({provider:'container',key:f.key,chain:f.chain,reasoner:new PlaybookReasoner(),blocksPerMonth:30,oraclePk:f.oracle.pubkey,measurement:SOURCE,now:()=>NOW}),{label:'local sandbox (development trust)',fallback:false,modelHash:null})
 const wrapped: CheckEngine={label:engine.label,fallback:false,descriptor:()=>engine.descriptor(),release:()=>engine.release(),run:async(...args)=>{
   calls.push('check'); if(o.fail)throw new Error('TEST_ENGINE_REFUSED')
   const result=await engine.run(...args)
   if(o.outputs&&result.kind==='passbook-signed')return {...result,result:signObject({...result.result,outputs:o.outputs(result.result.outputs)},f.key.secretKey)} as never
   return result
 }}
 return {engine:wrapped,calls}
}
const matches = (e: Event, f: Filter) => (!f.kinds || f.kinds.includes(e.kind)) && (!f.authors || f.authors.includes(e.pubkey)) && (!f['#p'] || e.tags.some((t) => t[0] === 'p' && f['#p']!.includes(t[1]))) && (f.since === undefined || e.created_at >= f.since)

/** The phone's relay connection, over the in-memory relay. */
export function memoryTransport(hub: MemoryHub): CheckTransport {
  return {
    publish: async (e) => { hub.publish(e) },
    subscribe: (filter, onEvent) => {
      for (const e of [...hub.events]) if (matches(e, filter)) onEvent(e)
      return hub.subscribe((e) => { if (matches(e, filter)) onEvent(e) })
    },
  }
}
