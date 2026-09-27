# Agent instructions for Gatefold

## Source of truth

Read the relevant contract in `docs/` and the pfl input contract before changing behavior. List the invariants and exclusions that the change touches. The contract is authoritative; a review suggestion is a hypothesis to verify against it, not a replacement for it. Keep evidence pointers resolvable and claims within their stated observation limits.

## Before implementation

For a change that joins or compares documents, write down a compact case matrix before editing code. Include:

- element absent versus present with `resolved: null` versus present with a resolved status;
- before and after sides, additions and removals, changed and unchanged elements;
- complete versus partial input, unknown values, and fields omitted from a diff;
- matching versus contradictory export and diff records, including records missing on either side;
- reordered input arrays, duplicate or reworded findings, and deterministic output;
- raw JSON metadata versus sanitized human display, and valid evidence pointers.

Derive the expected result for each applicable case from the contract. Test representative positive, negative, and symmetric cases at the public API or CLI boundary. When a bug involves one cell of this matrix, check adjacent cells and the reverse direction before committing. Do not turn an unknown or absent layer into a positive or negative assertion.

## Before opening or updating a PR

Review the complete change against its contract and issue acceptance criteria, including interactions between modules. Run `pnpm ci:all` and the relevant real-process or packed CLI checks. Verify schema and pointer consistency for any new comparison output. Record commands and results in the PR. A green test suite does not replace the case-matrix review.

Keep a milestone's change reviewable. When several issues share one PR, inspect the combined diff and integration behavior once all issues are implemented, before requesting external review.

## Responding to review

Read **all** current unresolved threads and the latest PR diff before making changes. For each finding, reproduce or reason through a minimal input, decide whether it is valid under the contract, and check the symmetric and adjacent cases. Group related findings into one coherent change with regression coverage; then review the entire affected behavior and run the gates before pushing. Avoid a one-commit-per-comment cycle.

After a new review, distinguish newly exposed gaps from regressions and repeated or incorrect findings. If another round finds further gaps in the same invariant family, revisit the model and case matrix rather than adding another local guard. Explain contract-based disagreements in the thread; do not change correct behavior merely to silence a reviewer. Report the remaining open findings and verification results before treating the PR as ready.
