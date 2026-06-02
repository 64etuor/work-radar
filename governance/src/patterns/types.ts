/** L1 pattern kinds. Only one in this slice; the union is the extension point. */
export type PatternKind = "commit_scope_hotspot";

/** The single kind this slice detects. */
export const KIND: PatternKind = "commit_scope_hotspot";

/** A detected, not-yet-curated L1 pattern. `scope` is the normalized canonical key. */
export interface CandidatePattern {
  id: string; // pat_scope_<sha8>
  kind: PatternKind;
  scope: string; // normalized: scope.trim().toLowerCase()
  evidenceCount: number;
  confidence: number; // 0..1
  evidenceEventIds: string[]; // all contributing L0 event ids (sorted)
}
