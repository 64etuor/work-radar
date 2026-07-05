import type { AgentRunView } from "@/bindings";

import { BatchEnrichPanel } from "./BatchEnrichPanel";
import { OkrImportPanel } from "./OkrImportPanel";
import { SelfCheckPanel } from "./SelfCheckPanel";
import { TriagePanel } from "./TriagePanel";

/**
 * Acceptance 게이트 패널 디스패처 — 잡 kind별로 알맞은 Proposal 패널을 고른다(Phase 8 self-check +
 * Phase 9 triage / Phase 15 batch enrich). accept는 모두 로컬 반영일 뿐, 외부(Notion/GitHub) 무변경
 * (INVARIANT #2). 단건 `enrich_braindump`는 제거됨 — 미분류 카드 분류는 배치 흐름만 유지.
 */
export function ProposalPanel({ run }: { run: AgentRunView }) {
  switch (run.kind) {
    case "enrich_batch":
      return <BatchEnrichPanel run={run} />;
    case "okr_import":
      return <OkrImportPanel run={run} />;
    case "triage_ci":
      return <TriagePanel run={run} />;
    default:
      return <SelfCheckPanel run={run} />;
  }
}
