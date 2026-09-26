# Rule catalog

The analyzer registers an explicit list of descriptive rules per input
command: `src/application/rules.ts` for `report` documents and
`src/application/export-rules.ts` for `export` documents. Each rule emits
claims about what the document contains — never a judgement of whether the
harness is good or bad. Every claim carries evidence, provenance, and
confidence per `schema/claim-result.v2.json`.

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

## Conventions

- Claim order is deterministic: registry order, then document order within a
  rule. `facet-composition` emits facets sorted by facet name.
- Every claim carries `ruleId`, the stable id from the table above. JSON
  consumers should select claims by `ruleId` instead of parsing claim text or
  `provenance.transform`.
- Evidence pointers are JSON Pointers into the export document at the locations
  the input contract permits (`docs/pfl-export-contract.md`).
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
