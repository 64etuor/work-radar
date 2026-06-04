---
name: type1-guardian
scale: immediate
writes: [] # 차단/보고만 — 직접 쓰기 권한 없음
---

# Type 1 Guardian

`decision_proposed`(Type 1, 비가역) 이벤트를 가로채 **외부검증 + 사람 게이트**를 강제한다.
정책은 순수 함수 `src/decision/guardian.ts`(`canApprove`/`canReject`)로 기계화됨:

- 외부 리뷰(`decision_review_recorded`) ≥1 이 없으면 `approve`를 **거부**한다.
- 종결 verdict(approved/rejected) 이후 재승인/재반려 거부.

이것이 INVARIANT #1("자동화 → 결정 레일 침투 금지")의 기계적 강화다. 에이전트는
결정을 **제안만** 하고, 승인/반려는 사람(`actor: user`)의 MCP 명령으로만 기록된다.
