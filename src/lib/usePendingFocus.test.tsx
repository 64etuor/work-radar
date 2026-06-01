import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { usePendingFocus } from "@/lib/usePendingFocus";

// renderToStaticMarkup = 단일 정적 렌더(노드 env, RTL 미도입 — vitest.config.ts).
// usePendingFocus의 포커스 판정은 effect가 아니라 render-phase에서 일어나므로 정적 렌더로 관찰된다.
// 회귀 대상: goToSignal/goToSkill이 view+pendingId를 한 set()으로 심으면, 대상 뷰(CaptureBoard/
// SkillsView)가 그 시점에 *처음* 마운트된다. 따라서 훅은 "마운트 시 이미 세팅돼 있는" pendingId를
// 첫 비교에서 봐야 한다. prev를 pendingId로 초기화하면(예전 버그) 첫 비교가 같아져 포커스가 무음 실패한다.
function Harness({
  pendingId,
  onFocus,
}: {
  pendingId: string | null;
  onFocus: (id: string) => void;
}) {
  usePendingFocus(pendingId, () => {}, onFocus);
  return null;
}

describe("usePendingFocus", () => {
  it("마운트 시 이미 pending이 세팅돼 있으면 그 id로 onFocus를 한 번 호출한다(크로스뷰 딥링크)", () => {
    const onFocus = vi.fn();
    renderToStaticMarkup(<Harness pendingId="sig-1" onFocus={onFocus} />);
    expect(onFocus).toHaveBeenCalledTimes(1);
    expect(onFocus).toHaveBeenCalledWith("sig-1");
  });

  it("pending이 null이면 onFocus를 호출하지 않는다", () => {
    const onFocus = vi.fn();
    renderToStaticMarkup(<Harness pendingId={null} onFocus={onFocus} />);
    expect(onFocus).not.toHaveBeenCalled();
  });
});
