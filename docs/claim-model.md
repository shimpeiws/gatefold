# Claim model

A claim is one evidence-backed statement about a harness representation.

Each claim contains these fields:

| Field | Meaning |
| --- | --- |
| `claim` | The statement in natural language. |
| `evidence` | References to concrete locations in the input representation. |
| `provenance` | The source file, source version, and transformations used. |
| `confidence` | The certainty that the claim is supported by its evidence. |

## Invariants

Gatefold does not emit a claim without evidence.

Gatefold keeps provenance traceable to the source representation.

Confidence is not a quality score. A high confidence value means that the evidence supports the claim strongly. It does not mean that the harness is good.

The exact JSON schema remains provisional until the first analysis rules are defined.
