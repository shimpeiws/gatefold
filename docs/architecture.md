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

`src/cli.ts` parses command-line arguments and selects the output format.

`src/input/pfl-export.ts` reads JSON and validates the top-level input shape.

`src/application/analyze.ts` owns the analysis entry point.

`src/domain/claim.ts` defines the claim and result types.

`src/output/human.ts` and `src/output/json.ts` render an analysis result.

The analysis module does not read files or write to standard output. The CLI owns those effects.

## Deferred boundaries

The `pfl` export is an input contract, not a runtime package dependency.

`yuurei` integration belongs at a future input boundary for observed traces.

Scoring does not belong in the initial architecture because confidence describes claim certainty, not harness quality.
