---
name: codex-worktree-runner
description: Use when building work-radar's agent execution (Codex jobs) — run `codex exec --json` in an isolated git worktree with enforced bounds (timeout/max-turns/cost cap/kill), retrigger caps, read-only-default sandbox (never danger-full), graceful degrade, and the Acceptance gate before any external mutation. Phase 7–10.
---

# Codex 잡 실행기 (worktree + bounds)

자동화는 **제안/실행 레일에만** 붙고, **결정 레일엔 절대 들어가지 않는다**(INVARIANT #1).

## 3-Rail (src-tauri/src/lib.rs doc 참조)
- **결정** (사람만): Eisenhower 분류 / 승격 여부 — 자동화 접근 금지.
- **제안** (Codex→사람): enrich / draft → `Proposal` → Acceptance.
- **실행** (사람→Codex): worktree 구현 → draft PR → 사람 검수 → Acceptance.

## Runner
- `AgentRunner` trait + `CodexRunner` = `codex exec --json` via `tokio::process`. JSON 스트림 파싱.
- 동시성 1–2. codex 미설치/미인증 → **graceful degrade**(자동화 UI 비활성, 앱 코어 100% 동작).

## bounds 강제 (agent_runs 컬럼, INVARIANT #5)
- `timeout_sec` · `max_turns` · `cost_cap_usd` · kill switch. 초과 시 **kill + status=failed**.
- **재트리거 캡**: `retry_key` + `retry_count`. CI triage 등 체인은 캡에서 멈추고 초과 시 **Q1으로 escalate**(사람).

## 샌드박스 (agent_runs.sandbox CHECK = read_only|workspace_write)
- 기본 `read_only`. 쓰기는 명시 승인 시에만 `workspace_write`. **`danger_full` 금지**(`.codex/config.toml`과 일치).

## worktree 격리 (INVARIANT #6)
- 코드 잡은 git **worktree**(`agent_runs.workdir`)에서. **사용자 워킹트리 절대 무손상**. 잡 종료 후 정리.
- 생성 diff는 사람이 Diff Viewer로 검수 후에만 push. 검수 없이 push 금지.

## Acceptance 게이트 (INVARIANT #2)
- Codex 출력은 Notion/GitHub를 **직접 mutate 못 함**. 모든 외부 변경은 `acceptances`(append-only)에 사람 accept 기록 후에만. Proposal은 draft일 뿐.

## 검증
- echo 잡이 bound 내 실행, Jobs 뷰 표시, kill 동작, 로그 캡처(`agent_runs.log_path`).
- timeout/cost cap 초과 → kill + failed. accept 전 외부 무변경.
- 관련: [[octocrab-keyring]](외부 write), [[sqlx-sqlite]](agent_runs/acceptances).
