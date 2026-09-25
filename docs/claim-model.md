# Claim model

A claim is one evidence-backed statement about a harness representation.

The machine-readable form is defined by the versioned JSON Schema at
[`schema/claim-result.v1.json`](../schema/claim-result.v1.json). The TypeScript
types in `src/domain/claim.ts` mirror that schema; a typed `AnalysisResult`
validates against it.

## Result envelope

| Field | Type | Meaning |
| --- | --- | --- |
| `schemaVersion` | integer | Version of this result schema. Currently `1`. |
| `claims` | array | The emitted claims. May be empty. |

## Claim fields

| Field | Type | Meaning |
| --- | --- | --- |
| `claim` | string, non-empty | The statement in natural language. Descriptive only — never a judgement of quality. |
| `evidence` | array, min 1 item | References to concrete locations in the input representation. |
| `provenance` | object | The source file, the export version, and the transformations used. |
| `confidence` | number in [0, 1] | The certainty that the evidence supports the claim. |

### Evidence references

Each evidence item carries:

- `pointer` (required) — a JSON Pointer (RFC 6901) into the input export
  document. The empty string references the whole document.
- `elementId` (optional) — the id of the referenced element when the export
  defines element ids.
- `note` (optional) — a human-readable clarification.

### Provenance

- `sourceFile` (required) — the path of the input export file.
- `exportVersion` (optional) — the version the export reports (for a `pfl`
  document, its `pflVersion`), when the export carries one.
- `transform` (required, may be empty) — names of the transformations applied
  between the raw input and the claim, in application order.

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
silently add contract-breaking fields.

## Invalid claims

A claim that fails the schema — most importantly a claim with empty `evidence`
— is a defect, not a warning. Gatefold must not emit it: if analysis ever
produces a schema-invalid claim, the run fails rather than shipping invalid
JSON. Committed fixtures under `schema/examples/` pin this behavior:
`valid-result.json` validates; every `invalid-*.json` fails.
