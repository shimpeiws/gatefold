# Supported yuurei run-directory contract

This document defines the exact yuurei run-directory shape Gatefold accepts
(release v0.6). It is grounded in yuurei's public contract (`docs/contract.md`
in the yuurei repository), its artifact collector (`src/artifact/collector.ts`,
`ArtifactManifest` with `sha256:` digests), and its patch builder
(`src/run/workspace.ts`, `buildPatch`), verified against yuurei `main` on
2026-09-27. Gatefold has no runtime dependency on yuurei; the run directory's
stored files are the only boundary.

## Accepted input

Gatefold accepts one kind of yuurei filesystem input: a **run directory** —
the directory `.yuurei/runs/<run-id>/` yuurei retains after a run. The
directory reaches Gatefold as a command-line argument that names a directory.
Standard input cannot carry a run directory, so `-` is not a valid run
argument.

Gatefold reads at most three members of the directory:

| Member | Requirement |
| --- | --- |
| `trace.json` | Required. Read and validated by the [yuurei trace contract](yuurei-trace-contract.md); a directory without a readable, valid trace is rejected. |
| `artifacts.json` | Required. The artifact manifest defined below; a directory without a readable, well-formed manifest is rejected. |
| `patch.diff` | Read only when the manifest lists it. The one artifact whose bytes Gatefold interprets in v0.6. |

Everything else in the directory is outside this contract's boundary:
`stdout.log`, `stderr.log`, `resolved-profile.json`, `workspace/`, and any
other member are never opened. `workspace/` is not an artifact — yuurei never
lists it in `artifacts.json` — and it is not scrubbed, so Gatefold does not
read it in this milestone. Logs are recorded in the manifest but their content
is never interpreted; no claim is inferred from free-text log output.

A path named inside a trace, a manifest, or a patch is **data, not an access
instruction**. Gatefold never follows a recorded path to another location:
artifact bytes are read only at manifest-declared paths resolved inside the
selected run directory, and patch text is parsed, never executed.

## `artifacts.json`

The manifest is a single JSON object with one required array:

```json
{ "artifacts": [
  { "path": "patch.diff", "kind": "patch", "digest": "sha256:…", "truncated": true },
  { "path": "stdout.log", "kind": "log", "digest": "sha256:…" }
] }
```

| Field | Type | Meaning |
| --- | --- | --- |
| `artifacts` | array, required | The collected artifact entries, in the order yuurei recorded them. |
| `artifacts[].path` | string, required | Artifact path relative to the run directory root, POSIX separators. |
| `artifacts[].kind` | string, required | yuurei's path-derived classification (`patch`, `log`, `file`). Never authoritative: Gatefold decides what to read from the path alone, never from `kind`. |
| `artifacts[].digest` | string, required | `sha256:<64 lowercase hex>` over the artifact **as stored** — after redaction and after any truncation — not over the bytes the runtime emitted. |
| `artifacts[].truncated` | boolean, optional | When `true`, the stored bytes were cut at yuurei's size cap; the digest still covers the stored (cut) bytes. |

Unknown fields are ignored, matching yuurei's additive-change rule. A manifest
that is not an object, lacks the `artifacts` array, or carries an entry that
is not an object with string `path`/`kind`/`digest` fields is rejected with
`invalid-shape`.

### Entry path confinement

Every `path` must be a relative POSIX path confined to the run directory:
non-empty, with no empty components, no `.` or `..` components, no NUL, and
not absolute (a leading `/` or a `<drive>:` form). A manifest carrying an
unconfined or malformed path fails closed: the whole run directory is rejected
with `invalid-shape` naming the entry, because a manifest that names outside
locations is not a trustworthy description of this run.

For `patch.diff` — the one artifact whose bytes Gatefold reads — the path is
additionally resolved on the filesystem: the resolved real path must stay
inside the run directory's own real path and must name a regular file. A
symlink escape or a non-regular target is rejected the same way. Entries
Gatefold does not read are never resolved; their paths are validated
lexically only.

### Digest verification and entry states

Each manifest entry ends in exactly one state. The state describes whether
the stored bytes can be trusted as what yuurei recorded — it is a
verification outcome, never a quality judgement:

| State | Meaning |
| --- | --- |
| `verified` | `patch.diff` entry: bytes read within the size ceiling, sha256 digest matches the manifest, `truncated` not set. |
| `verified-truncated` | Digest matches and the manifest records `truncated: true`: the verified bytes are a cut prefix of what the run emitted. |
| `digest-mismatch` | Bytes were read but do not hash to the recorded digest. The stored content cannot be trusted as what yuurei recorded and is never interpreted. |
| `missing` | The manifest lists the path but no readable regular file exists there. |
| `unverified` | The entry is not verified in this milestone: any path other than `patch.diff` (kind never read), a digest that is not `sha256:<64 hex>`, or a file that cannot be read within the byte ceiling. Manifest facts are preserved; the bytes are never interpreted. |

For read entries the stored byte count is recorded alongside the state.
An artifact **absent** from the manifest was not collected; per yuurei's
contract, absence never means the run produced nothing. In particular a
missing `patch.diff` entry is reported as "not recorded" — never as "the run
produced no output".

## `patch.diff`

Gatefold interprets one artifact: the `patch.diff` text patch. Per yuurei's
contract it is a UTF-8, LF-terminated unified diff of **additions against an
empty workspace** — every recorded file was written into an initially empty
cell workspace, so the patch describes generated output, never edits against
a project baseline.

### Grammar

Zero or more file blocks, in ascending UTF-8 byte order of the relative path
(the reader does not require the order, but uses it as written evidence):

```text
--- /dev/null
+++ <path>
@@ -0,0 +1,N @@
+<line 1>
…
+<line N>
\ No newline at end of file    ← only when the stored file lacks a trailing LF
```

- `<path>` is the workspace-relative path on the `+++ ` line (forward
  slashes, per yuurei's name rules). An empty file is represented by its two
  header lines alone, with no hunk.
- A block's hunk header is `@@ -0,0 +1,N @@` followed by exactly N
  `+`-prefixed content lines.
- Every line is LF-terminated and the file ends at an LF boundary; a partial
  final line can only appear in bytes the manifest marks truncated.

A file the run wrote may legitimately be absent from `patch.diff`: yuurei
omits binary content (NUL or invalid UTF-8), oversized files, files past the
total patch cap, and unrepresentably named files, and records each omission
in the trace's `diagnostics`. A file absent from the patch is therefore never
claimed absent from the workspace.

### Malformed versus truncated

When the manifest records `truncated: true`, an incomplete final block is
accepted: the complete prefix is parsed and the cut tail is reported as
unknown. When the entry is not marked truncated, bytes that violate the
grammar make the patch `malformed`: verified bytes that Gatefold cannot
interpret, so no file-level claims are emitted from it.

## Evidence locations

v0.6 claim evidence names a run side and the document inside it. `source` is
one of:

| Source | Resolves against |
| --- | --- |
| `beforeTrace` / `afterTrace` | The run's `trace.json`; `pointer` is an RFC 6901 JSON Pointer per the [trace contract](yuurei-trace-contract.md). |
| `beforeManifest` / `afterManifest` | The run's `artifacts.json`; `pointer` may be `""`, `/artifacts`, `/artifacts/<n>`, or `/artifacts/<n>/<field>`. |
| `beforePatch` / `afterPatch` | The run's stored `patch.diff` bytes. `pointer` is the manifest pointer of the `patch.diff` entry (for example `/artifacts/0`), binding the citation to the manifest record. `digest` repeats the verified stored digest. `path` names the cited generated file. `lines` `{start, end}` is a 1-based inclusive line range and `bytes` `{start, end}` a 0-based half-open byte range into the stored patch bytes. |

Every emitted `pointer` must resolve to a location that exists in the named
document, and every `lines`/`bytes` range must lie inside the verified patch
bytes. A file absent from a patch has no range; its absence is cited through
the patch entry's manifest pointer with a `note`. An artifact absent from the
manifest is cited through the manifest root `""` with a `note`.

## Limits

A run directory is untrusted input; the reader enforces resource ceilings:

- `trace.json` and `artifacts.json` each honor the shared 16 MiB document
  ceiling. `patch.diff` is read under the same 16 MiB ceiling; a larger
  stored file is `unverified`, never read further.
- More than 10,000 manifest entries, or any manifest scalar string longer
  than 4,096 characters, is `invalid-shape`.
- A patch with more than 65,536 file blocks is `malformed` (a verified patch
  that large is outside what this milestone interprets).

## Error behavior

| Condition | Code | Exit |
| --- | --- | --- |
| Argument is not a readable directory, or `trace.json`/`artifacts.json` cannot be read | `unreadable-file` | 3 |
| `artifacts.json` is not valid JSON | `invalid-json` | 3 |
| Manifest shape violation, unconfined entry path, symlink escape, non-regular artifact target, or limit violation | `invalid-shape` | 3 |
| `trace.json` violations | the trace contract's codes | 3 |

External strings — including directory and manifest paths — are sanitized
before they reach error messages or claim text, exactly as in the trace
contract.

## Fixtures

Committed fixture run directories under `test/fixtures/yuurei-run/` cover at
minimum:

| Fixture | Expected |
| --- | --- |
| `run-a/`, `run-b/` | Comparable runs whose verified patches differ: one file changed, one removed, one added. |
| `run-a2/` | A run whose patch content is identical to `run-a/`'s under a different run id and profile. |
| `run-empty/` | A run whose manifest lists a verified, empty `patch.diff`. |
| `run-nopatch/` | A run whose manifest records no `patch.diff` entry. |
| `run-truncated/` | A run whose verified `patch.diff` is marked `truncated: true` and ends mid-block. |
| `run-unreadable-diff/` | A run whose manifest records a non-`sha256:` digest for `patch.diff`. |

Corrupt manifests, digest mismatches, missing artifact files, traversal
entries, and symlink escapes are produced by tests in temporary directories.
