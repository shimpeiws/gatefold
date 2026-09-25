# Gatefold architecture

Gatefold keeps the CLI, input boundary, analysis, domain model, and output formatters separate.

```text
JSON file
   ↓
input reader
   ↓
PflExport
   ↓
analysis
   ↓
AnalysisResult
   ↓
human or JSON formatter
```

## Module ownership

`src/cli.ts` parses command-line arguments, applies `--min-confidence` filtering, maps failures to stable exit codes, and selects the output format.

`src/input/pfl-export.ts` reads JSON and validates the full pfl export contract (`docs/pfl-export-contract.md`).

`src/application/analyze.ts` owns the analysis entry point: it runs the `RULES` registry in `src/application/rules.ts` and validates the result against the claim schema before returning.

`src/domain/claim.ts` defines the claim and result types; `src/domain/validate.ts` enforces the committed JSON Schema invariants at the analysis boundary.

`src/output/human.ts` and `src/output/json.ts` render an analysis result.

The analysis module does not read files or write to standard output. The CLI owns those effects.

## Deferred boundaries

The `pfl` export is an input contract, not a runtime package dependency.

`yuurei` integration belongs at a future input boundary for observed traces.

Scoring does not belong in the initial architecture because confidence describes claim certainty, not harness quality.
