# Governance MCP — 명령/도구 (P1 범위)

Hermes ACP 세션이 이 MCP 서버를 로드 → 명령이 `available_commands`로 노출.

## P1 도구
- `create_task(description)` → L0 `task_created` event 기록, event id 반환.
- `status()` → 최근 N개 event 요약 + 카운트.
- `observations()` → 활성 patterns 목록 (P1: 빈 목록, P3에서 채워짐).

## P2+ 도구 (자리표시)
- `ask_user(options)` / `send_file(path)` (§6.3), `approve`/`reject`/`why`/`history`/`conflicts`.

## P2a — Decision governance commands

- `propose_decision { title, body }` — Type 1 결정 제안 → `decision_proposed` 이벤트.
- `request_review { decisionId }` — External Reviewer(다른 모델) 검토 기록.
- `approve { decisionId }` — 사람 승인 게이트. **외부 리뷰 없으면 거부**.
- `reject { decisionId }` — 사람 반려 게이트.
- `conflicts {}` — 게이트 대기 결정(검토대기/승인대기) 목록.
- `why { decisionId }` / `history { decisionId }` — 결정 감사 추적(이벤트 체인).

게이트 정책 = `src/decision/guardian.ts`. 사람 게이트(approve/reject)는 `actor: user`
이벤트로만 기록 — 에이전트 자동 실행 불가(INVARIANT #1).
