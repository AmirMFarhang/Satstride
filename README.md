# PassBook · Team Satstride

PassBook is a Bitcoin-backed lending platform. Borrowers and lenders discover
one another over Nostr, negotiate signed terms, approve transactions, settle a
test RGB asset and carry verifiable repayment history into their next loan.
The Android wallet keeps its keys on the phone. Team Satstride is the team name;
PassBook is the application. Current project contact: Amir Mohammad Farhang.

The default credit scorer runs in process. Local QVAC, a deterministic playbook
and fixed checks are selectable analysis modes (`PASSBOOK_AI=qvac`,
`qvac-http`, `playbook` or `rules`); their outputs identify which mode
ran. Models propose findings. Code grounds those findings, computes amounts and
enforces signing policy.

Compex is an optional external provider, supplied separately through a private
adapter package. Its runtime, API client, evidence formats and fixtures are not
included in this repository. PassBook's lending, wallet, escrow, governance,
compliance and repayment-history modules remain here.

## Product

| Surface | Purpose | Source |
| --- | --- | --- |
| Android wallet | Bitcoin/RGB custody, borrowing, lending, approval and recovery | [Mobile](apps/mobile) |
| Provider console | Offers, loans, fees, policy, logs and service observations | [Console](apps/console) |
| Local dashboard | Inspect a complete lending scenario on an isolated test chain | [Dashboard](web) |

The lending flow has six steps:

1. Discover signed offers and check providers over Nostr.
2. Negotiate principal, rate, collateral and term under each party's policy.
3. Consent to the evidence shared with the selected scorer.
4. Verify the signed result, its trust level and its binding to this loan.
5. Approve collateral and settlement transactions through the wallet policy gate.
6. Record repayment and release evidence for a portable history page.

A failed investigation, an unavailable external provider or an insufficient trust
level must remain visible. An in-process check does not claim hardware isolation
or software attestation from an external runtime.

## Built and designed

| Area | Implementation |
| --- | --- |
| Lending | Signed negotiation, term sheets, collateral vaults, repayment, release, margin/default paths and deterministic fees |
| Wallet | Tether WDK/RGB wallets, Android Bare worklet and owner-controlled signing |
| Analysis | Local investigator, evidence grounding, deterministic confirmer and signed run records |
| Scoring | Default in-process scorer, container scorer and an explicit optional provider interface |
| Marketplace | Check-node discovery, signed results, payment/billing protocols and loan binding |
| Governance | Signed policy versions, approvals, session budgets, transaction-bound tokens, stop and decision logs |
| History | Portable repayment pages and a verified repayment-based loan-to-value ladder |
| External Compex provider | Separate private package; not bundled or required for local scoring |
| Native joint-settlement research | Kept under [experiments](experiments); excluded from the default build and not silently activated |

The local investigator and playbook are **derived from Compex Fraud Desk
(Apache-2.0)**, including evidence-ID grounding, bounded investigations and cautious
confirmation. An implementation/import audit found no core Compex runtime in
that retained investigator. The derivation and third-party terms remain credited
in [NOTICE](NOTICE); removing the optional adapter does not erase that provenance.

## Build and check

Use Node **22 or 24**. The native RGB binding does not support Node 25.

```sh
git clone https://github.com/AmirMFarhang/Satstride.git
cd Satstride
npm ci
npm run check
```

On Linux, if dependencies were installed with lifecycle scripts disabled, build
the pinned native binding before running the suite:

```sh
npm rebuild @utexo/rgb-lib-linux-x64 --ignore-scripts=false
```

Mobile and legacy Android checks use their own dependencies:

```sh
(cd apps/mobile && npm ci && npm run check)
(cd apps/android && npm ci && npm run check)
```

The decoupled source passes **792 core tests (one skipped), 161 mobile tests
and 17 legacy Android tests**. The isolated chain regression passes 20 cases.
The original baseline was 825 core tests (five skipped): 44 provider-specific
cases moved with the private adapter, one provider-key case was replaced by
the package boundary, and eight generic cases were added. Mobile coverage
retains all 161 cases; four suites now use local signed results.

The chain checks cover RGB sends, collateral vaults, repayment, margin paths,
wallet policy and history. Optional Lightning suites require separate live
nodes and were not enabled in this acceptance run.

Chain integration needs an isolated Bitcoin, Electrum, RGB transport and Nostr
stack configured for the test environment:

```sh
npm run test:regtest
```

Lightning-specific cases require their explicit live-node configuration; a skip
does not prove that rail. Existing wallets, seeds, databases and test evidence
must be preserved. Use a separate Compose project, ports and state on a shared
machine.

## Local demonstration

Start with the local dashboard and the in-process scorer:

```sh
npm run dev
```

The demo's chain services must already be running. Select QVAC only after its
local model and endpoint are available; the deterministic playbook and rules are
separate modes. A model being loaded does not prove an investigation ran.

The asset used by a demonstration is independently issued **test USD, not USDT**.
Regtest time and seeded income histories are labelled demonstration inputs.
Historical screenshots and APKs were built before this extraction; they do not
prove the behavior of this rewritten source. Build an Android package from the
checked source rather than treating an earlier APK as a cleaned release.

## Provider boundary

PassBook owns consent, lender policy, normalized check outputs, loan binding,
release pins and the choice of scorer. An external provider is loaded only from
an explicitly installed and host-configured package. Its private wire formats and
verification implementation belong to that package. A remote offer or scorer
result cannot choose an arbitrary module to import.

In-process signing proves the configured local scorer key signed a result. Its
trust level stays `dev-inprocess`; the lender must explicitly allow that level.
A private external provider must satisfy its own evidence checks and the host's
lender/loan policy. It cannot silently upgrade an in-process result's trust.

## Read the implementation

| Question | Entry point |
| --- | --- |
| Who owns the phone keys? | [Worklet](apps/mobile/worklet), [borrower agent](apps/mobile/src/agent/borrower.ts) |
| How are terms bound? | [Negotiation](src/market/negotiate-engine.ts), [term sheet](src/market/termsheet.ts) |
| What constrains analysis? | [Investigator](src/sandbox/investigate.ts), [grounding](src/sandbox/grounding.ts), [playbook](src/ai/playbook-reasoner.ts) |
| What verifies a check? | [Providers](src/scorer/providers.ts), [verification](src/scorer/verify.ts), [contract](contracts/scoring.contract.json) |
| What controls signatures? | [Gate](src/governance/gate.ts), [policy](src/governance/policy.ts), [escrow](src/escrow/escrow.ts) |
| How is history verified? | [Portable document](src/registry/passbook-doc.ts), [ladder](src/registry/ladder.ts) |

Apache-2.0 applies to the authors' original source; third-party code, fonts,
dependencies and sanctions datasets retain their own terms. OpenSanctions-derived
data is CC BY-NC and is not relicensed by the source-code licence. See [NOTICE](NOTICE).
