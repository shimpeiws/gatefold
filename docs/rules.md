# v0.1 rule catalog

The analyzer (`src/application/rules.ts`) registers an explicit list of
descriptive rules. Each rule emits claims about what the export contains —
never a judgement of whether the harness is good or bad. Every claim carries
evidence, provenance, and confidence per `schema/claim-result.v1.json`.

| Rule id | What it claims | Confidence |
| --- | --- | --- |
| `runtime-described` | Which runtime and project the export describes. | 1.0 |
| `element-counts` | The observed/effective/shadowed/conditional/opaque element counts. | 1.0 when `completeness` is `complete`, else 0.8 |
| `facet-composition` | Per-facet element counts from `stats.byFacet`. | same as `element-counts` |
| `finding-reported` | Each finding the export carries: rule id, message, cited element ids. | 1.0 |
| `completeness-reported` | When the export is `partial` or `unknown`, that fact and the diagnostic count. Emitted only for non-complete exports. | 1.0 |

## Conventions

- Claim order is deterministic: registry order, then document order within a
  rule. `facet-composition` emits facets sorted by facet name.
- Evidence pointers are JSON Pointers into the export document at the locations
  the input contract permits (`docs/pfl-export-contract.md`).
- Provenance records the source file, the export's `pflVersion`, and the
  transform chain `["pfl-report-envelope", "rule:<id>"]`.
- Strings interpolated into claim text pass through Gatefold's canonical
  claim-text normalization: C0/C1/DEL, zero-width and bidi formatting
  characters, line/paragraph separators, and U+FEFF become the literal text
  `\uXXXX`. This normalization is distinct from JSON serialization escaping:
  in `--format json` output the sequence appears as `\\uXXXX` inside the JSON
  string, and a consumer that parses the JSON still sees the literal `\uXXXX`
  text rather than the original character. A hostile export therefore cannot
  inject terminal escape sequences or reorder displayed text in either output
  format.
