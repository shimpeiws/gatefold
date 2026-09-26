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
