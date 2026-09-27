# Supported yuurei seeded-run contract

This document defines the seeded-workspace additions to the
[yuurei run-directory contract](yuurei-run-contract.md) that Gatefold accepts
(release v0.7). It is grounded in the shipped yuurei implementation of
[yuurei #202](https://github.com/shimpeiws/yuurei/issues/202) (seeded
workspace, baseline identity, baseline-relative diff), verified at yuurei
`d420ba3f026d7b6148ea0222a1136c4a3f2e9d69`.

Everything in the v0.6 run-directory contract still applies: the same
confinement, digest-verification, and untrusted-input rules hold for every
member Gatefold reads.

## Seeded provenance

A seeded run records where its workspace came from as an optional additive
field of `trace.json`:

```json
"seed": {
  "policy": "git-tracked-files",
  "source": "/path/to/seed/tree",
  "head": "0123456789abcdef0123456789abcdef01234567",
  "baseline": {
    "requested_digest": "sha256:<64 lowercase hex>",
    "materialized_digest": "sha256:<64 lowercase hex>",
    "files": 4,
    "bytes": 141
  },
  "changes": { "added": 1, "modified": 1, "deleted": 1 }
}
```

| Field | Type | Meaning |
| --- | --- | --- |
| `seed.policy` | string, required | The seeding policy; only `"git-tracked-files"` is accepted. Any other value is `invalid-shape`. |
| `seed.source` | string, required | Provenance: where the seed tree came from. Display only, never part of identity. |
| `seed.head` | string, required | The commit the seed tree was taken from. Provenance like `source`; not part of the baseline identity. |
| `seed.baseline.requested_digest` | string, required | Identity of the seeded tree's content and paths, computed from the canonical tracked-file manifest. Compared for equality only, never ordered. |
| `seed.baseline.materialized_digest` | string, required | Identity of the tree actually materialized into the cell. Shipped yuurei aborts before writing a trace when the two digests differ, so a record where they differ is `invalid-shape`. |
| `seed.baseline.files` | integer ≥ 0, required | File count of the materialized tree. |
| `seed.baseline.bytes` | integer ≥ 0, required | Total byte size of the materialized tree. |
| `seed.changes` | object, optional | Counts of the change set the run produced, when change collection completed. Each of `added`, `modified`, `deleted` is an integer ≥ 0. Omitted means the change set is **unknown** — collection did not complete — never that the run changed nothing. |

A run whose trace carries `seed` is a **seeded run**; a run without it is a
**legacy empty-workspace run**. A seeded run additionally records
`requested_cell.inputs_version: 2`; a legacy run records `1`. The seed, the
patch record's `base`, and `inputs_version` must agree — any contradiction
(`seed` with `base: "empty"`, `base: "seeded"` without `seed`, `inputs_version`
that does not match the seeded status) is `invalid-shape`.

## The `patch` completeness record

The trace carries an optional additive record of how completely the run's
stored `patch.diff` covers the workspace changes:

```json
"patch": { "base": "seeded", "state": "partial" }
```

| Field | Type | Meaning |
| --- | --- | --- |
| `patch.base` | string, required | `"seeded"` when the workspace was seeded, `"empty"` otherwise. Must agree with the `seed` record as above. |
| `patch.state` | string, required | `"complete"`: the patch is a full change record. `"partial"`: the patch is recorded but may omit files — redacted, truncated, binary, oversized, unrepresentably named, over the total cap, or lacking baseline content. `"absent"`: patch generation did not succeed and no `patch.diff` was published. |

`patch.state` and the manifest's `patch.diff` record must agree: `absent`
with a manifest entry, or a non-`absent` state with no entry, is
`invalid-shape`; a `complete` state over an entry marked `truncated: true` is
`invalid-shape`. The same holds for the fixed diagnostic
`patch: generation failed; patch.diff not recorded`, which asserts the same
absence and never coexists with a patch entry.

`state: "partial"` is produced by the counted omission diagnostics
(`patch: <n> binary file(s) omitted`, `patch: <n> oversized file(s) omitted`,
`patch: <n> unrepresentable name(s) omitted`,
`patch: <n> file(s) omitted over the total cap`, and
`patch: <n> file(s) omitted; baseline content unavailable`). On traces that
predate the `patch` record, those diagnostics are the only signal that a
stored patch may be partial; Gatefold treats an absent criterion file as
unknown, never absent.

## The baseline-relative `patch.diff`

In a seeded run the stored `patch.diff` is a unified diff **against the
seeded baseline**, not an all-additions diff. The shipped grammar per file
block:

```text
--- <path>            (or --- /dev/null when the file was added)
+++ <path>            (or +++ /dev/null when the file was deleted)
@@ -s1,c1 +s2,c2 @@   (one or more hunks per block)
 context line
-removed line
+added line
\ No newline at end of file    ← where the stored file lacks a trailing LF
```

- Non-`/dev/null` headers carry the workspace-relative path **without**
  `a/`/`b/` prefixes — that is the shipped yuurei patch format. A git-style
  `a/<path>`/`b/<path>` pair has differing header paths and is `malformed`.
- The recorded file path is the `+++`-side path for added and modified
  blocks, the `---`-side path for deleted blocks (`+++ /dev/null`).
- Each block's change kind is one of `added` (`--- /dev/null`), `modified`
  (both sides named — yuurei emits no renames, so the two paths must be
  equal), or `deleted` (`+++ /dev/null`).
- Hunk content lines are ` ` context, `-` removed, `+` added. For verified,
  non-truncated bytes each hunk's old-side line count (` ` + `-`) must equal
  its declared old count and its new-side line count (` ` + `+`) must equal
  its declared new count; a mismatch is `malformed`.
- Blocks may appear in any order; each workspace path appears at most once —
  a repeat is `malformed`, under either truncation marking.
- The malformed-versus-truncated rule of the legacy grammar applies
  unchanged: under `truncated: true` an unsealed tail is reported unknown
  rather than failing the parse.

A file the run changed may still be absent from the patch for the reasons in
the v0.6 contract (binary, oversized, over-cap, unrepresentable name) plus
baseline-content unavailability, so absence from a partial patch is never
claimed as absence from the workspace.

## Seeded supplemental artifacts

A seeded run can store two durable records alongside the patch. Both are
classified `kind: "file"` and digested whole (yuurei's collector exempts them
from truncation), so a manifest-listed, digest-verified copy is complete:

- `baseline-manifest.json` — the canonical tracked-file manifest the seed
  was materialized from:

  ```json
  {
    "version": 1,
    "policy": "git-tracked-files",
    "source": "…",
    "head": "…",
    "requested_digest": "sha256:…",
    "materialized_digest": "sha256:…",
    "files": { "<path>": { "digest": "…", "mode": 420, "bytes": 16 } }
  }
  ```

- `changes.json` — the durable change-set record, written only when change
  collection completed:

  ```json
  {
    "version": 1,
    "baseline_digest": "sha256:…",
    "added": ["<path>"],
    "modified": ["<path>"],
    "deleted": ["<path>"]
  }
  ```

Both documents are produced from the same resolved seed and change set the
trace describes, so a verified copy must restate the trace record exactly:
`baseline-manifest.json` must match `seed`'s version, policy, source, head,
and digests, and its `files` map must have `seed.baseline.files` entries;
`changes.json` must match the baseline digest and per-kind counts of
`seed.changes`, and can exist only when `seed.changes` does. A verified
`changes.json` must also agree with the parsed patch: every patch block names
a path the manifest lists under its kind, and under a `complete` patch record
the per-kind sets are exactly equal (under `partial`, or a trace without the
record, the patch is a subset). Any disagreement is `invalid-shape`.

`seed.changes` bounds an honest patch the same way when no `changes.json` is
verified: more patch blocks of a kind than the trace counts is
`invalid-shape`, and a `complete` patch record with fewer is a claim the
stored bytes do not support. Shipped yuurei produces a patch only when the
change collection that writes `seed.changes` completes, so a non-`absent`
patch record over an absent `seed.changes` is `invalid-shape` too.

## The final result artifact: `result.txt`

Yuurei persists the runtime's final assistant result as a redacted, capped
artifact in the run directory. Gatefold reads it at the path `result.txt`
when the manifest lists it, under the same confinement, ceiling, and sha256
digest-verification rules as `patch.diff`. The stored text is **data**: it is
compared against criteria, never executed, never parsed as a log, and a claim
inside it is never treated as a test result.

A listed `result.txt` entry decides availability by its entry state. When no
entry exists, the trace's fixed result diagnostics carry the reason:

| Diagnostic | `resultState` |
| --- | --- |
| `result: no final message emitted` | `not-emitted` |
| `result: final message could not be parsed` | `parse-failed` |
| `result: save failed; result.txt not recorded` | `save-failed` |
| (none, and no manifest entry) | `not-recorded` |

The `resultState` summary reported to consumers is one of: `verified`,
`verified-truncated`, `digest-mismatch`, `missing`, `unverified`,
`not-emitted`, `parse-failed`, `save-failed`, `not-recorded`.

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

Trace evidence pointers may also name the completeness records
(`/patch/state`, `/seed/changes/added`) or a diagnostic (`/diagnostics/<n>`)
when those are what a verdict rests on. Every emitted pointer must resolve
inside the named document, and every `lines`/`bytes` range must lie inside
the named artifact's verified bytes.

## Limits and errors

- `result.txt`, `baseline-manifest.json`, and `changes.json` are read under
  the shared 16 MiB document ceiling like `patch.diff`; a larger stored file
  is `unverified`.
- Seeded patch limits are unchanged: more than 65,536 file blocks is
  `malformed`.
- `seed`/`patch` shape violations and every consistency failure described
  above are `invalid-shape` (exit 3).
- All other limits and error codes are inherited from the v0.6 run-directory
  contract unchanged.
