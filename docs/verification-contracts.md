# Verification contract cards

These cards summarize a small number of high-value semantic propositions already
present in Gatefold's claim model and comparison/evaluation contracts.

They do not create a new scoring layer. Gatefold remains evidence-first and
descriptive except where an explicit evaluation contract supplies criteria.

## VC-G-01 — Every emitted statement is evidence-backed

**Verification proposition**

A Gatefold statement about an input must carry provenance and resolvable
evidence that supports that statement.

**Owner**

Gatefold claim / result contract.

**Source**

`docs/claim-model.md`, result schemas, and architecture.

**Required evidence**

- stable rule/fact identity;
- evidence pointer to the named input;
- provenance / transformation chain;
- schema validation of the emitted result.

**Allowed variation**

Natural-language rendering and internal rule implementation.

**Forbidden**

- schema-valid-looking claim with no evidence;
- evidence pointer that does not resolve;
- formatter invents facts absent from the result model.

**Observation points**

- unit: rule/fact generation and validators;
- boundary: input readers preserve the raw document needed for resolution;
- system: CLI JSON output validates and every citation resolves.

**Failure routing**

Rule/application layer, validator, or formatter depending on where unsupported
content entered.

---

## VC-G-02 — Difference is not judgement or causality

**Verification proposition**

Comparison may state that A and B differ, but must not turn a difference into a
quality ranking, causal attribution, or recommendation unless a separate
explicit evaluation contract authorizes a criterion verdict.

**Owner**

Gatefold comparison semantics.

**Source**

`docs/rules.md`, `docs/architecture.md`, v0.9 scope; issue #76.

**Required evidence**

- A/B direction;
- compared fields and identities;
- evidence for each side;
- explicit separation of configuration, execution, audit, and evaluation
  lanes.

**Allowed variation**

Presentation and ordering within the stable output contract.

**Forbidden**

- "A is better";
- "configuration X caused outcome Y";
- inferred runtime use from static effectiveness;
- aggregate quality score from descriptive differences.

**Observation points**

- unit: compare rules / cell diff;
- integration: linked pfl + yuurei inputs;
- system: `compare-cells` on real A/B runs.

**Failure routing**

Comparison application layer or human formatter.

---

## VC-G-03 — Unknown is preserved, never promoted

**Verification proposition**

Missing, partial, corrupt, unverifiable, contradictory, or unrecorded evidence
must remain distinguishable from a verified value and from "no difference".

**Owner**

Gatefold audit / comparison semantics.

**Source**

README, v0.8/v0.9 scope, issues #71, #76, #79, #80.

**Required evidence**

- state and completeness markers;
- digest verification where stored bytes are cited;
- explicit unavailable / unverifiable / inconsistent states.

**Allowed variation**

Diagnostic details and human phrasing.

**Forbidden**

- missing observation -> unchanged configuration;
- partial record -> complete;
- unverifiable -> pass/fail;
- corrupt bytes -> accepted evidence.

**Observation points**

- unit: audit and cell validators;
- input boundary: bounded readers and digest verification;
- system: hostile / missing / partial run fixtures and real cell reports.

**Failure routing**

Input reader, audit normalization, comparison, or schema validation.

---

## VC-G-04 — Comparability must be demonstrated

**Verification proposition**

Gatefold compares only subjects whose required identity/provenance conditions
are verified. Identity equality is evidence of association, not proof that all
conditions are equivalent.

**Owner**

Gatefold comparability contract.

**Source**

`docs/architecture.md`, v0.5/v0.9 scope, issues #76 and #83.

**Required evidence**

- task/runtime/requested conditions required by the comparison mode;
- cell / snapshot binding for cell reports;
- verified source-project identity when comparing real prepared cells;
- explicit caveat or rejection when required identity is unavailable.

**Allowed variation**

Future additive provenance fields.

**Forbidden**

- path-based guessing across temporary cells;
- matching on `cell_id` alone;
- treating equal requested digests as proof of equal observed execution;
- comparing different verified source projects as one subject.

**Observation points**

- unit: comparability functions;
- integration: yuurei/pfl contract readers;
- system: real two-cell A/B flow after yuurei #214 + pfl #217.

**Failure routing**

Comparability policy or upstream provenance contract.

---

## VC-G-05 — Evaluation verdicts come from declared criteria and verified evidence

**Verification proposition**

`evaluate-run` may emit pass/fail/unknown only for explicitly declared
criteria and only from verified allowed evidence. Missing, truncated,
contradictory, or unverifiable evidence yields unknown rather than an invented
verdict.

**Owner**

Gatefold evaluation contract.

**Source**

v0.7 scope and README.

**Required evidence**

- criterion identity and declaration;
- verified run subject binding;
- permitted evidence source;
- explicit unknown path;
- no aggregate score.

**Allowed variation**

Criterion wording and evaluator implementation within the versioned contract.

**Forbidden**

- derive criterion from implementation;
- use agent prose/logs as undeclared truth;
- missing evidence -> pass;
- overall winner/score from criterion verdicts.

**Observation points**

- unit: evaluation resolution and check-report binding;
- integration: seeded-run reader + criterion spec + external report;
- system: CLI evaluate/compare-evaluations over retained runs.

**Failure routing**

Criterion parser, evidence binding, evaluator, or output validator.

---

## Initial inventory

- **VC-G-01:** rules/validators internally, raw input readers at the boundary,
  and CLI schema/citation checks at the system boundary. Coverage is strong.
- **VC-G-02:** comparison rules internally, cell lanes at the boundary, and
  real A/B reporting at the system boundary. Coverage is strong.
- **VC-G-03:** audit/cell state models internally, digest and bounded readers at
  the boundary, and partial/corrupt fixtures at the outer boundary. Coverage is
  strong.
- **VC-G-04:** comparability policy internally and upstream bindings at the
  boundary. The real pair remains blocked by the dependencies tracked in #83.
- **VC-G-05:** evaluator logic internally, subject binding at the boundary, and
  seeded-run evaluation at the system boundary. Coverage is strong.

## Review rule

A Gatefold check should answer at least one of these questions:

1. What proposition does the evidence establish?
2. What state should be returned when the evidence cannot establish it?
3. Does this layer compare facts, or is it authorized to judge a declared
   criterion?
4. Would a different correct upstream implementation still satisfy the same
   proposition?

If a check cannot answer any of them, it is probably implementation coupling or
maintenance support rather than a semantic contract.

## Concrete evidence inventory

Gatefold is the clearest example of an existing suite already organized around
semantic distinctions. Most of the work here is naming and indexing that fact.

- **VC-G-01:** `test/rules.test.ts` requires evidence, provenance, and stable
  rule ids. `test/schema.test.ts` rejects claims without evidence, and E2E
  resolves emitted evidence pointers. Strong across generation, schema, and
  process boundaries.
- **VC-G-02:** `test/rules.test.ts` checks neutral phrasing such as "never as
  improvement" and avoids proving harness change from rewording.
  `test/audit.test.ts` and `test/cell.test.ts` keep verdict vocabulary out
  of descriptive reports. Strong.
- **VC-G-03:** `test/audit.test.ts` covers unverifiable, inconsistent,
  not-recorded, and partial cases. `test/cell.test.ts` verifies that missing
  observation and observer failure never become "no configuration change".
  E2E keeps truncated or unrecorded artifacts as caveats. Very strong.
- **VC-G-04:** compare/trace/run tests reject mismatched subjects, and
  `test/cell.test.ts` validates cell/export binding and withholds comparison
  when a side is unbound. Since #83, `cell-real-pair-a`/`cell-real-pair-b`
  and `cell-real-other-source` exercise the real two-cell source-project
  identity path end to end: a shared verified `sourceProject` admits a pair
  whose cell-local `project.id` values differ, differing verified sources
  reject, and unverifiable provenance yields `config-unavailable` rather
  than a match or a rejection. Strong.
- **VC-G-05:** `test/evaluation.test.ts` covers declared criteria, subject
  binding, unknown on rejected/missing/conflicting reports, and explicitly
  asserts that unverifiable evidence never produces a pass. E2E covers v6/v7
  CLI paths. Strong.

### Gaps / active work

No new generic Gatefold verification issue is needed.

The one material system-level gap — demonstrating `compare-cells` on a real
pair of independently prepared cells — was **#83**, now implemented: real
yuurei #214 + pfl #217 outputs exist as `cell-real-pair-a`/
`cell-real-pair-b`/`cell-real-other-source`, and the same-source pair is
accepted on its verified declared identity while the different-source pair
rejects. What remains inherently unverifiable inside Gatefold is that the
three repositories keep the identity semantics aligned across future
versions — the contract documents record that dependency.

### Candidate de-emphasis during future test cleanup

Gatefold has many valuable adversarial and schema tests. During cleanup, avoid
counting multiple fixtures that exercise the same semantic transition as
independent contracts. A better inventory unit is:

`verification proposition × distinct failure mode / observation boundary`.

For example, several malformed-input cases support VC-G-03, but the unique
evidence classes are more useful to track: missing, partial, corrupt,
contradictory, unbound, and verified.
