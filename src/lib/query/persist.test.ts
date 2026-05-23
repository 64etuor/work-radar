import { describe, expect, it } from "vitest";
import type { Query } from "@tanstack/react-query";

import {
  PERSIST_ALLOWED_KEY_PREFIXES,
  PERSIST_DENIED_KEY_PREFIXES,
  shouldPersistQuery,
} from "@/lib/query/persist";

/** 최소 Query 스텁: shouldPersistQuery는 queryKey + 성공 상태(data 존재)만 본다. */
function mkQuery(queryKey: unknown[], success = true): Query {
  return {
    queryKey,
    state: {
      status: success ? "success" : "pending",
      data: success ? {} : undefined,
      fetchStatus: "idle",
    },
  } as unknown as Query;
}

describe("shouldPersistQuery — disk-persist allowlist (P6, INVARIANT)", () => {
  it("ambient 표시 키(prRadar/calendarEvents/today)는 persist 허용", () => {
    expect(shouldPersistQuery(mkQuery(["prRadar", "proj1"]))).toBe(true);
    expect(shouldPersistQuery(mkQuery(["calendarEvents", "2026-05-23"]))).toBe(true);
    expect(shouldPersistQuery(mkQuery(["todayOverview", "2026-05-23"]))).toBe(true);
    expect(shouldPersistQuery(mkQuery(["projects"]))).toBe(true);
  });

  it("결정 큐(signals=매트릭스)는 persist 제외 — 항상 fresh(INVARIANT #1)", () => {
    expect(shouldPersistQuery(mkQuery(["signals"]))).toBe(false);
  });

  it("제안 큐(triage/enrich/PR proposal·agentRuns)는 persist 제외(Acceptance #2/실행 레일)", () => {
    expect(shouldPersistQuery(mkQuery(["triageProposal", "run1"]))).toBe(false);
    expect(shouldPersistQuery(mkQuery(["enrichProposal", "run1"]))).toBe(false);
    expect(shouldPersistQuery(mkQuery(["batchEnrichProposal", "run1"]))).toBe(false);
    expect(shouldPersistQuery(mkQuery(["prProposal", "run1"]))).toBe(false);
    expect(shouldPersistQuery(mkQuery(["agentRuns"]))).toBe(false);
    expect(shouldPersistQuery(mkQuery(["agentLog", "run1"]))).toBe(false);
  });

  it("성공하지 않은(pending) ambient 쿼리는 persist 안 함(promise 직렬화 방지)", () => {
    expect(shouldPersistQuery(mkQuery(["prRadar", "proj1"], false))).toBe(false);
  });

  it("미등록 키는 deny-by-default(allowlist 미포함)", () => {
    expect(shouldPersistQuery(mkQuery(["someUnknownKey"]))).toBe(false);
    expect(shouldPersistQuery(mkQuery([]))).toBe(false);
  });

  it("denylist 키는 allowlist와 절대 겹치지 않는다(결정 큐 누수 방지 잠금)", () => {
    for (const denied of PERSIST_DENIED_KEY_PREFIXES) {
      expect(
        PERSIST_ALLOWED_KEY_PREFIXES.includes(denied),
        `결정/제안 키 "${denied}"가 persist allowlist에 들어가면 INVARIANT 위반`,
      ).toBe(false);
    }
  });
});
