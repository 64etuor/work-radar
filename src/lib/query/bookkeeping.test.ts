import { describe, expect, it } from "vitest";

import type { BookkeepingTransaction } from "@/bindings";

import { replaceTransactionRow } from "./bookkeeping";

// lost-update 창(critic Major) 회귀 가드 — 단일 거래 뮤테이션의 onSuccess가 서버 fresh 행을
// 목록 캐시에 동기 반영할 때 쓰는 교체 함수. id 매칭 행만 바뀌고 나머지는 identity 보존.
function tx(id: string, merchant: string): BookkeepingTransaction {
  return { id, merchant } as unknown as BookkeepingTransaction;
}

describe("replaceTransactionRow", () => {
  it("id가 일치하는 행만 fresh 행으로 교체한다", () => {
    const a = tx("a", "김밥천국");
    const b = tx("b", "스타벅스");
    const updated = tx("a", "성수김밥");
    const next = replaceTransactionRow([a, b], updated);
    expect(next?.[0]).toBe(updated);
    expect(next?.[1]).toBe(b); // 무관 행 identity 보존
  });

  it("목록에 없는 id면 내용 무변경(파생 뷰는 invalidate가 처리)", () => {
    const a = tx("a", "김밥천국");
    const next = replaceTransactionRow([a], tx("z", "새 행"));
    expect(next).toEqual([a]);
  });

  it("캐시 미존재(undefined)면 undefined 유지", () => {
    expect(replaceTransactionRow(undefined, tx("a", "x"))).toBeUndefined();
  });
});
