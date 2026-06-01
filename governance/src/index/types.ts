export interface DecisionRow {
  id: string; // "ADR-0007" | decision-log ordinal id "DL-001"
  kind: "adr" | "decision-log";
  title: string;
  status?: string; // ADR frontmatter status; undefined for decision-log
  date?: string;
  tags: string[];
  supersedes: string[]; // ADR-NNNN ids
  refs: string[]; // ADR-NNNN ids mentioned in the body
  excerpt: string;
  sourcePath: string;
}

export interface PrincipleRow {
  id: string; // "INVARIANT-1"
  number: number;
  title: string;
  body: string;
  sourcePath: string;
}

export interface DecisionEntry {
  row: DecisionRow;
  supersededBy: string[];
  referencedBy: string[];
}

export interface GovernanceIndex {
  decisions: DecisionRow[];
  principles: PrincipleRow[];
  getDecision(id: string): DecisionEntry | null;
  listDecisions(): DecisionRow[];
  listPrinciples(): PrincipleRow[];
}
