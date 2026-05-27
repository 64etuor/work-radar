import type { AgentRunView } from "@/bindings";
import { BatchEnrichPanel } from "./BatchEnrichPanel";
import { EnrichPanel } from "./EnrichPanel";
import { SelfCheckPanel } from "./SelfCheckPanel";
import { TriagePanel } from "./TriagePanel";

/**
 * Acceptance 게이트 패널 디스패처 — 잡 kind별로 알맞은 Proposal 패널을 고른다(Phase 8 self-check +
 * Phase 9 enrich/triage). accept는 모두 로컬 반영일 뿐, 외부(Notion/GitHub) 무변경(INVARIANT #2).
 */
export function ProposalPanel({ run }: { run: AgentRunView }) {
  switch (run.kind) {
    case "enrich_braindump":
      return <EnrichPanel run={run} />;
    case "enrich_batch":
      return <BatchEnrichPanel run={run} />;
    case "triage_ci":
      return <TriagePanel run={run} />;
    default:
      return <SelfCheckPanel run={run} />;
  }
}
