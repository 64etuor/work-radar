import type { HypothesisView } from "../hypotheses/tester.ts";

export interface MetaObservationInput {
  hypotheses: readonly HypothesisView[];
}

export type MetaObservationResult =
  | {
      hasProposal: false;
      reason: string;
    }
  | {
      hasProposal: true;
      markdown: string;
    };
