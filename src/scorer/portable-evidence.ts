// Portable verification of sandbox-signed results. Software evidence trusts the scorer host.
import { hashObject, isHex, verifyObject, type Hex } from '../core/crypto.js'
import { schemaErrors } from '../core/schema.js'
import type { Bundle } from '../sandbox/types.js'
import { bundleLoan, scoredLoanProblems } from './bundle-terms.js'
import { declarationValid, descriptorCore, selfSignatureValid } from './descriptor.js'
import { PORTABLE_CONTRACT, PORTABLE_RESULT_SCHEMA } from './portable-contract.js'
import type { PassbookCheckOutputs, ScoredLoan, ScorerOutcome } from './types.js'
export interface PortableScorerKey { public_key_hex: Hex; development?: boolean }
export function portableScorerChecks(outcome: ScorerOutcome, x: { borrower_pk: Hex; lender_pk: Hex; negotiation_id: string; loan?: ScoredLoan; bundle?: Bundle; image_digest: string; evidenceKeys: PortableScorerKey[]; allowDevelopment?: boolean; consent_hash?: Hex; operator_pk?: Hex; descriptor?: ScorerOutcome['descriptor'] }) {
 const ticks: {id:string;ok:boolean;detail:string}[]=[]
 const tick=(id:string,ok:boolean,detail:string)=>ticks.push({id,ok,detail})
 let outputs: PassbookCheckOutputs|null=null
 if (outcome?.kind !== 'passbook-signed') { tick('provider',false,'portable verification requires a sandbox-signed result; external evidence needs its installed verifier');return {ticks,outputs} }
 const d=outcome.descriptor,r=outcome.result
 const errors=schemaErrors(r,PORTABLE_RESULT_SCHEMA)
 tick('output-schema',errors.length===0,errors.length?errors.slice(0,3).join('; '):'exact generic scoring contract fields')
 if(errors.length)return {ticks,outputs}
 tick('contract',d.contract_hash===hashObject(PORTABLE_CONTRACT),'the locally held scoring contract')
 const pinned=x.evidenceKeys.some(k=>k.public_key_hex===d.enclave_pubkey&&(!k.development||x.allowDevelopment===true))
 const offered=!!x.descriptor&&hashObject(descriptorCore(x.descriptor))===hashObject(descriptorCore(d))&&selfSignatureValid(x.descriptor)&&declarationValid(x.descriptor)&&x.descriptor.operator_declaration?.operator_pk===x.operator_pk
 tick('scorer-key',isHex(d.enclave_pubkey,32)&&selfSignatureValid(d)&&(x.evidenceKeys.length ? pinned : offered),'signer pinned locally or declared by the explicitly accepted offer operator')
 tick('offered-release',d.code_measurement===x.image_digest,'the offer pinned this code measurement')
 tick('result-scorer',r.scorer.provider===d.provider&&r.scorer.scorer_id===d.scorer_id&&r.scorer.code_measurement===d.code_measurement&&r.scorer.contract_hash===d.contract_hash&&r.scorer.enclave_pubkey===d.enclave_pubkey&&r.scorer.trust==='dev-inprocess'&&d.trust==='dev-inprocess','result names the verified local scorer and development trust ceiling')
 tick('signature',verifyObject(r,d.enclave_pubkey??''),'result signed by the pinned scorer')
 const record=r.evidence.run_record
 tick('run-record-signature',verifyObject(record,d.enclave_pubkey??'')&&record.sandbox_pk===d.enclave_pubkey&&record.bundle_hash===r.outputs.bundle_hash&&record.public_result_sha256===hashObject(r.evidence.investigation),'signed run record bound to the output bundle')
 tick('run-budgets',hashObject(record.budgets)===hashObject(PORTABLE_CONTRACT.budgets)&&record.tool_calls.length<=record.budgets.max_tool_calls&&record.model_calls.length<=record.budgets.max_model_calls&&record.decision_attempts.length<=record.budgets.max_decision_attempts,'signed run uses this contract budgets and stays within call limits')
 tick('binding',r.outputs.borrower_pk===x.borrower_pk&&r.outputs.lender_pk===x.lender_pk&&r.outputs.purpose_id===x.negotiation_id,'for this borrower, lender and negotiation')
 if(x.consent_hash)tick('consent',r.consent_hash===x.consent_hash,'result names the borrower consent')
 if(x.bundle)tick('bundle',r.outputs.bundle_hash===hashObject(x.bundle),'result names the original bundle')
 const loan=x.loan??(x.bundle?bundleLoan(x.bundle):undefined)
 if(loan){const issues=scoredLoanProblems(r.outputs,loan);tick('scored-loan',issues.length===0,issues.length?issues.join('; '):'exact agreed loan')}
 outputs=r.outputs
 return {ticks,outputs}
}

export function evidenceKeysFromJson(raw: unknown): PortableScorerKey[] {
 const keys=Array.isArray(raw)?raw:(raw as {keys?:unknown})?.keys
 if(!Array.isArray(keys))return []
 return keys.filter((k): k is PortableScorerKey => !!k && isHex(k.public_key_hex,32) && (k.development===undefined || typeof k.development==='boolean'))
}
