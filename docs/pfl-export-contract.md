# Supported pfl export contract (v0.1)

This document defines the exact `pfl` export shape Gatefold v0.1 accepts. It is
grounded in pfl's frozen v1.0 `--json` document contract
(`docs/design/pfl-json-contract.md` in the pfl repository). Gatefold has no
runtime dependency on pfl; the export file is the only boundary.

## Accepted document

Gatefold accepts exactly one kind of pfl document: a successful
`pfl report --json` export — the descriptive interpretation surface (counts,
facets, findings). Other commands (`inspect`, `list`, `show`, `graph`,
`snapshots`, `diff`, `gc`) are not accepted in v0.1.

## Envelope

Every accepted document is a JSON object with these top-level fields:

| Field | Type | Requirement |
| --- | --- | --- |
| `pflVersion` | string | Semver version of the pfl that produced the document. Must satisfy `>=1.0.0 <2.0.0`. |
| `command` | string | Must be `"report"`. Any other value is rejected. |
| `ok` | boolean | Must be `true`. A failure document (`ok: false`, with `data.error`) is rejected and its `error.code`/`error.message` are surfaced. |
| `completeness` | string | One of `"complete"`, `"partial"`, `"unknown"`. `"partial"` is accepted — best-effort results are normal operation — and is recorded for provenance. |
| `diagnostics` | array | Must be an array. Items carry `severity` (`"info"`/`"warning"`/`"error"`), `code` (string), `message` (string), optional `path` (string). Items with other shapes are rejected. |
| `data` | object | The report payload; see below. |

## `data` payload

Required fields:

| Field | Type | Meaning |
| --- | --- | --- |
| `runtime` | string | Runtime id observed by pfl (e.g. `"claude-code"`, `"codex"`, `"opencode"`). |
| `project` | object | `{ id: string, displayName: string }`. |
| `stats` | object | `{ observed, effective, shadowed, conditional, opaque }` — non-negative integers — plus optional `byFacet`, a record of facet name → non-negative integer. |
| `findings` | array | Items `{ rule: string, message: string, elementIds: string[] }`. May be empty. |
| `interpretation` | object | `{ classifierVersion: string, origin: "stored" \| "recomputed" }`. |

Recognized optional fields (captured for provenance when present):
`runtimeName`, `observedSnapshotId`, `resolvedSnapshotId`, `confidence`.

## Unknown fields

Readers ignore unknown fields, matching pfl's compatibility rule: a document
with extra envelope or `data` fields is still accepted. Removing or renaming a
field Gatefold requires is a breaking change on pfl's side and is handled by
the version range, not by guessing.

## Compatibility

- Accepted `pflVersion` range: `>=1.0.0 <2.0.0`. The document contract is frozen
  for pfl v1.x; a pfl 2.x document may change required fields, so it is rejected
  rather than guessed at.
- The rejection of `ok: false` documents follows the pfl contract: failure
  documents carry `data.error` with a stable `code`, which Gatefold echoes in
  its error message.

## Evidence locations

Claim evidence `pointer` values (JSON Pointer, RFC 6901) may reference:

- the whole document: `""`
- envelope fields: `/pflVersion`, `/completeness`, `/diagnostics`, `/diagnostics/<n>`
- report fields: `/data/runtime`, `/data/project`, `/data/stats`,
  `/data/stats/<name>`, `/data/stats/byFacet/<facet>`, `/data/findings`,
  `/data/findings/<n>`, `/data/interpretation`
- `elementId` on an evidence item names an element id cited by a finding
  (`/data/findings/<n>/elementIds/<m>`), not a path inside this repository.

## Error behavior

Unreadable file, invalid JSON, non-object top level, unsupported command,
`ok: false`, out-of-range `pflVersion`, and missing/wrongly-typed required
fields all fail with deterministic, distinct, actionable errors (issue #4
implements them; issue #6 assigns exit codes).

## Fixtures

Committed fixtures under `test/fixtures/pfl-export/`:

| File | Expected |
| --- | --- |
| `valid-report.json` | accepted; representative report with findings |
| `valid-report-minimal.json` | accepted; smallest valid document |
| `empty-report.json` | accepted; zero findings, zero stats |
| `unsupported-version.json` | rejected (`pflVersion` 2.x) |
| `wrong-command.json` | rejected (`command` is not `report`) |
| `failure-document.json` | rejected (`ok: false`) |
| `invalid-shape.json` | rejected (missing required `data` fields) |
| `malformed.json` | rejected (not valid JSON) |
