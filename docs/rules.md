# Rule catalog

The analyzer registers an explicit list of descriptive rules per input
command: `src/application/rules.ts` for `report` documents,
`src/application/export-rules.ts` for `export` and `diff` documents,
`src/application/compare-rules.ts` for `compare` results,
`src/application/trace-rules.ts` for `compare-traces` results, and
`src/application/run-rules.ts` for the artifact side of `compare-runs`
results (the trace rules also run there, unchanged). Each rule emits claims
about what the documents contain — never a judgement of whether the harness
or run is good or bad. Every claim carries evidence, provenance, and
confidence per the matching result schema (`claim-result.v2.json`,
`.v3.json`, `.v4.json`, `.v5.json`).

The `evaluate-run` and `compare-evaluations` commands (v0.7) do not run
these rules: they resolve each spec-declared criterion to a `pass`/`fail`/
`unknown` verdict or an A → B transition instead of emitting rule claims —
see [v0.7 scope](v0.7-scope.md) and `claim-result.v6.json`/
`claim-result.v7.json`. The `audit-run` command (v0.8) runs no rules either:
it emits the fixed fact list of [v0.8 scope](v0.8-scope.md) and
`claim-result.v8.json` — record states, not claims or verdicts. The
`report-cell` and `compare-cells` commands (v0.9) likewise run no rules:
they emit the fixed lane/entry list of [v0.9 scope](v0.9-scope.md) and
`claim-result.v9.json` — association, configuration, execution, audit,
evaluation, and comparison records with states and completeness markers,
never claims, verdicts, or confidence scores.

## `report` rules

| Rule id | What it claims | Confidence |
| --- | --- | --- |
| `runtime-described` | Which runtime and project the export describes. | 1.0 |
| `element-counts` | The observed/effective/shadowed/conditional/opaque element counts. | 1.0 when `completeness` is `complete`, else 0.8 |
| `facet-composition` | Per-facet element counts from `stats.byFacet`. | same as `element-counts` |
| `finding-reported` | Each finding the export carries: rule id, message, cited element ids. | 1.0 |
| `diagnostic-reported` | Each `warning`/`error` diagnostic the export carries: its code, message, and path. Emitted only for warning/error diagnostics. | 1.0 |
| `completeness-reported` | When the export is `partial` or `unknown`, that fact and the diagnostic count. Emitted only for non-complete exports. | 1.0 |
| `observation-status` | How to read the report's observation status: the reported `completeness`, diagnostic counts by severity, and the interpretation origin and classifier version. Emitted once per accepted report. Describes only what the export states — never a cause, quality judgement, or score. | 1.0 |

## `export` rules

| Rule id | What it claims | Confidence |
| --- | --- | --- |
| `export-described` | Which runtime, adapter, and project the export snapshot describes. | 1.0 |
| `export-snapshot-contents` | How many joined elements, relations, and findings the export carries, and how many elements carry each nullable layer. | 1.0 when `completeness` is `complete`, else 0.8 |
| `export-interpretation-provenance` | Which classifier produced the export's interpretation, with which origin, resolution semantics version, and resolution confidence. | 1.0 |
| `element-observed-state` | Each element's observed layer: id, redacted source path when present, native kind/origin/scope, status, and reason when present. The claim cites only fields present in the document; `metadata` and `inspectability` are never expanded into prose. | 1.0 |
| `element-resolved-state` | Each element's resolved layer, emitted only when `resolved` is non-null: status, activation, applicability, strategy, and resolution reason when present. `effective` is phrased as potentially effective in the static environment — never as proof an agent used the element. A null layer emits nothing; it is not a negative finding. | 1.0 |
| `element-interpretation` | Each element's derived interpretation, emitted only when `interpretation` is non-null: assigned facets, classification confidence, and classification reason. The quoted confidence is pfl's classification confidence cited as data — the claim's own confidence reflects field support, not the classifier's estimate. | 1.0 |
| `export-relation-described` | Each explicit relation edge with direction: `element 'A' shadows/overrides/accumulates with element 'B'` where `from` names the winning side. Persisted legacy types (`contains`, `discovered-from`, `resolves-to`, `applies-to`) are reported neutrally as "pfl declares a `<type>` relation" without interpreting semantics. | 1.0 |
| `export-finding-context` | Each finding restated with element context: one claim per finding per unique referenced element id, adding kind, path, observed status, and resolved status when the layers exist. References to ids absent from `elements` are reported as unresolved, never given invented context; repeated ids emit once; a finding with no `elementIds` still emits one claim restating the finding. | 1.0 |
| `diagnostic-reported` | Each `warning`/`error` diagnostic the export carries: its code, message, and path. Emitted only for warning/error diagnostics. | 1.0 |
| `completeness-reported` | When the export is `partial` or `unknown`, that fact and the diagnostic count. Emitted only for non-complete exports. | 1.0 |

`diagnostic-reported` and `completeness-reported` are shared claim
vocabulary: every command rule set may emit them, and their provenance
`transform` chain records which envelope produced the claim
(`pfl-report-envelope` versus `pfl-export-envelope`).

## `diff` rules

| Rule | Claim | Confidence |
| --- | --- | --- |
| `diff-described` | The comparison's direction and scope: runtime plus the resolved and observed snapshot identifiers on sides A and B. | 1.0 |
| `diff-interpretation-provenance` | Which classifier version produced each side's interpretation and whether it was stored or recomputed. | 1.0 |
| `diff-element-added` | One claim per element id present only in snapshot B (A → B addition); when the list is empty, one claim stating the diff reports none, citing the count field in evidence. | 1.0 |
| `diff-element-removed` | One claim per element id present only in snapshot A (removed by B); when the list is empty, one claim stating the diff reports none, citing the count field in evidence. | 1.0 |
| `diff-element-changed` | One claim per element id present in both snapshots whose content pfl marks changed; when the list is empty, one claim stating the diff reports none, citing the count field in evidence. | 1.0 |
| `diff-effective-totals` | The aggregate newlyEffective/noLongerEffective/activationChanged counters, with the caveat that they include added/removed elements, `effective` means potentially effective in the static environment, and the totals need not equal the status-change record count. | 1.0 |
| `diff-status-transition` | One claim per recorded resolved-status transition A → B, linked to `structural.changedIds` only when the same id appears there; null sides are phrased as "no resolved status", never a negative fact. | 1.0 |
| `diff-facet-delta` | One claim per recorded facet delta (including zero), phrased as an aggregate count change that is never attributed to an individual element and never called an improvement. | 1.0 |
| `diff-relation-added` | One claim per relation present in B but not A, with `from`/`to` direction (`from` is the winning side for `shadows`/`overrides`; `accumulates-with` is phrased symmetrically); legacy types are named without interpreting semantics. | 1.0 |
| `diff-relation-removed` | One claim per relation present in A but not B, with direction; legacy types are named without interpreting semantics. | 1.0 |
| `diff-finding-added` | One claim per finding in B but not A — rule, message, and cited element ids (list capped at five). A same-rule, same-elements removal is noted as a pfl reworded-finding add-plus-remove pair, never as proof of a harness change. | 1.0 |
| `diff-finding-removed` | One claim per finding in A but not B — rule, message, and cited element ids (list capped at five). | 1.0 |
| `diff-version-note` | Each `versionNotes` entry quoted as a prose comparison caveat; notes are not parsed as machine codes. | 1.0 |
| `diff-comparison-caveats` | Caveats from per-side provenance: a recomputed (not stored) interpretation origin, and differing classifier versions warning that interpretation-level differences may reflect the classifier change itself. | 1.0 |
| `diagnostic-reported` | Each `warning`/`error` diagnostic the diff carries: its code, message, and path. Emitted only for warning/error diagnostics. | 1.0 |
| `completeness-reported` | When the diff is `partial` or `unknown`, that fact and the diagnostic count. Emitted only for non-complete diffs. | 1.0 |

## `compare` rules

Emitted in this order by `gatefold compare` (schema v3); each evidence
reference names `before`, `after`, or `diff` explicitly.

| Rule id | What it claims | Confidence |
| --- | --- | --- |
| `compare-inputs` | The three documents form one A → B comparison of one project on one runtime, with both sides' snapshot ids. | 1.0 |
| `compare-completeness` | Per input captured with `partial` or `unknown` completeness: absence on that side may be unobserved. | 1.0 |
| `compare-version-drift` | Version caveats: differing pfl versions, resolution semantics versions, classifier versions (export-vs-export and export-vs-matching-diff-side), differing runtime versions (only when both are known), and each `versionNotes` entry quoted verbatim. | 1.0 |
| `compare-element-added` | Per `addedIds` entry: the B-side element description (or hedged absence) and the A-side context. | 1.0 |
| `compare-element-removed` | Per `removedIds` entry: the A-side element description (or hedged absence) and the B-side context. | 1.0 |
| `compare-element-changed` | Per `changedIds` entry: both sides' element descriptions (or hedged absence). | 1.0 |
| `compare-status-transition` | Per `statusChanges` entry: the recorded from/to statuses plus what each export actually resolves. `effective` is phrased as static potential, never runtime use. | 1.0 |
| `compare-activation-change` | Per element present in both exports whose resolved activation differs; derived from the exports because the diff carries only an aggregate count. | 1.0 |
| `compare-facet-change` | Per element present in both exports whose interpretation facets differ; added/removed facet names only. | 1.0 |
| `compare-relation-added` | Per added relation record: type and endpoints with each side's element context; a recorded link, never a cause. | 1.0 |
| `compare-relation-removed` | Per removed relation record, same shape as `compare-relation-added`. | 1.0 |
| `compare-finding-added` | Per added finding: rule, message, cited element ids (capped at five), and B-side element context. | 1.0 |
| `compare-finding-removed` | Per removed finding, same shape as `compare-finding-added`; a same-rule, same-elements addition is cross-referenced. | 1.0 |
| `compare-finding-reworded` | A removed finding paired with an added finding of the same rule and element ids but different message — consistent with rewording, never proof the condition resolved. | 1.0 |
| `compare-contradiction` | Each recorded disagreement between the diff's assertions and the exports' contents. | 1.0 |

## `compare-traces` rules

Emitted in this order by `gatefold compare-traces` (schema v4); each evidence
reference names `beforeTrace` or `afterTrace` explicitly and its pointer
resolves inside the named trace. Claims describe recorded run state only —
never causation, never answer quality.

| Rule id | What it claims | Confidence |
| --- | --- | --- |
| `trace-inputs` | The pair's shared identity: same task content digest, runtime id, requested model, and isolation strategy; run ids and task sources are quoted as provenance, and a differing `isolation.verified` is stated. | 1.0 |
| `trace-comparability` | One caveat per allowed-but-meaningful difference or gap: `requested_cell` / `execution_options` absent on either side (unverifiable, not assumed), and observed drift in `yuurei_version`, `runtime.version`, `model.resolved`, `model.resolved_reason`, or `isolation.verified`. Sorted by field name. | 1.0 |
| `trace-profiles` | The profile/harness variant: both profiles' names and content digests, and — when both record it — the `requested_cell.digest` difference consistent with them. The compared variable, never a rejection. | 1.0 |
| `trace-runtime` | The shared runtime id and each side's recorded `runtime.version`; a null version is stated as unobserved (the trace records the key, not a value), never as a difference. | 1.0 |
| `trace-model` | The shared requested model and each side's observed `model.resolved`; null is stated as unobserved with `resolved_reason` when recorded. | 1.0 |
| `trace-execution` | Each side's recorded outcome — `timed_out`, `exit_code`, `signal` — always with the disclaimer that exit status describes process termination, not answer quality. | 1.0 |
| `trace-duration` | The recorded `duration_ms` of each side and the A → B difference; no difference is computed when either side is null. | 1.0 |
| `trace-usage` | One claim per usage key in byte order: a numeric difference only when the key is numeric on both sides; `null` is stated as attempted-but-unobserved and absent as never-attempted — the two cases are never merged. | 1.0 |
| `trace-cost` | Each side's cost estimate; a numeric difference only when both estimates share a currency. Null means no estimate was produced, and a currency mismatch is reported as two separate estimates. Amounts are always called estimates. | 1.0 |
| `trace-diagnostic` | Each `diagnostics` entry quoted verbatim with its run label; diagnostics are free text and are never parsed into codes. | 1.0 |

## `compare-runs` rules

Emitted by `gatefold compare-runs` (schema v5) after the full `compare-traces`
rule set above: the trace rules run against each run's `trace.json`
unchanged, then the artifact rules below describe the manifests and the
verified `patch.diff` records. Evidence references name `beforeManifest` /
`afterManifest` (pointers resolve inside that run's `artifacts.json`) or
`beforePatch` / `afterPatch` (the pointer is the manifest entry of
`patch.diff`, plus the recorded digest, the generated-file `path`, and a
bounded `lines`/`bytes` range into the verified stored bytes).

| Rule id | What it claims | Confidence |
| --- | --- | --- |
| `run-manifest` | One claim per manifest entry per side, in path byte order: the recorded path, kind, digest, truncation flag, and stored byte count, plus the verification outcome (`verified`, `verified-truncated`, `digest-mismatch`, `missing`, `unverified`). | 1.0 |
| `run-patch-state` | One caveat per side whose patch is anything but cleanly verified: not recorded, missing, unverifiable, digest-mismatched, malformed, or truncated. An unrecorded or unreadable patch is never phrased as absent output. | 1.0 |
| `run-generated-files` | The aggregate generated-file comparison: identical sets, or the counts of identical / changed / A-only / B-only records, or why the comparison is limited. Always carries the caveat that a patch omits binary, oversized, over-cap, and unrepresentably named files. | 1.0 |
| `run-file-added` | One claim per generated file only B's patch records, citing B's block and A's patch entry with a `no block` note. | 1.0 |
| `run-file-removed` | One claim per generated file only A's patch records, symmetric to `run-file-added`. | 1.0 |
| `run-file-changed` | One claim per generated file recorded by both patches with differing content, citing each side's differing line region. | 1.0 |

File-level claims are emitted only when both patches parse; a truncated patch
contributes its complete stored prefix and says so. Generated paths and
content are data, never interpreted as instructions.

## Conventions

- Claim order is deterministic: registry order, then document order within a
  rule. `facet-composition` emits facets sorted by facet name. For `compare`,
  order within a rule is element id / claim identity, independent of the
  diff's array order (records keep their source indexes for evidence
  pointers).
- Every claim carries `ruleId`, the stable id from the table above. JSON
  consumers should select claims by `ruleId` instead of parsing claim text or
  `provenance.transform`.
- Evidence pointers are JSON Pointers into the export document at the locations
  the input contract permits (`docs/pfl-export-contract.md`). For
  `compare-runs`, manifest pointers resolve inside the named run's
  `artifacts.json` and patch evidence additionally bounds a line/byte range
  inside the verified `patch.diff` bytes (`docs/yuurei-run-contract.md`).
- Provenance records the source file, the export's `pflVersion`, the transform
  chain `["pfl-report-envelope", "rule:<id>"]` (or
  `["pfl-export-envelope", "rule:<id>"]` for `export` documents), and the
  export's interpretation
  metadata: `classifierVersion`, `interpretationOrigin`, and — when the export
  carries them — `observedSnapshotId`, `resolvedSnapshotId`, and `runtimeName`.
  Diff claims use the same `pfl-export-envelope` transform label and carry the
  per-side snapshot ids and classifier versions in claim text instead: a diff
  has two of each, which the single-valued provenance fields cannot express.
- Strings interpolated into claim text — and provenance strings copied from
  the export (`classifierVersion`, `observedSnapshotId`,
  `resolvedSnapshotId`, `runtimeName`) — pass through Gatefold's canonical
  normalization: C0/C1/DEL, zero-width and bidi formatting
  characters, line/paragraph separators, and U+FEFF become the literal text
  `\uXXXX`. This normalization is distinct from JSON serialization escaping:
  in `--format json` output the sequence appears as `\\uXXXX` inside the JSON
  string, and a consumer that parses the JSON still sees the literal `\uXXXX`
  text rather than the original character. A hostile export therefore cannot
  inject terminal escape sequences or reorder displayed text in either output
  format.
