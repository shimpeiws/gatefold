# Supported yuurei trace contract

This document defines the exact `yuurei` trace shape Gatefold accepts
(planned for release v0.5). It is grounded in yuurei's public contract
(`docs/contract.md` in the yuurei repository) and its trace schema
(`src/trace/schema.ts`, `TraceSchema` with `TRACE_SCHEMA_VERSION = "0.3"`),
verified against yuurei `main` on 2026-09-27. Gatefold has no runtime
dependency on yuurei; the trace document is the only boundary.

## Accepted document

Gatefold accepts one kind of yuurei document: a `trace.json` object — the
identity-and-outcome record yuurei writes atomically at the end of a run into
`.yuurei/runs/<run-id>/trace.json`. The same object is what
`yuurei trace show --json` prints on one line; because unknown fields are
ignored, a `trace show --json` line is also an acceptable trace (its added
`level` and `message` fields are simply unknown).

The document reaches Gatefold as a file argument or on standard input.
Stdin is an additional transport for the same document, not a new document
kind: identical byte limit, JSON validation, and contract checks apply, and
the result records `<stdin>` as the input label.

Gatefold reads only the trace document itself. It never opens the run
directory the trace came from, never reads `stdout.log`, `stderr.log`,
`artifacts.json`, `resolved-profile.json`, `patch.diff`, or `workspace/`, and
never follows a path recorded inside the trace.

## Envelope

Every accepted document is a single JSON object. Unlike a pfl document, a
yuurei trace has no `command`, `ok`, or `completeness` envelope: the trace's
presence in a run directory already means the run reached its end. A single
leading UTF-8 BOM is tolerated as part of the transport encoding and stripped
before parsing; a BOM anywhere else is invalid JSON.

Required fields:

| Field | Type | Meaning |
| --- | --- | --- |
| `schema_version` | string | Trace compatibility token. Must equal `"0.3"` exactly; see Compatibility. |
| `run_id` | string | Identifier of the run that produced the trace. |
| `started_at` | string | Run start timestamp as recorded by yuurei. |
| `finished_at` | string | Run end timestamp as recorded by yuurei. |
| `runtime` | object | `{ id: string, version: string \| null }` — the runtime identity and its observed version. |
| `model` | object | `{ requested: string, resolved: string \| null, resolved_reason?: "observed" \| "unobserved" \| "parse_failed" }` — the requested model identity and the model observed to have run. |
| `profile` | object | `{ name: string, digest: string }` — the profile's name (provenance) and content digest (identity). |
| `task` | object | `{ source: string, digest: string }` — the task's path or origin (provenance) and content digest (identity). |
| `isolation` | object | `{ strategy: string, verified: boolean }` — the isolation strategy requested for the cell and whether verification succeeded. |
| `execution` | object | `{ exit_code: number \| null, signal: string \| null, duration_ms: number \| null, timed_out: boolean }` — the recorded outcome of the run. |
| `usage` | object | Record of usage key → `number \| null`; see Missing and null semantics. |
| `cost` | object \| null | `{ amount: number, currency: string }` when an estimate was produced, else `null`. |
| `artifacts` | array | Items `{ path: string, kind: string }` naming what the run produced. `kind` is derived from `path` and is never authoritative. |

Recognized optional fields — absent on traces written before they existed;
absence means _unknown_, never _different_:

| Field | Type | Meaning |
| --- | --- | --- |
| `yuurei_version` | string | Version of the yuurei that wrote the trace. An observed property, not a digest input. |
| `requested_cell` | object | `{ digest: string, inputs_version: integer }` — the requested-cell digest and the version of the input set that produced it. |
| `execution_options` | object | `{ timeout_ms: integer \| null, runtime: object }` — the execution contracts that form cell identity: the core timeout plus the adapter-owned record. |
| `definition` | object | `{ run: string \| null, cli_overrides: string[] }` — how the run was specified: the named run, or `null` for the `--profile`/`--task` form, and which parameter fields the CLI overrode (field names, never values). |
| `diagnostics` | array | Strings; the durable, secret-free record of non-fatal notes (for example skipped or omitted artifacts). Fixed strings, never parsed into codes. |

## Missing and null semantics

yuurei's rule is that a reader treats an absent field as unknown, never as
different. Gatefold applies it field by field:

- An absent optional field (`yuurei_version`, `requested_cell`,
  `execution_options`, `definition`, `diagnostics`, `model.resolved_reason`)
  means the trace was written before the field existed or the run did not
  record it. Claims state the absence; they never treat it as a value.
- `model.resolved: null` means the effective model was not observed.
  `model.resolved_reason` distinguishes `"unobserved"` (the runtime produced
  no model identity) from `"parse_failed"` (an expected source existed but
  could not be read); `"observed"` accompanies a non-null `resolved` and is
  omitted by yuurei when redundant, so its absence is not an error.
- `execution.exit_code: null` means no exit code was recorded (for example a
  signal-terminated run); `execution.signal` names the signal when one was
  observed. `execution.duration_ms: null` means the duration was not
  measured. `execution.timed_out` is always present and records whether the
  run hit its timeout. A null field is an unobserved value, never a zero.
- `usage` is a record: a key **absent** means the measurement was never
  attempted; a key present with value `null` means it was attempted but not
  observed. The two cases are distinct and are reported distinctly.
- `cost: null` means no estimate was produced for the run (the cost model is
  a no-op in yuurei v0.3). `null` is never read as a zero amount.

## Unknown fields

Readers ignore unknown fields, matching yuurei's compatibility rule: adding
an optional field does not change the compatibility class, so a trace with
extra fields is still accepted. Removing or renaming a required field is a
breaking change on yuurei's side and is handled by the schema token, not by
guessing.

## Compatibility

- Accepted `schema_version` tokens: `"0.3"` only. The token is a
  compatibility class compared for **equality** — it is not a semver range,
  carries no ordering, and is never compared with `<` or `>` despite its
  dotted spelling. A trace with any other token is rejected rather than
  guessed at; when yuurei defines a new class, acceptance is an explicit
  contract change here.
- `yuurei_version` is independent of `schema_version` (a yuurei 1.0 product
  ships traces labelled `0.3`). It is recorded for provenance and never used
  for acceptance.
- Traces written before the optional fields existed are accepted; their
  absent fields are handled per Missing and null semantics.
- `requested_cell.inputs_version` is the comparability token between two
  traces: it is compared for equality, never ordered, and a trace pair whose
  input-set versions differ is never compared — even when the digests are
  equal. See [v0.5 scope](v0.5-scope.md).

## Evidence locations

Claim evidence `pointer` values (JSON Pointer, RFC 6901) may reference the
whole trace (`""`), any top-level field (`/schema_version`, `/run_id`,
`/started_at`, `/finished_at`), and any subpath of a field, for example:

- `/runtime/id`, `/runtime/version`
- `/model/requested`, `/model/resolved`, `/model/resolved_reason`
- `/profile/name`, `/profile/digest`, `/task/source`, `/task/digest`
- `/requested_cell/digest`, `/requested_cell/inputs_version`
- `/isolation/strategy`, `/isolation/verified`
- `/execution_options/timeout_ms`, `/execution_options/runtime/<key>`
- `/definition/run`, `/definition/cli_overrides/<n>`
- `/execution/exit_code`, `/execution/signal`, `/execution/duration_ms`,
  `/execution/timed_out`
- `/usage/<key>` — usage keys are arbitrary strings, so `~` and `/` in a key
  are escaped `~0` / `~1` per RFC 6901
- `/cost/amount`, `/cost/currency`
- `/artifacts/<n>`, `/artifacts/<n>/path`
- `/diagnostics/<n>`

Every emitted pointer must resolve to a location that exists in the named
trace. An absent field has no pointer: its absence is cited through the
parent object (`/model`, `/requested_cell` when present, or `""`) with a
`note` naming the missing field.

## Limits

yuurei traces are untrusted input, so the reader enforces resource ceilings:
input documents larger than 16 MiB (measured in bytes; regular files are
rejected by size before reading, and pipes are cut off at the limit), more
than 10,000 `artifacts` items, more than 10,000 `diagnostics` entries, more
than 1,000 `usage` keys, more than 1,000 `definition.cli_overrides` entries,
more than 1,000 `execution_options.runtime` keys, or any scalar string
longer than 4,096 characters are rejected with `invalid-shape` errors.
`execution_options.runtime` values are bounded safe JSON: strings, numbers,
booleans, null, arrays, and string-keyed objects, nested at most 12 levels
deep and at most 10,000 nodes.

## Error behavior

Unreadable file, invalid JSON, non-object top level, a `schema_version`
other than `"0.3"`, missing or wrongly-typed required fields, and limit
violations all fail with deterministic, distinct, actionable errors. The
error code for a rejected token is `unsupported-version`; malformed shape is
`invalid-shape`; both exit with code 3. External strings — including the
input file path — are sanitized before they reach error messages or claim
text: C0/C1 control characters, DEL, zero-width and bidi formatting
characters, line/paragraph separators, and U+FEFF are escaped as literal
`\uXXXX`.

A document that parses but is not a yuurei trace — for example a pfl
report/export/diff document passed where a trace is expected — is rejected
with `mismatched-inputs` naming the expected and actual document kinds.

## Fixtures

Committed fixtures under `test/fixtures/yuurei-trace/` (added by the reader
issue, #45) cover at minimum:

| Fixture | Expected |
| --- | --- |
| Valid schema 0.3 trace, all fields present | accepted |
| Valid trace missing every optional field (older-trace shape) | accepted; absent fields are unknown |
| `model.resolved: null` with each `resolved_reason` | accepted; reported as unobserved |
| `usage` with absent keys, null values, and observed values | accepted; the three cases stay distinct |
| `cost: null` | accepted; unestimated, never zero |
| `execution` nulls and `timed_out: true` | accepted; unobserved values and timeout recorded |
| Unknown additive fields | accepted; ignored |
| Wrong `schema_version` token | rejected (`unsupported-version`) |
| Missing/wrongly-typed required fields | rejected (`invalid-shape`) |
| Malformed JSON / non-object top level | rejected (`invalid-json` / `invalid-shape`) |
| Limit violations | rejected (`invalid-shape`) |
