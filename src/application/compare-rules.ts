import type { ComparisonClaim } from "../domain/comparison.js";
import type { ComparisonView } from "./reconcile.js";

/** One comparison claim rule, evaluated against the reconciled view. */
export interface CompareRule {
  readonly ruleId: string;
  evaluate(view: ComparisonView): readonly ComparisonClaim[];
}

/**
 * Claim rules for `gatefold compare`, in deterministic emission order
 * (docs/v0.4-scope.md). Populated by the element-claim (#35) and
 * relation/finding-claim (#36) work; empty until then.
 */
export const COMPARE_RULES: readonly CompareRule[] = [];
