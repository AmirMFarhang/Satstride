// Integration smoke for a real container and already seeded RGB wallets.
// It never locks collateral, disburses a loan, pays an invoice or mines a block.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { BorrowerAgent } from '../src/agents/borrower.js'
import { LEGACY_L1_POLICY } from '../src/agents/lender.js'
import { PlatformClient } from '../src/agents/platform-client.js'
import { RuleReasoner } from '../src/ai/rule-reasoner.js'
import { BitcoindChain } from '../src/chain/bitcoind.js'
import { hashObject, randomKeyPair, verifyObject } from '../src/core/crypto.js'
import { KIND } from '../src/market/kinds.js'
import { encryptTo, publicJson } from '../src/market/messages.js'
import { Store } from '../src/registry/store.js'
import { RemoteSandbox } from '../src/sandbox/broker.js'
import { checkRunDirectory } from '../src/sandbox/check-run.js'
import { INVESTIGATION_BUDGETS, INVESTIGATION_SYSTEM_PROMPT, INVESTIGATION_TOOL_DEFINITIONS } from '../src/sandbox/investigate.js'
import { investigationAccepted } from '../src/sandbox/investigation-policy.js'
import { PUBLISHED_QVAC_MODELS, publishedRunMaterials } from '../src/sandbox/published-materials.js'
import { verifyRunRecord, writeRunArtifact, type RunArtifact } from '../src/sandbox/run-record.js'
import { createApp } from '../src/server/app.js'
import { loadSeed, openParty, partyKey } from '../src/wallet/party.js'
import { loadPlatformKey } from '../src/wallet/platform-key.js'
import { readState } from '../src/wallet/state.js'

const container = process.env.PASSBOOK_SMOKE_CONTAINER ?? 'passbook-records-smoke'
const sandboxUrl = process.env.SANDBOX_URL ?? 'http://127.0.0.1:4210'
const imageDigest = process.env.SANDBOX_IMAGE_DIGEST
assert.match(imageDigest ?? '', /^sha256:[0-9a-f]{64}$/, 'supply the measured image ID')
const source = execFileSync('git', ['rev-parse', '--verify', process.env.PASSBOOK_CONTAINER_SOURCE ?? 'HEAD'], { encoding: 'utf8' }).trim()
execFileSync('git', ['diff', '--exit-code', source, '--', 'src', 'package.json', 'package-lock.json', 'tsconfig.json', 'infra/Dockerfile.sandbox', '.dockerignore'])
const docker = (args: string[]) => execFileSync('docker', args, { encoding: 'utf8' }).trim()
const inspected = JSON.parse(docker(['inspect', container]))[0]
assert.equal(inspected.Image, imageDigest)
assert.equal(inspected.Config.Labels['org.opencontainers.image.revision'], source)
assert.equal(inspected.HostConfig.ReadonlyRootfs, true)
assert.equal(docker(['exec', container, 'id', '-u']), '1000')
assert.equal(JSON.parse(docker(['network', 'inspect', inspected.HostConfig.NetworkMode]))[0].Driver, 'bridge')

const state = readState()
const platformKey = loadPlatformKey()!
assert.equal(platformKey.pubkey, state.platform_pk)
const chain = BitcoindChain.fromEnv()
const beforeHeight = await chain.getHeight()
const borrower = await openParty('borrower')
const app = createApp({ platformKey, store: new Store(), chain, sandbox: new RemoteSandbox(sandboxUrl), reasoner: new RuleReasoner(), initialPriceCents: 10_000_000, blocksPerMonth: 30, relays: [] })
let agent: BorrowerAgent | undefined
try {
  const port = await app.api.listen(0, '127.0.0.1')
  const client = new PlatformClient(`http://127.0.0.1:${port}`)
  agent = new BorrowerAgent({ party: borrower, platform: client, chain, reasoner: new RuleReasoner(), assetId: state.asset.id, inflows: state.borrower_inflows, mine: async () => { throw new Error('smoke must not mine') } })
  const p = LEGACY_L1_POLICY
  const lenderKey = partyKey(loadSeed('lender1'))
  const event = publicJson(lenderKey, KIND.OFFER, { asset_id: state.asset.id, min: p.min, max: p.max, apr_bps: p.apr_bps, term_blocks: p.term_blocks, grace_blocks: p.grace_blocks, ltv_ladder_bps: p.ltv_ladder_bps, requirements: p.requirements, expires_height: beforeHeight + 1000 }, [['d', p.d]])
  const offer = app.orderbook.ingest(event).offer!
  assert.ok(offer, 'real lender key signed the test offer')
  const bundle = await agent.buildSandboxBundle(offer, 600_000_000)
  const published = await client.sandboxPubkey()
  assert.ok(verifyObject(published.attestation, platformKey.pubkey))
  assert.equal(published.attestation.image_digest, imageDigest)
  assert.equal(published.attestation.assurance, 'platform-declaration-only')
  const plaintext = JSON.stringify(bundle)
  const ciphertext = encryptTo(borrower.key, published.sandbox_pk, plaintext)
  const started = performance.now()
  const result = await client.submitToSandbox(borrower.key.pubkey, ciphertext)
  const roundTripMs = Math.round(performance.now() - started)
  assert.equal(result.bundle_hash, hashObject(bundle))
  assert.ok(verifyObject(result, published.sandbox_pk))
  assert.ok(verifyObject(result.lender_result!, published.sandbox_pk))
  assert.ok(result.checks.every((check) => check.ok), JSON.stringify(result.checks))
  assert.equal(result.investigation?.status, 'not_run')
  assert.equal(investigationAccepted('required', result.investigation), false)
  assert.equal(investigationAccepted('optional', result.investigation), true)
  const materials = await publishedRunMaterials('rules', { systemPrompt: INVESTIGATION_SYSTEM_PROMPT, toolDefinitions: INVESTIGATION_TOOL_DEFINITIONS })
  const verified = verifyRunRecord(result.run_record!, materials, published.sandbox_pk, INVESTIGATION_BUDGETS, result.investigation)
  assert.ok(verified.ok, JSON.stringify(verified.errors))
  assert.equal(result.run_record!.image_digest, imageDigest)
  assert.equal(result.run_record!.network_mode, 'bridge')
  assert.equal(result.run_record!.materials.model_material_kind, 'deterministic-code')
  const lenderView = JSON.stringify(result.lender_result)
  for (const name of ['summary', 'history', 'candidate_inflows', 'history_proof', 'history_metrics', 'income_tiers', 'memo']) assert.ok(!lenderView.includes(`"${name}"`), `private ${name} left the box`)
  for (const row of bundle.history) { assert.ok(!lenderView.includes(row.txid)); assert.ok(!lenderView.includes(row.counterparty_pk)) }
  const anchors = []
  for (const row of state.borrower_inflows) {
    const tx = await chain.getTx(row.txid)
    assert.ok(tx?.height && tx.height === row.height)
    const native = borrower.rgb.transfers(state.asset.id).find((transfer) => transfer.txid === row.txid)
    assert.equal(native?.status, 'Settled')
    anchors.push({ txid: row.txid, height: tx.height, native_status: native!.status })
  }
  const wrong = randomKeyPair()
  const denied = await fetch(`${sandboxUrl}/run`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sender_pk: wrong.pubkey, ciphertext: encryptTo(wrong, published.sandbox_pk, plaintext) }) })
  assert.equal(denied.status, 400)
  const pinnedInside = JSON.parse(docker(['exec', container, 'node', '--import', 'tsx', '--input-type=module', '-e', 'import { PUBLISHED_QVAC_MODELS } from "./src/sandbox/published-materials.ts"; console.log(JSON.stringify(PUBLISHED_QVAC_MODELS))']))
  assert.deepEqual(pinnedInside, PUBLISHED_QVAC_MODELS)
  const privateDir = resolve('data/container-private-artifacts')
  await mkdir(privateDir, { recursive: true, mode: 0o700 })
  // This Docker/containerd version cannot docker-cp the tmpfs. Read as the
  // container owner and keep the financial JSON inside this process/files.
  const exported = JSON.parse(docker(['exec', container, 'node', '--input-type=module', '-e', 'import fs from "node:fs"; const root="/tmp/passbook-run-records"; console.log(JSON.stringify(fs.readdirSync(root).map(id=>({v:1,id,private_mode:(fs.statSync(`${root}/${id}/private-evidence.json`).mode&511).toString(8),record:JSON.parse(fs.readFileSync(`${root}/${id}/run-record.json`,"utf8")),private_evidence:JSON.parse(fs.readFileSync(`${root}/${id}/private-evidence.json`,"utf8"))}))))'])) as (RunArtifact & { id: string; private_mode: string })[]
  const saved = exported.find((run) => run.record.private_evidence_sha256 === result.run_record!.private_evidence_sha256)!
  assert.ok(saved)
  assert.equal(saved.private_mode, '600')
  const runDir = join(privateDir, saved.id)
  await writeRunArtifact(runDir, saved)
  const offline = await checkRunDirectory(runDir, { materials, budgets: INVESTIGATION_BUDGETS, sandboxPk: published.sandbox_pk })
  assert.ok(offline.ok, JSON.stringify(offline.errors))
  assert.equal(await chain.getHeight(), beforeHeight, 'sandbox smoke did not mine')
  const report = {
    generated_at: new Date().toISOString(), source, source_tree_verified: true,
    scope: 'Real Docker/rules sandbox; real seeded RGB wallet transfers and Bitcoin anchors. No QVAC inference, new loan, native reconciliation, TEE or external provider deployment.',
    image_id: imageDigest, image_revision_label_verified: true, docker_context: 'Committed .dockerignore whitelist: package.json, package-lock.json, tsconfig.json, src only.', network_mode: result.run_record!.network_mode, readonly_rootfs: true, uid: 1000,
    rpc_port: 18473, sandbox_port: 4210, chain: 'bitcoind regtest', height_before: beforeHeight, height_after: await chain.getHeight(),
    asset_id: state.asset.id, rgb_anchors_checked: anchors,
    encrypted_bytes: ciphertext.length, encrypted_round_trip_ms: roundTripMs,
    result_signature_verified: true, lender_signature_verified: true, platform_declaration_verified: true, declared_image_matches_running_image: true,
    signed_run_record_verified: verified, offline_copied_container_artifact: offline,
    run_record: result.run_record, public_investigation: result.investigation, platform_declaration: published.attestation, private_artifact_mode: saved.private_mode,
    investigation_status: result.investigation?.status, required_ai_offer_declines: true, optional_investigation_policy_passes: true,
    checks: result.checks, materials, qvac_pins_present_in_image: pinnedInside,
    lender_private_fields_absent: true, wrong_sender_http_status: denied.status,
    limits: ['Rules mode did not run an investigation.', 'Absent native history proof is labelled unknown; the explicit legacy offer permits it.', 'Model hashes pinned in the image do not demonstrate model execution.', 'The image/network declarations are signed software records, not hardware attestations.'],
  }
  await writeFile(process.env.PASSBOOK_CONTAINER_REPORT ?? 'docs/CONTAINER-RUN-RECORD.json', JSON.stringify(report, null, 2) + '\n')
  console.log(JSON.stringify({ ok: true, round_trip_ms: roundTripMs, image_id: imageDigest, anchors_checked: anchors.length, investigation: result.investigation?.status, record_verified: verified.ok, offline_verified: offline.ok }))
} finally {
  agent?.relay.close()
  borrower.close()
  await app.close()
}
