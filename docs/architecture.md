# Gatefold architecture

Gatefold keeps the CLI, input boundary, analysis, domain model, and output formatters separate.

```text
JSON file                              two trace.json inputs
   ↓                                        ↓
pfl input reader                    yuurei trace reader
   ↓                                        ↓
PflExport                              YuureiTrace × 2
   ↓                                        ↓
analysis                    comparability validation
   ↓                                (reject on mismatch)
AnalysisResult                            ↓
   ↓                             trace comparison rules
human or JSON formatter                   ↓
                                TraceComparisonResult v4
                                          ↓
                               human or JSON formatter
```

## Module ownership

`src/cli.ts` parses command-line arguments — the single-document form, `compare`, `compare-traces`, and `compare-runs` — applies `--min-confidence` filtering, maps failures to stable exit codes, and selects the output format.

`src/input/bounded.ts` enforces the shared 16 MiB transport ceiling for file and stdin input. `src/input/pfl-export.ts` reads JSON and validates the full pfl export contract (`docs/pfl-export-contract.md`); `src/input/yuurei-trace.ts` does the same for the yuurei trace contract (`docs/yuurei-trace-contract.md`). `src/input/yuurei-run.ts` loads a whole run directory — trace, manifest, and digest-verified `patch.diff` — per `docs/yuurei-run-contract.md`, with `src/input/yuurei-patch.ts` parsing the patch grammar. Each reader keeps the raw parsed document so claim evidence can resolve against it.

`src/application/analyze.ts` owns the analysis entry point: it runs the `RULES` registry in `src/application/rules.ts` and validates the result against the claim schema before returning.

`src/application/compare.ts` joins two pfl exports and their diff (schema v3). `src/application/compare-traces.ts` does the same for two yuurei traces (schema v4). `src/application/compare-runs.ts` orchestrates the run-directory comparison (schema v5): the trace comparability checks and trace rules run unchanged, and `src/application/run-rules.ts` adds the manifest and generated-file claims: `src/application/trace-comparability.ts` enforces the cross-trace comparability policy and returns the allowed-difference caveats, and `src/application/trace-rules.ts` emits the per-run and A → B claims. Output amplification ceilings live in `src/application/limits.ts`.

`src/domain/claim.ts`, `src/domain/comparison.ts`, `src/domain/trace-comparison.ts`, and `src/domain/run-comparison.ts` define the v2, v3, v4, and v5 result types; the matching `src/domain/validate*.ts` modules enforce the committed JSON Schema invariants — including evidence-pointer resolution for comparison results — at each analysis boundary.

`src/application/evaluate-run.ts` and `src/application/compare-evaluations.ts` resolve task-spec criteria against a seeded run (schema v6) or two runs (schema v7), reading through `src/input/yuurei-seeded-run.ts`, `src/input/task-spec.ts`, and `src/input/check-report.ts`; `src/application/check-report-binding.ts` binds each supplied report to the run's declared subject digests. `src/application/audit-run.ts` (schema v8) audits one run directory without a spec: `src/input/yuurei-audit-run.ts` loads the same bounded records leniently — preserving states a strict reader would reject — and the application layer emits the fixed `docs/v0.8-scope.md` fact list, with `src/domain/audit.ts` defining the v8 types and `src/domain/validate-audit.ts` enforcing the result invariants and evidence resolution.

`src/output/human.ts` and `src/output/json.ts` render an analysis or comparison result.

The analysis modules do not read files or write to standard output. The CLI owns those effects.

## Deferred boundaries

The `pfl` export and `yuurei` trace are input contracts, not runtime package dependencies. Gatefold never executes either tool. For run-directory input it opens only `trace.json`, `artifacts.json`, and the digest-verified `patch.diff` — never `workspace/` or the log artifacts — and never follows a path recorded inside a run document.

Scoring does not belong in the architecture because confidence describes claim certainty, not harness quality.
