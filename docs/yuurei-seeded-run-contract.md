# Supported yuurei seeded-run contract

This document defines the seeded-workspace additions to the
[yuurei run-directory contract](yuurei-run-contract.md) that Gatefold accepts
(release v0.7). It is grounded in the yuurei public contract and the accepted
yuurei issues [#202](https://github.com/shimpeiws/yuurei/issues/202) (seeded
workspace, baseline identity, baseline-relative diff) and
[#190](https://github.com/shimpeiws/yuurei/issues/190) (durable final result).

**Pinning note.** Those yuurei features are specified but not yet shipped in
yuurei `main` (verified 2026-09-27). Where this document names a field that
yuurei has not shipped — `baseline`, `final_result`, the `a/`/`b/` diff
prefixes, the `result.txt` artifact path — the name is Gatefold's accepted
contract and will be re-pinned to the shipped upstream names when they land.
Fields that yuurei does ship (`requested_cell`, `task.digest`,
`model.resolved`/`resolved_reason`, `usage`, `cost`, `artifacts`,
`diagnostics`) keep their shipped names and semantics unchanged.

Everything in the v0.6 run-directory contract still applies: the same three
members are read, the same confinement/digest rules hold, and a seeded run
directory is still untrusted input.

## Seeded provenance

A seeded run records the identity of the tree materialized into the cell
before execution, as an optional additive field of `trace.json`:

```json
"baseline": {
  "digest": "sha256:<64 lowercase hex>",
  "source": "seed://path/to/tree"
}
```

| Field | Type | Meaning |
| --- | --- | --- |
| `baseline.digest` | string, required when `baseline` is present | Stable identity of the seeded tree's content and paths. Compared for equality only, never ordered. |
| `baseline.source` | string, optional | Provenance: where the seed tree came from. Display only, never part of identity. |

A run whose trace carries `baseline` is a **seeded run**; a run without it is a
**legacy empty-workspace run**. The field is additive per yuurei's versioning
rule: absent means unknown (the run is treated as a legacy run), never as a
negative fact. `baseline.digest` is a candidate input to yuurei's
`requested_cell.digest` upstream; Gatefold compares the baseline digest itself
for evaluation comparability and never recomputes a cell digest.

Unknown fields inside `baseline` are ignored. A `baseline` that is not an
object, or whose `digest` is missing or not a non-empty string, fails
`invalid-shape`.

## The baseline-relative `patch.diff`

In a seeded run the stored `patch.diff` is a unified diff **against the seeded
baseline**, not an all-additions diff. The grammar per file block:

```text
--- a/<path>          (or --- /dev/null when the file was added)
+++ b/<path>          (or +++ /dev/null when the file was deleted)
@@ -s1,c1 +s2,c2 @@   (one or more hunks per block)
 context line
-removed line
+added line
\ No newline at end of file    ← where the stored file lacks a trailing LF
```

- `a/` and `b/` prefixes are required on non-`/dev/null` headers. A
  non-prefixed path is a grammar violation in a seeded patch — it cannot be
  distinguished from a legacy addition block.
- The recorded file path is the `b/`-side path for added and modified blocks,
  the `a/`-side path for deleted blocks (`+++ /dev/null`).
- Each block's change kind is one of `added` (`--- /dev/null`), `modified`
  (both sides named), or `deleted` (`+++ /dev/null`).
- Hunk content lines are ` ` context, `-` removed, `+` added. For verified,
  non-truncated bytes each hunk's old-side line count (` ` + `-`) must equal
  its declared old count and its new-side line count (` ` + `+`) must equal
  its declared new count; a mismatch is `malformed`.
- Blocks may appear in any order; each workspace path appears at most once — a
  repeat is `malformed`, under either truncation marking.
- The malformed-versus-truncated rule of the legacy grammar applies unchanged:
  under `truncated: true` an unsealed tail is reported unknown rather than
  failing the parse.

A file the run changed may still be absent from the patch for the reasons in
the v0.6 contract (binary, oversized, over-cap, unrepresentable name), so
absence from the patch is never claimed as absence from the workspace.

## The final result artifact: `result.txt`

Yuurei persists the runtime's final assistant result as a redacted, capped
artifact in the run directory. Gatefold reads it at the path `result.txt` when
the manifest lists it, under the same confinement, ceiling, and sha256
digest-verification rules as `patch.diff`. The stored text is **data**: it is
compared against criteria, never executed, never parsed as a log, and a claim
inside it is never treated as a test result.

The honesty marker distinguishing "no result was emitted" from "a result
existed but could not be read" is an optional additive trace field:

```json
"final_result": { "status": "recorded" }
```

| `final_result.status` | Meaning |
| --- | --- |
| `recorded` | A result was emitted and persisted; the manifest must list `result.txt`. A `recorded` status with no manifest entry is contradictory and the entry state is `missing`. |
| `not_emitted` | The runtime produced no final result. Honest absence, distinct from a read failure. |
| `parse_failed` | A result source existed but could not be extracted. The result is explicitly unavailable. |

When `final_result` is absent (older or legacy traces), availability is
inferred from the manifest alone: a listed `result.txt` is verified as usual;
no entry means the result was **not recorded**, without distinguishing
"not emitted" from "parse failed". The `resultState` summary reported to
consumers is one of: `verified`, `verified-truncated`, `digest-mismatch`,
`missing`, `unverified`, `not-emitted`, `parse-failed`, `not-recorded`.
A `final_result` that is not an object, or whose `status` is not one of the
three values, fails `invalid-shape`.

## Evidence locations

v0.7 adds two evidence sources to the v0.6 set, usable by `evaluate-run` and
`compare-evaluations` claims:

| Source | Resolves against |
| --- | --- |
| `patch` (single-run form) | The run's stored `patch.diff` bytes; same reference shape as `beforePatch`/`afterPatch`. |
| `result` (single-run form) | The stored `result.txt` bytes. `pointer` is the manifest pointer of the `result.txt` entry; `digest` repeats the verified stored digest; `lines`/`bytes` ranges bound into the verified result bytes. |
| `beforeResult` / `afterResult` | The `result` source for the A/B sides of a comparison. |
| `spec` | The task-evaluation spec document; `pointer` is an RFC 6901 JSON Pointer into it (for example `/criteria/3`). |
| `checkReport` / `beforeCheckReport` / `afterCheckReport` | A supplied external check-report document; `pointer` is a JSON Pointer into it (for example `/results/2`). |

Every emitted pointer must resolve inside the named document, and every
`lines`/`bytes` range must lie inside the named artifact's verified bytes.

## Limits and errors

- `result.txt` is read under the shared 16 MiB document ceiling like
  `patch.diff`; a larger stored file is `unverified`.
- Seeded patch limits are unchanged: more than 65,536 file blocks is
  `malformed`.
- `baseline`/`final_result` shape violations are `invalid-shape` (exit 3).
- All other limits and error codes are inherited from the v0.6 run-directory
  contract unchanged.
