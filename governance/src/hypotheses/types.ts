export type HypothesisStatus = "testing" | "verified" | "refuted" | "archived";

export type HypothesisKind = "commit_scope_hotspot_persists";

export interface HypothesisRecord {
  id: string;
  fromPattern: string;
  kind: HypothesisKind;
  scope: string;
  status: HypothesisStatus;
  testMethod: string;
  baseline: number;
  threshold: number;
  expires: string;
  body: string;
}
