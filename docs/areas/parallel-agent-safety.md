
# Parallel Agent Safety

이 문서는 **이 앱을 만드는 에이전트**(orchestrator + implementer)들이 동시 실행될 때의
가드다. 앱이 실행하는 Codex 잡의 격리 규칙(INVARIANT #6)과는 다른 층이다.

## 규칙 1 — `isolation: "worktree"` 사용 금지

이 레포에서 multiple background `Agent` 호출을 `isolation: "worktree"`로 병렬 디스패치하면
**cross-contamination이 재현 확인**된 사고 패턴이다(2회 발생, 2026-05-22 Phase B 재발).

관측된 leak:

- 다른 에이전트의 uncommitted 변경이 메인 checkout의 `dev` 워킹트리에 새어 나옴
- 한 에이전트가 자기 브랜치 대신 `dev`에 직접 커밋
- 한 에이전트(B4)가 src 트리 전체를 558파일/104k 삭제로 재작성
- worktree가 stale 커밋에서 분기 → 매번 `git reset --hard dev` 필요

**원인:** 에이전트들이 메인 repo 경로에서 git ops 실행 → worktree 격리가 무력화.

**대안 = 순차 실행:** 한 implementer가 *uncommitted*로 끝낸 뒤, orchestrator(나)가
verify(`docs/reference/commands.md` 게이트) + 별도 critic 패스(self-approve 금지) +
commit/push를 한다. Phase 12a/12b/13/15-redo/16/18/20에서 이 패턴이 깨끗히 동작했다.

**예외 = 편집 전용 병렬:** 같은 워크트리, no git/cargo, 도메인 분할(예: 17 commands를
4그룹에 나눠 동시 편집 → orchestrator가 직렬 통합). 4-그룹 stage 2(error-handling
migration) 선례. Worktree isolation은 여전히 미사용.

**Worktree 브랜치 salvage:** 정말 격리 잡 결과를 살릴 때는 파일 복사 말고 **브랜치를
merge**하고 main에서 전체 재검증.

## 규칙 2 — Executor 늦은 쓰기 가드

위임된 에이전트의 파일 쓰기가 **완료 보고 이후 도착**할 수 있다(비동기 실행/늦은 flush).
"agent return" ≠ "tree stabilized".

**관측:** retry-dedup executor가 retry.rs 49줄로 보고 → 커밋 후 다음 브랜치에서 115줄로
재출현(generic with_retry 단위테스트 +66줄). 정당한 변경이지만 별 관심사 커밋으로 분리해야 했다.

**가드:**

1. 위임 작업 커밋 직전 `git status --short` + `git diff --stat`.
2. **다음 브랜치 만들기 직전에도** 다시 확인.
3. 예상 밖 파일이 보이면 내용 읽고: 좋은 변경 → 올바른 관심사 커밋으로 분리. 아니면 restore.
4. grep 검증은 `rtk proxy` 경유여도 부정확할 때가 있다 → **Read 도구로 교차확인**.

## 규칙 3 — 자율 루프 ⊥ 인터랙티브 세션 (같은 트리)

[autonomous-phase-loop](#autonomous-phase-loop)는 **같은 공유 워킹트리**에서 인터랙티브
Claude 세션과 함께 돌면 서로의 git 상태를 망친다. 두 writer가 한 트리에 있으면 stash/
checkout/reset이 상대의 uncommitted WIP를 clobber한다.

**관측 signature:** `git reflog`에 본인이 발행하지 않은 checkout/commit/merge가 보인다 →
워킹트리가 명령 사이에 변한다.

**가드:** 위 signature가 감지되면 **즉시 모든 mutation 정지**, read-only 진단으로 전환
(`git log/status/grep/reflog`, `git branch --contains <sha>`). 자기 작업이 이미 landed
됐는지 확인하고 backoff. 루프가 소유한 트리에서 `stash`/`checkout`/`commit`/`cargo clean` 금지.

## <a id="autonomous-phase-loop"></a>규칙 4 — Autonomous Phase Loop 패턴

사용자가 "일단 진행해 결과 보고 판단한다" / 여러 PR 페이즈를 위임할 때:

- 페이즈 전체에 걸쳐 **PR마다 다음 루프**를 사람 승인 없이 자율 실행:
  1. brainstorm(필요 시 AskUserQuestion 일괄)
  2. 가장 작은 변경 구현
  3. 헤드리스 검증(`cargo test`/`clippy -D warnings`/`fmt --check` + `pnpm typecheck/build`)
  4. **independent INVARIANTS reviewer 패스 (`oh-my-claudecode:critic`, self-approve 금지)** —
     MAJOR/BLOCKER 수정 후 같은 critic에 SendMessage로 재확인
  5. commit + push `dev` (push 규칙은 `git-conventions.md`)
  6. 한 줄 `docs/decisions.md` 항목
- PR 경계마다 짧은 상태 보고. 사용자가 redirect 가능.

## 규칙 5 — `/omc-teams` (CLI runtime) cmux 안 사용 금지

cmux 안에서 `omc team N:claude` CLI runtime은 시작 시 stall(pane timeout 30s). 프롬프트가
claude TUI에 타이핑되지만 Enter가 발사되지 않아 worker가 inbox.md를 안 받는다. 태스크가
`pending` 영구 정지, `omc team shutdown`이 게이트 차단(`--force` + `tmux kill-session` 필요).

**대안:** native parallel `Agent`(`oh-my-claudecode:executor` 등) — 한 lane=한 에이전트,
명시 파일 소유. 결정론적이고 startup race 없음. 단 위 규칙 1 가드 적용.

CLI worker가 정말 필요하면: spec을 `.omc/plans/`에 self-contained로 적고, launch 후
`tmux capture-pane`으로 실제 submit 됐는지 확인하고 status 신뢰. fallback으로 `send-keys Enter`
준비.

## 정본 / 참조

- `~/.claude/projects/-Users-davidpark-private-project-work-radar/memory/`
  - `work-radar-parallel-worktree-contaminates.md`
  - `work-radar-executor-late-writes.md`
  - `work-radar-loop-shares-working-tree.md`
  - `work-radar-autonomous-phase-loop.md`
  - `omc-teams-cmux-startup-stall.md`
- `docs/decisions.md` "운영 결정: 병렬 worktree 격리 실패"
