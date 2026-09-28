# Gatefold evidence accessors for analyze — contract v1

This document defines the machine-readable evidence surface a separate
`analyze` contract-evaluation layer consumes. **Accessor contract version
1** covers the shipped result schemas v8 (`audit-run`), v9 (`report-cell`,
`compare-cells`), and v10 (`report-cells`).

Gatefold owns source validation, identity binding, completeness, audit
states, and descriptive comparison. `analyze` owns contract admission and
verdicts. Gatefold never emits `satisfied`/`violated`, never evaluates the
consumer's proposition, and never returns an analyze verdict; every value
below is a record of what the inputs declare or what a mechanical check
established.

## Supported surfaces

| Accessor surface | Command(s) | `schemaVersion` | `source.command` |
| --- | --- | --- | --- |
| Cell report | `report-cell` | `9` | `"report-cell"` |
| Cell pair comparison | `compare-cells` | `9` | `"compare-cells"` |
| Repeated-cell set | `report-cells` | `10` | `"report-cells"` |
| Run audit | `audit-run` | `8` | `"audit-run"` |

A consumer MUST:

- branch on `schemaVersion` and `source.command`; a document of any other
  version or command is not this contract's surface;
- ignore fields it does not know (Gatefold may add optional fields inside
  a version — for example `inputs.*.observationReason` was added to v9/v10
  under this contract); it MUST NOT treat an absent optional field as a
  recorded value (`observationReason` absent and `null` both leave the
  reason unrecorded);
- read eligibility inputs only from the locations named in the accessor
  table below — never from `statement`/`reason` prose, and never from a
  path guessed inside a run directory;
- resolve `evidence` pointers only against the listed inputs named by the
  `inputs` descriptors (the mapping below), and only for citation —
  admission decisions use the emitted states and descriptor fields.

## Locating the inputs

`inputs.run.label`, `inputs.before.label`, `inputs.after.label` (v9), and
`inputs.runs[i].label` (v10) carry the run-directory argument as supplied.
Evidence `source` names resolve to files under that directory:

| Evidence source (v9) | File |
| --- | --- |
| `trace` | `<label>/trace.json` |
| `manifest` | `<label>/artifacts.json` |
| `export` | `<label>/observation/export.json` (digest-verified bytes; `digest` repeats the manifest digest) |
| `patch` | `<label>/patch.diff` (manifest entry pointer + byte ranges) |
| `result` | `<label>/result.txt` (same convention) |
| `baselineManifest` | `<label>/baseline-manifest.json` (verified document) |
| `changes` | `<label>/changes.json` (verified document) |
| `evaluation` | the `--evaluation` document as supplied (`inputs.evaluation.label`) |

`compare-cells` prefixes each per-side source with `before`/`after`; v10
prefixes them with the run label (`run1Trace`, `run2Export`, …). Sources
whose named document was not verified cite the manifest entry instead, so
a pointer never resolves into bytes that failed verification.

## State vocabulary

Every accessor ultimately reports one of the v0.8/v0.9 states. A consumer
MUST keep them pairwise distinct:

| State | Consumer reading |
| --- | --- |
| `verified` | A mechanical check affirmatively established the fact (digest match, records agree). |
| `recorded` | A document declares this content; no independent check applies (configuration content, run records, computed differences, supplied verdicts). |
| `inconsistent` | Two well-formed records affirmatively contradict each other — present-but-disqualified evidence. |
| `unverifiable` | Evidence exists or was declared but cannot be checked — digest mismatch, truncation, unparsable bytes, missing key — present-but-disqualified. |
| `not-recorded` | The record was never produced — missing evidence, never a negative assertion. |

`completeness` is an independent dimension: `complete`, `partial`
(truncated or declared-partial records), `unknown`. A `verified` digest on
truncated bytes is `verified`/`partial` — stored bytes verified, coverage
not certified.

"Unbound" is not a state of its own: it is `association.export-binding`
∈ {`unverifiable`, `inconsistent`} — an export that exists and parses but
cannot be shown to describe this cell — versus `not-recorded`, where no
usable export exists at all.

## Case A accessors

Case A proposition (owned by analyze): *an observation failure must never
be represented as no configuration change.* The rows below are the
eligibility inputs. "Layer" names which upstream record the fact comes
from: **yuurei** trace observation, **pfl** export content, or
**gatefold** checks Gatefold performs.

| Accessor | Surface | Selector | Value | Layer | Failure/absent reading |
| --- | --- | --- | --- | --- | --- |
| `subject.run-id` | v9/v10 | `inputs.<subject>.runId` | string | yuurei (via Gatefold) | always present; the run's identity |
| `subject.cell-id` | v9/v10 | `inputs.<subject>.cellId` | string \| null | yuurei | `null` = not recorded; never "no cell" as a judgement |
| `subject.task` | v9/v10 | `inputs.<subject>.taskDigest` | string | yuurei | always present |
| `subject.profile` | v9/v10 | `inputs.<subject>.profileDigest` (+ `profileName` as provenance) | string | yuurei | digest is identity; name is display only |
| `subject.requested-cell` | v9/v10 | `inputs.<subject>.requestedCellDigest` | string \| null | yuurei | `null` on traces predating the record |
| `observation.status` | v9/v10 | `inputs.<subject>.observationStatus` | `recorded` \| `partial` \| `unavailable` \| null | yuurei | `null` = no observation record — unknown, not "no configuration" |
| `observation.reason` | v9/v10 | `inputs.<subject>.observationReason` | ADR-0022 reason string \| null | yuurei | `null` = no reason recorded; verbatim echo, classify `unavailable` by reason without reopening the trace |
| `observation.declared` | v9/v10 | entry `association.observation` on the subject | `recorded` \| `not-recorded` + completeness | gatefold | `not-recorded` = no observation record exists |
| `export.retained` | v9/v10 | entry `association.export-retained` on the subject | state + completeness | gatefold | `verified`/`partial` = truncated bytes verified; `inconsistent` = digest mismatch; `unverifiable` = declared-not-listed or failed; `not-recorded` = undeclared |
| `export.document` | v9/v10 | entry `association.export-document` on the subject | state | gatefold | `verified` = conforming `pfl export` document; `inconsistent` = verified bytes that violate the contract; `unverifiable`/`not-recorded` cascade as above |
| `export.binding` | v9/v10 | entry `association.export-binding` on the subject | state | gatefold | `verified` = bound to this cell; `inconsistent` = contradicts the trace (different `cellId` recorded); `unverifiable` = `cellId` absent/null either side; `not-recorded` = no usable export |
| `export.snapshots` | v9/v10 | `inputs.<subject>.exportObservedSnapshotId` / `exportResolvedSnapshotId`; check `association.export-snapshots` | string \| null; state | pfl + gatefold | descriptor ids are populated **only when the binding is verified** — `null` means unbound, not "no snapshots" |
| `export.runtime` | v9/v10 | entry `association.export-runtime` on the subject | state | gatefold | as other association checks |
| `export.completeness` | v9/v10 | `configuration.completeness` entry (`recorded` + completeness = export's declared completeness); cross-check `association.export-completeness` | `complete` \| `partial` | pfl + gatefold | entry absent → no bound export; see `config.availability` |
| `record.consistency` | v9/v10 | entry `association.record-consistency` on the subject | `verified` \| `inconsistent` | gatefold | `verified` = declared records match what exists; `inconsistent` = records affirmatively contradict (e.g. `recorded`/`partial` observation with an unretained declared export) |
| `config.availability` | v9 | entry `configuration.availability` on the subject | `not-recorded` \| `unverifiable` \| `inconsistent` | gatefold | present only when no bound export exists; its state mirrors the binding cascade — unknown configuration, never "no configuration" |
| `config.elements` | v9 | entries `configuration.element.<id>` / `configuration.relation.<n>` / `configuration.finding.<n>` on the subject | `recorded` + completeness; per-element values via `export` evidence pointers | pfl | emitted only when `export.binding` is `verified`; a `partial` export yields `partial`-completeness entries |
| `audit.facts` | v8, v9, v10 | `facts[]` (v8) / `audit.<fact-id>` entries on the subject (v9/v10) | per-fact state + completeness | gatefold | the fixed v0.8 fact list; `not-recorded` facts are still emitted |
| `pair.admitted` | v9 compare | process result: exit 0 with `comparison.comparability`, or exit 3 `mismatched-inputs` | admitted \| rejected | gatefold | rejection is a boundary, not a comparison result |
| `pair.source-identity` | v9 compare | entry `comparison.source-identity` | `verified` \| `unverifiable` \| `recorded` | gatefold | `verified` = shared declared source verified on both sides; `unverifiable` = shared source cannot be shown → configuration withheld |
| `config.difference` | v9 compare | `comparison.elements`/`comparison.effective`/`comparison.element-*/relation-*/finding-*` vs `comparison.config-unavailable` | entries present \| one unavailability entry | gatefold | `comparison.config-unavailable` (state `unverifiable`, completeness `unknown`) = the difference is withheld — **never** "no configuration change" |
| `set.inputs` | v10 | entry `set.inputs` | supplied/bound/eligible counts | gatefold | denominator is eligible exports only |
| `set.records` | v10 | `set.element.<id>` / `set.relation.<n>` / `set.finding.<n>` vs `set.config-unavailable` | K-of-E statements \| one unavailability entry | gatefold | `set.config-unavailable` = the record account is withheld |
| `supplied.evaluation` | v9 | `evaluation.supplied`, `evaluation.binding` (+ verdicts via `evaluation` evidence pointers) | state | gatefold (labels supplied document) | `recorded` = conforming and bound; `inconsistent` = binds to another run; `unverifiable` = non-conforming document — never a Gatefold verdict |

`observation.reason` is validated against the yuurei ADR-0022 closed enum
at the input boundary — a trace carrying an unrecognized reason is
rejected by the reader and never reaches a result. The output schema
still types the field as a plain string rather than pinning the enum:
Gatefold result documents stay valid under the same schema version if a
future Gatefold accepts an extended upstream enum, and consumers should
treat an unrecognized reason as an unknown classification, not as absent.

### Case A decision the consumer can make

Using only the rows above, the consumer distinguishes:

- **admitted**: `export.binding` `verified` and `config.difference`
  entries emitted → a real, bounded comparison exists to evaluate;
- **missing evidence**: `observation.declared`/`export.retained`/
  `export.binding` `not-recorded` → nothing was recorded; the
  proposition's evidence does not exist;
- **disqualified evidence**: `inconsistent` or `unverifiable` on any of
  `export.retained`/`export.document`/`export.binding`, or
  `observation.status` `unavailable`, or `config.difference` =
  `config-unavailable` → evidence exists or was declared but cannot be
  used; never read as an empty or unchanged harness;
- **contradiction**: `inconsistent` states, or a `recorded`/`partial`
  observation whose declared export is unretained
  (`record.consistency` `inconsistent`). This is a *qualifier on
  disqualified*, not a fourth side class: the reference consumer's
  vocabulary is bound / missing / disqualified, and `record.consistency`
  is the signal that separates an affirmatively contradicted side from
  one whose records merely failed checks.

The forbidden collapse — observation failure represented as "no
configuration change" — is unreachable in this surface: there is no state
that asserts sameness. `config-unavailable` withholds the difference;
the document contains no field a consumer can read as "unchanged".

## What Gatefold establishes vs what remains the consumer's

Gatefold establishes, per accessor: that the named records exist and parse,
that retained bytes hash to the manifest's digests, that declared
identities agree or contradict, and the completeness of the underlying
records. The `inputs` descriptors carry subject/run identity sufficient to
reconcile a report without reloading any run file.

Gatefold does **not** establish, and the consumer must not infer:

- that the agent used a statically effective element (static effectiveness
  is not runtime use);
- that a verified stored record proves the agent consumed its contents
  (verified bytes ≠ proven use);
- a satisfied/violated verdict on any proposition — admission and
  predicate evaluation belong to analyze;
- that `cellId` equality proves observation happened against this cell —
  it is a caller-asserted value; the verified association is a *recorded
  association*, per `docs/v0.9-scope.md`;
- that a supplied v6/v7 evaluation's verdicts describe this cell — they
  are labelled supplied context only when `evaluation.binding` verifies.

## Provenance and citation

Every entry carries `evidence` (resolvable pointers into the inputs above;
`digest` repeats a verified stored digest when stored bytes are cited) and
`provenance.transform` naming the producing command and entry id. A
consumer cites evidence by replaying the pointer against the listed input
— the pointer vocabulary and resolution rules are the v9 contract's
(`docs/v0.9-scope.md`), unchanged.

## Unknown fields and versions

Additive optional fields keep a schema version; removing, renaming, or
retyping bumps it (`docs/claim-model.md`). A consumer conforming to
accessor contract v1 therefore:

- accepts v8/v9/v10 results and ignores fields it does not consume;
- treats a missing optional descriptor field as unrecorded, never as a
  value;
- rejects `schemaVersion` values it does not know — upgrading unknown
  results is analyze's decision, never a silent Gatefold assumption.

## Case matrix (derived expectations)

| Case | Accessor reading |
| --- | --- |
| No `observation` record in the trace | `observation.status` null, `observation.reason` null, `observation.declared` `not-recorded`, `export.*` `not-recorded`, `config.availability` `not-recorded` |
| `status: "unavailable"`, no artifacts declared | `observation.status` `"unavailable"` + verbatim `reason`; `export.retained` `not-recorded`; comparison side → `config-unavailable` |
| `status: "partial"` | `observation.status` `"partial"`; bound-export entries carry `partial` completeness |
| Declared export unlisted by the manifest | `export.retained` `unverifiable`; `record-consistency` `inconsistent` when the status claimed `recorded`/`partial` |
| Export retained but digest-mismatched / missing / oversized | `export.retained` `inconsistent`/`unverifiable`; `export.document` cascades; bytes never interpreted |
| Export bytes verify, manifest marks `truncated: true` | `export.retained` `verified`/`partial`; document never read as complete |
| Verified bytes, not a conforming export document | `export.document` `inconsistent` |
| Valid export, `cellId` absent or null, or trace `cell_id` absent | `export.binding` `unverifiable`; the export is unbound, not missing |
| Valid export, `cellId` ≠ trace `cell_id` | `export.binding` `inconsistent` — present-but-contradicted |
| Bound export | `export.binding` `verified`; `config.*` entries `recorded`; descriptor snapshot ids populated |
| Pair, one side unbound | `comparison.config-unavailable` `unverifiable`; no element/relation/finding entries; never "no difference" |
| Pair, different verified declared sources | rejected `mismatched-inputs` (exit 3) — never compared |
| Pair, no shared verifiable identity, observed `project.id` differ | `comparison.source-identity` `unverifiable`; `config-unavailable` |
| Supplied evaluation that binds | `evaluation.binding` `verified`; verdicts restated as supplied context |
| Supplied evaluation naming another run | `evaluation.binding` `inconsistent`; verdicts withheld |
| v10 set, fewer than 2 bound exports | `set.config-unavailable`; per-run lanes still report each run's own records |
