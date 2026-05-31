# Governance MCP — 명령/도구 (P1 범위)

Hermes ACP 세션이 이 MCP 서버를 로드 → 명령이 `available_commands`로 노출.

## P1 도구
- `create_task(description)` → L0 `task_created` event 기록, event id 반환.
- `status()` → 최근 N개 event 요약 + 카운트.
- `observations()` → 활성 patterns 목록 (P1: 빈 목록, P3에서 채워짐).

## P2+ 도구 (자리표시)
- `ask_user(options)` / `send_file(path)` (§6.3), `approve`/`reject`/`why`/`history`/`conflicts`.
