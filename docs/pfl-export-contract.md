# Supported pfl export contract

This document defines the exact `pfl` document shapes Gatefold accepts
(current release: v0.3). It is
grounded in pfl's frozen v1.0 `--json` document contract
(`docs/design/pfl-json-contract.md` in the pfl repository, verified against
`pfl@1.0.0`, `src/cli/report.ts` `ReportData`, on 2026-09-25, and
`src/cli/export.ts` `ExportData` plus its core types). Gatefold has no
runtime dependency on pfl; the export document is the only boundary.

## Accepted document

Gatefold accepts two kinds of pfl documents dispatched on the top-level
`command` field: a successful `pfl report --json` export — the descriptive
interpretation surface (counts, facets, findings) — and a successful
`pfl export --json` document — one full snapshot joining observed, resolved,
and interpretation layers. Other commands (`inspect`, `list`, `show`,
`graph`, `snapshots`, `gc`) are rejected, and `diff` documents are rejected
until the v0.3 diff issues land.

The document reaches Gatefold as a file argument or on standard input
(`gatefold -`). Stdin is an additional transport for the same document, not a
new document kind: identical byte limit, JSON validation, and contract checks
apply, and claims record `<stdin>` as `provenance.sourceFile`.

## Envelope

Every accepted document is a JSON object with these top-level fields. A single
leading UTF-8 BOM is tolerated as part of the transport encoding and stripped
before parsing; a BOM anywhere else is invalid JSON.

| Field | Type | Requirement |
| --- | --- | --- |
| `pflVersion` | string | Semver version of the pfl that produced the document. Must satisfy `>=1.0.0 <2.0.0`. |
| `command` | string | Must be `"report"` or `"export"`. Any other value is rejected. |
| `ok` | boolean | Must be `true`. A failure document (`ok: false`, with `data.error`) is rejected and its `error.code`/`error.message` are surfaced. |
| `completeness` | string | One of `"complete"`, `"partial"`, `"unknown"`. `"partial"` is accepted — best-effort results are normal operation — and is recorded for provenance. |
| `diagnostics` | array | Must be an array of at most 1,000 items. Items carry `severity` (`"info"`/`"warning"`/`"error"`), `code` (string), `message` (string), optional `path` (string). Items with other shapes are rejected. |
| `data` | object | The report payload; see below. |

## `data` payload

Required fields:

| Field | Type | Meaning |
| --- | --- | --- |
| `runtime` | string | Runtime id observed by pfl (e.g. `"claude-code"`, `"codex"`, `"opencode"`). |
| `project` | object | `{ id: string, displayName: string }`. |
| `stats` | object | `{ observed, effective, shadowed, conditional, opaque }` — non-negative safe integers — plus optional `byFacet`, a record of facet name → non-negative safe integer (at most 1,000 keys; facet names are arbitrary strings, including prototype-like names). |
| `findings` | array | Items `{ rule: string, message: string, elementIds: string[] }` (at most 10,000 findings; at most 1,000 non-empty `elementIds` per finding). May be empty. |
| `interpretation` | object | `{ classifierVersion: string, origin: "stored" \| "recomputed" }`. |

Recognized optional fields: `runtimeName`, `observedSnapshotId`,
`resolvedSnapshotId` — surfaced in claim `provenance` when present — and
`confidence`, which is accepted for forward compatibility but not surfaced in
output.

## `data` payload (`export`)

Required fields when `command` is `"export"`:

| Field | Type | Meaning |
| --- | --- | --- |
| `project` | object | `{ id: string, displayName: string }`. |
| `runtime` | object | `{ id: string, version: string \| null, adapter: { id: string, version: string, runtimeCompatibility: "verified" \| "unverified" } }`. |
| `snapshot` | object | `{ observedSnapshotId: string, resolvedSnapshotId: string, capturedAt: string, schemaVersion: string }`. |
| `resolution` | object | `{ semanticsVersion: string, confidence: "verified" \| "unverified-runtime-version" }`. |
| `elements` | array | Joined elements; see below. At most 10,000 items. |
| `relations` | array | `{ type, from, to }`; `from` and `to` must reference element ids present in `elements`. pfl produces `"shadows"`, `"overrides"`, and `"accumulates-with"`; because an export projects stored artifacts, the four legacy schema-1 types `"contains"`, `"discovered-from"`, `"resolves-to"`, and `"applies-to"` are also accepted — the same persisted set pfl's own reader tolerates. At most 20,000 items. |
| `findings` | array | Same item shape and limits as the report payload. |
| `interpretation` | object | `{ classifier: { id: string, version: string }, origin: "stored" \| "recomputed" }`. |

Each `elements` item joins three layers on one id:

| Field | Type | Meaning |
| --- | --- | --- |
| `id` | string | The joined element id; unique within `elements`. |
| `observed` | object | `{ id, native: { kind: string, origin: "project" \| "user" \| "managed" \| "plugin" \| "builtin" \| "unknown", scope: string \| null }, source: object, inspectability: "observable" \| "known-runtime-provided" \| "opaque", metadata: object, status: "observed" \| "unreadable" \| "unsupported" \| "skipped" \| "unknown", reason?: "symlink-not-followed" \| "hardlink-not-followed" \| "non-regular-file-not-opened" \| "limit-exceeded" \| "unsupported-by-adapter" \| "unreadable" \| "unknown" }`. `observed.id` must equal the element id. |
| `resolved` | object \| null | Required key. When non-null: `{ id, status: "effective" \| "shadowed" \| "conditional" \| "unresolved" \| "unknown", applicability?: { type: "global" \| "project" \| "directory-subtree" \| "tool-event" \| "config-rule" \| "runtime-defined" \| "unknown", target?: string }, activation: "always" \| "conditional" \| "on-demand" \| "event-driven" \| "unknown", resolution: { strategy: "override" \| "accumulate" \| "available" \| "policy" \| "event-pipeline" \| "runtime-defined" \| "unknown", reason?: string } }`. `resolved.id` must equal the element id. |
| `interpretation` | object \| null | Required key. When non-null: `{ elementId, facets: string[], confidence: "high" \| "medium" \| "unknown", reason: string }`. Facets are additive in pfl's model, so any non-empty string is accepted. `elementId` must equal the element id. |

A mismatched `observed.id`, `resolved.id`, or `interpretation.elementId`, a
duplicate element id, or a relation endpoint naming an unknown element id is
rejected — the layers must join on one identity, and relations must close
over the snapshot's own elements.

Element `observed.metadata` is bounded safe JSON: strings, numbers, booleans,
null, arrays, and string-keyed objects, nested at most 12 levels deep and at
most 10,000 nodes per element. Every scalar string in the export payload —
element ids, paths, kinds, messages, `resolution.semanticsVersion` — is
capped at 4,096 characters; the provenance-repeated fields
(`snapshot.observedSnapshotId`, `snapshot.resolvedSnapshotId`,
`interpretation.classifier.version`) are capped at 1,024 characters each
since they repeat per claim.

`observed.source.path` values are data, never instructions: Gatefold records
them verbatim (including redacted forms) and sanitizes them if they are later
displayed. Gatefold never opens, reads, or executes a path or payload taken
from the document.

## Unknown fields

Readers ignore unknown fields, matching pfl's compatibility rule: a document
with extra envelope or `data` fields is still accepted. Removing or renaming a
field Gatefold requires is a breaking change on pfl's side and is handled by
the version range, not by guessing.

## Compatibility

- Accepted `pflVersion` range: `>=1.0.0 <2.0.0`. The document contract is frozen
  for pfl v1.x; a pfl 2.x document may change required fields, so it is rejected
  rather than guessed at. Semver build metadata (`1.2.3+build.1`) is accepted;
  prereleases (`1.0.0-alpha`) sort below the range and are rejected.
- The rejection of `ok: false` documents follows the pfl contract: failure
  documents carry `data.error` with a stable `code`, which Gatefold echoes in
  its error message.

## Evidence locations

Claim evidence `pointer` values (JSON Pointer, RFC 6901) may reference:

- the whole document: `""`
- envelope fields and their items: `/pflVersion`, `/completeness`,
  `/diagnostics`, `/diagnostics/<n>`
- the report payload and any subpath of it: `/data`, `/data/<field>`,
  `/data/<field>/<subpath>` (e.g. `/data/stats/byFacet/<facet>`,
  `/data/findings/<n>`, `/data/findings/<n>/elementIds/<m>`,
  `/data/project/displayName`)

`elementId` on an evidence item names an element id cited by a finding
(`/data/findings/<n>/elementIds/<m>`), not a path inside this repository.

## Limits

pfl exports are untrusted input, so the reader enforces resource ceilings:
input files larger than 16 MiB (measured in bytes; regular files are rejected
by size before reading, and pipes are cut off at the limit), more than 1,000 `diagnostics`, more than
10,000 `findings`, more than 1,000 `elementIds` per finding, more than
10,000 `elementIds` in total across all findings, or more than
1,000 `byFacet` keys are rejected with `invalid-shape` errors. Export
documents additionally reject more than 10,000 `elements`, more than
20,000 `relations`, metadata nested more than 12 levels, more than
10,000 metadata nodes per element, or any scalar string longer than
4,096 characters. Metadata
strings copied into every claim's provenance — `pflVersion`,
`data.interpretation.classifierVersion`, `data.runtimeName`,
`data.observedSnapshotId`, `data.resolvedSnapshotId`, and `data.confidence` —
are capped at 1,024 characters each, since they repeat per claim.

The aggregate `elementIds` and metadata limits bound the maximum output
amplification. Every accepted report keeps all cited element ids as evidence,
so the largest accepted report can emit roughly 12,000 claims carrying roughly
22,000 evidence references (findings dominate: at most 10,000 finding claims
with one pointer each plus one pointer per cited element id), each with at
most a few KiB of provenance metadata. Output size therefore stays
proportional to the input's declared item counts.

## Error behavior

Unreadable file, invalid JSON, non-object top level, unsupported command,
`ok: false`, out-of-range `pflVersion`, missing/wrongly-typed required
fields, and limit violations all fail with deterministic, distinct,
actionable errors (issue #4 implements them; issue #6 assigns exit codes).
External strings — including the input file path — are sanitized before they
reach error messages or claim text: C0/C1 control characters, DEL, zero-width
and bidi formatting characters, line/paragraph separators, and U+FEFF are
escaped as literal `\uXXXX`.

## Fixtures

Committed fixtures under `test/fixtures/pfl-export/`:

| File | Expected |
| --- | --- |
| `valid-report.json` | accepted; representative report with findings |
| `valid-report-minimal.json` | accepted; smallest valid document |
| `valid-report-partial.json` | accepted; `partial` completeness, non-empty diagnostics, and unknown envelope/`data` fields |
| `empty-report.json` | accepted; zero findings, zero stats |
| `unsupported-version.json` | rejected (`pflVersion` 2.x) |
| `unsupported-version-low.json` | rejected (`pflVersion` below 1.0.0) |
| `wrong-command.json` | rejected (`command` is not `report`) |
| `failure-document.json` | rejected (`ok: false`) |
| `invalid-shape.json` | rejected (missing required `data` fields) |
| `invalid-diagnostics.json` | rejected (malformed `diagnostics` items) |
| `non-object.json` | rejected (top level is not an object) |
| `malformed.json` | rejected (not valid JSON) |
| `empty-file.json` | rejected (no JSON content) |
| `valid-export.json` | accepted; representative full snapshot with relations and findings |
| `valid-export-empty.json` | accepted; empty elements/relations/findings, null runtime version |
| `valid-export-partial.json` | accepted; `partial` completeness, diagnostics, nullable layers, and unknown additive fields |
| `export-failure-document.json` | rejected (`ok: false` export) |
| `unsupported-command-diff.json` | rejected (`command` is `diff`, not yet accepted) |
| `export-invalid-shape.json` | rejected (missing `data.snapshot`) |
| `export-mismatched-join.json` | rejected (`resolved.id` differs from element id) |
| `export-wrong-enum.json` | rejected (unknown `observed.status`) |
