import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { keyPairFromLabel, verifyObject } from '../src/core/crypto.js'
import { attest } from '../src/sandbox/broker.js'
import { PUBLISHED_QVAC_MODELS, observedRunMaterials, publishedRunMaterials, qvacModelFile } from '../src/sandbox/published-materials.js'

const definitions = { systemPrompt: 'Published prompt', toolDefinitions: { month_table: {} } }

describe('published execution materials', () => {
  it('lets lenders pin local models without loading or possessing their files', async () => {
    for (const engine of ['qvac-sdk:qwen3-1.7b', 'qvac-sdk:qwen3-4b'] as const) {
      const materials = await publishedRunMaterials(engine, definitions)
      assert.equal(materials.model_file_sha256, PUBLISHED_QVAC_MODELS[engine].sha256)
      assert.equal(materials.model_material_kind, 'file')
    }
    const unknown = await publishedRunMaterials('qvac-http:unpublished-model', definitions)
    assert.equal(unknown.model_file_sha256, null)
    assert.equal(unknown.model_material_kind, 'unavailable')
    const trusted = await publishedRunMaterials('qvac-http:custom-model', definitions, { 'qvac-http:custom-model': { sha256: 'ab'.repeat(32), kind: 'file' } })
    assert.equal(trusted.model_file_sha256, 'ab'.repeat(32))
  })
  it('preserves the Snap cache root, rejects ambiguous files and measures actual bytes separately', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'passbook-cache-'))
    try {
      const modelDir = join(dir, '.qvac', 'models')
      await mkdir(modelDir, { recursive: true })
      const first = join(modelDir, 'prefix_Qwen3-1.7B-Q4_0.gguf')
      await writeFile(first, 'different, deliberately untrusted bytes')
      assert.equal(await qvacModelFile('qvac-sdk:qwen3-1.7b', { SNAP_USER_COMMON: dir }), first)
      const actual = await observedRunMaterials('qvac-sdk:qwen3-1.7b', definitions, { env: { SNAP_USER_COMMON: dir } })
      const expected = await publishedRunMaterials('qvac-sdk:qwen3-1.7b', definitions)
      assert.notEqual(actual.model_file_sha256, expected.model_file_sha256)
      await writeFile(join(modelDir, 'another_Qwen3-1.7B-Q4_0.gguf'), 'more ambiguous bytes')
      assert.equal(await qvacModelFile('qvac-sdk:qwen3-1.7b', { SNAP_USER_COMMON: dir }), undefined)
      assert.equal(await qvacModelFile('qvac-sdk:qwen3-1.7b', { SNAP_USER_COMMON: dir, QVAC_MODEL_FILE: first }), first)
    } finally { await rm(dir, { recursive: true, force: true }) }
  })
  it('labels the platform declaration separately from software run evidence and hardware attestation', () => {
    const key = keyPairFromLabel('platform-record-test')
    const statement = attest(key, keyPairFromLabel('sandbox-record-test').pubkey, 'in-process')
    assert.equal(statement.assurance, 'platform-declaration-only')
    assert.equal(statement.run_record, 'sandbox-signed-per-run')
    assert.equal(verifyObject(statement, key.pubkey), true)
  })
})
