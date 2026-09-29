# Claim model

A claim is one evidence-backed statement about a harness representation.

The machine-readable form is defined by the versioned JSON Schema at
[`schema/claim-result.v2.json`](../schema/claim-result.v2.json). The TypeScript
types in `src/domain/claim.ts` mirror that schema with one deliberate
difference: the `Claim` interface marks `ruleId` required because Gatefold
always emits it, while the schema and the runtime validator keep it optional
so results written before `ruleId` existed stay valid. A typed
`AnalysisResult` still validates against the schema.

## Result envelope

| Field | Type | Meaning |
| --- | --- | --- |
| `schemaVersion` | integer | Version of this result schema. `2` for single-document results; the comparison commands emit their own versions (`compare` → 3, `compare-traces` → 4, `compare-runs` → 5). |
| `source` | object | `{ pflVersion: string, command: "report" \| "export" \| "diff" }` — which pfl document produced these claims. Added in v2; v1 results predate it and remain valid v1 documents. |
| `claims` | array | The emitted claims. May be empty. |

## Claim fields

| Field | Type | Meaning |
| --- | --- | --- |
| `claim` | string, non-empty | The statement in natural language. Descriptive only — never a judgement of quality. |
| `ruleId` | string, non-empty | Stable identifier of the producing rule. Always emitted by Gatefold; optional in the schema so results written before `ruleId` existed stay valid. |
| `evidence` | array, min 1 item | References to concrete locations in the input representation. |
| `provenance` | object | The source file, the export version, and the transformations used. |
| `confidence` | number in [0, 1] | The certainty that the evidence supports the claim. |

### Evidence references

Each evidence item carries:

- `pointer` (required) — a JSON Pointer (RFC 6901) into the input export
  document. The empty string references the whole document.
- `elementId` (optional) — the id of the referenced element when the export
  defines element ids, verbatim so it matches the input document. Display and
  error paths sanitize it; JSON output keeps the document value (JSON string
  encoding escapes control characters).
- `note` (optional) — a human-readable clarification.

### Display versus machine output

Claims and evidence carry document values verbatim: pointers, element ids,
run ids, and metadata keys keep the bytes the input recorded so consumers
can resolve them against the input. How each output mode renders those
values is a display decision, not part of the contract:

- **Human output** (`--format human`, the default) escapes every rendered
  line at the output boundary: Unicode general categories Cc, Cf, Zl, and
  Zp — C0/C1 controls, DEL, zero-width and bidi formatting characters,
  line/paragraph separators, the BOM, and the supplementary tag block —
  are written as literal `\uXXXX` so no escape sequence or invisible
  reordering character reaches a terminal. Escaping applies to the whole
  line, so pointer segments, caveats, and run ids need no per-field
  handling; values a rule already sanitized at construction pass through
  unchanged because the escape is idempotent.
- **JSON output** (`--format json`) is the contract surface and keeps
  document values verbatim, encoded by `JSON.stringify`. That encoding
  escapes C0 controls but not C1 controls, bidi marks, or tag characters:
  a parsed string is intact bytes, and a consumer that prints JSON fields
  directly to a terminal must apply its own escaping.

### Provenance

- `sourceFile` (required) — the path of the input export file, or `<stdin>`
  when the export was read from standard input.
- `exportVersion` (optional) — the version the export reports (for a `pfl`
  document, its `pflVersion`), when the export carries one.
- `transform` (required, may be empty) — names of the transformations applied
  between the raw input and the claim, in application order.
- `classifierVersion` (optional) — the version of the export's interpretation
  classifier (`data.interpretation.classifierVersion` for a `pfl report`
  document, `data.interpretation.classifier.version` for a `pfl export`
  document).
- `interpretationOrigin` (optional) — how the export's interpretation was
  produced (for a `pfl` document, `data.interpretation.origin`).
- `observedSnapshotId` / `resolvedSnapshotId` (optional) — snapshot identifiers
  the export carries.
- `runtimeName` (optional) — the display name of the runtime the export
  describes, when the export carries one.

### Confidence

Confidence expresses how strongly the cited evidence supports the claim, on a
0–1 scale. It is not a quality score: a high confidence means the evidence
supports the claim strongly, not that the harness is good. The schema contains
no scoring, ranking, declared-intent, or trace fields.

## Versioning

The result document always carries `schemaVersion`, and the schema's `$id`
names the same version. Additive changes (a new optional field) keep the
version; removing, renaming, or retyping a field bumps it. Readers should
ignore unknown fields on `claims` items' payloads only where the schema allows
— the v1 schema is closed (`additionalProperties: false`) so producers cannot
silently add contract-breaking fields. Version 2 adds the required `source`
discriminator; consumers must branch on `schemaVersion` and v1 documents keep
validating against `schema/claim-result.v1.json`.

## Invalid claims

A claim that fails the schema — most importantly a claim with empty `evidence`
— is a defect, not a warning. Gatefold must not emit it: `analyze` runs
`assertValidResult` (`src/domain/validate.ts`) over every result, so a
schema-invalid claim fails the run instead of reaching the output. The checker
and the schema are pinned to the same behavior by `schema/examples/`:
`valid-result.json` validates; every `invalid-*.json` fails both.
