// The sandbox run materials a lender checks a credit check's signed run record against
// (src/sandbox/published-materials.ts publishedRunMaterials): hashes of the investigation's
// system prompt, its tool definitions and each published model, the deterministic ones from
// src/'s own reasoner sources. The phone cannot read those sources at run time, so this pins
// them into src/agent/run-materials.json at build time; __tests__/lender-parity.test.ts fails
// when src/ changes and the pin is stale (run `npm run materials` then).
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { PUBLISHED_QVAC_MODELS, publishedRunMaterials } from '../../../src/sandbox/published-materials.ts'
import { INVESTIGATION_BUDGETS, INVESTIGATION_SYSTEM_PROMPT, INVESTIGATION_TOOL_DEFINITIONS } from '../../../src/sandbox/investigate.ts'

export const PINNED_MODEL_IDS = ['rules', 'playbook:passbook-v1', ...Object.keys(PUBLISHED_QVAC_MODELS)]

export async function buildPin() {
  const defs = { systemPrompt: INVESTIGATION_SYSTEM_PROMPT, toolDefinitions: INVESTIGATION_TOOL_DEFINITIONS }
  const any = await publishedRunMaterials('', defs)
  const models = Object.fromEntries(await Promise.all(PINNED_MODEL_IDS.map(async (id) => [id, await publishedRunMaterials(id, defs)])))
  return { from: 'src/sandbox/published-materials.ts, src/sandbox/investigate.ts', budgets: { ...INVESTIGATION_BUDGETS }, system_prompt_sha256: any.system_prompt_sha256, tool_definitions_sha256: any.tool_definitions_sha256, models }
}

if (process.argv[1]?.endsWith('run-materials.ts')) {
  void (async () => {
    const out = join(__dirname, '../src/agent/run-materials.json')
    writeFileSync(out, `${JSON.stringify(await buildPin(), null, 2)}\n`)
    console.log(`wrote ${out}`)
  })()
}
