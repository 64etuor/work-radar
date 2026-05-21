# Work Radar — Architecture

## 1. 왜 이 스택인가

- **Tauri 2:** 하루 종일 상주 + 전역 핫키 + 단일 경량창. Electron 대비 footprint가 작아
  Raycast형 상주 유틸에 맞다. 신규 standalone이라 마이그레이션 비용 0.
- **Rust backend:** SQLite + 비동기 폴링(Notion/GitHub) + Codex 서브프로세스 관리에 적합.
  Notion/GitHub 호출을 Rust에 두면 토큰이 렌더러에 노출되지 않는다(CORS/보안).
- **Vite + React (Next 아님):** desktop webview에 SSR/RSC/라우팅/API routes는 무의미.
  커맨드 팔레트 앱은 라우터보다 state-driven 뷰가 맞다.
- **tauri-specta:** Rust 타입을 TS로 생성 → IPC 계약 drift 제거.

## 2. 3-Rail 모델 (핵심 불변식)

```
결정 레일 (사람만)      : Eisenhower 분류 / 승격 여부      ← Codex 접근 금지
제안 레일 (Codex→사람)  : enrich / self-check draft / triage → Proposal → Acceptance
실행 레일 (사람→Codex)  : worktree 구현 → draft PR → 사람 검수 → Acceptance
```

모든 외부 변경(Notion/GitHub)은 **Acceptance**를 거친다. Codex 출력은 직접 mutate 불가.

## 3. 멀티 프로젝트 / 레포

`Project`가 최상위 그룹. 개인/업무는 `kind` + 분리된 토큰/Notion 워크스페이스로 구분.

```ts
Project {
  id; name; kind: "personal" | "work"
  notionBacklogDbId?; notionAgendaDbId?
  ticketKeyPattern?: string      // join key, e.g. "MIR-DEV-\\d+"
  credentialRef: string          // keychain 키 (project별 토큰 분리)
}
Repo {
  id; projectId
  provider: "github" | "local"
  remoteUrl?; localPath?          // Codex worktree 베이스
  defaultBranch; ticketKeyPattern?; enabled: bool
}
```

- 매트릭스/신호는 전역이되 `projectId`로 필터. PR Radar는 repo별 그룹.
- 자격증명은 project별 keychain 분리 (개인 GitHub ≠ 업무 org, Notion 워크스페이스 별개).
- Codex worktree는 각 `repo.localPath`에서 분기.

## 4. 데이터 모델

```ts
WorkSignal {
  id; projectId; title; body?
  source: "braindump" | "notion_backlog" | "notion_agenda" | "github_pr" | "calendar" | "hermes" | "system"
  type: "thought" | "task_candidate" | "decision_candidate" | "pr_attention"
      | "agent_alert" | "meeting_prep" | "stale" | "mismatch" | "cleanup"
  quadrant: "q1_do_now" | "q2_schedule" | "q3_quick_contain" | "q4_drop" | "unclassified"  // 사람 결정, 저장
  suggestedQuadrant?: string     // 파생, truth 아님, 언제든 재계산. 힌트 표시용
  suggestionReason?: string
  dedupKey?: string              // system/PR/Hermes 신호의 안정적 키 (upsert), e.g. "pr:42:ci_failed"
  status: "new" | "classified" | "promoted" | "linked" | "done" | "snoozed" | "archived"
  snoozeUntil?: string           // 복귀 시점
  links: { notionBacklogId?; notionAgendaId?; githubPrUrl?; calendarEventId?; hermesRunId? }
  snapshot?: { prState?; notionState? }   // mismatch drift 비교용 마지막 관측치
  createdAt; updatedAt
}

Promotion {                      // append-only (undo/audit)
  id; signalId; target: "notion_backlog" | "notion_agenda" | "today" | "calendar"
  status: "draft" | "confirmed" | "created" | "failed"
  draftPayload: object; createdExternalId?; createdAt
}

AgentRun {                       // Hermes + Codex 통합
  id; projectId; engine: "codex" | "hermes" | "claude"
  kind: "enrich_braindump" | "draft_pr_selfcheck" | "triage_ci" | "draft_notion_update" | "implement_backlog" | "digest"
  rail: "suggestion" | "execution"
  trigger: { signalId?; promotionId?; prUrl? }
  repoId?; workdir?              // 코드 잡 worktree
  sandbox: "read_only" | "workspace_write"     // danger_full 금지
  status: "proposed" | "awaiting_approval" | "running" | "succeeded" | "failed" | "cancelled"
  bounds: { timeoutSec; maxTurns; costCapUsd } // 강제
  retryKey?: string; retryCount?               // 재트리거 체인 캡
  proposal?: object             // suggestion 산출물
  result?: { diffPath?; prUrl?; externalId? }
  cost?: { tokens; usd }
  logPath; createdAt; startedAt?; finishedAt?
}

Acceptance {                     // 외부 변경의 유일한 관문, append-only
  id; agentRunId; acceptedFields: object; target; createdAt
}

Worktree {                       // repo별 git worktree (Phase 5)
  id; repoId
  path: string                   // worktree 파일시스템 경로
  branch: string; head: string   // 현재 브랜치 / HEAD sha
  baseBranch?: string            // diff 비교 기준 (예: origin/dev)
  isPrimary: bool                // 메인 워킹카피 여부
  status: "clean" | "dirty" | "ahead" | "behind" | "diverged"
  ahead: number; behind: number; lastFetchedAt?: string
}

DiffFileSummary { path; status: "M" | "A" | "D" | "R"; adds: number; dels: number }
```

설계 노트:
- `quadrant`(사람 결정) vs `suggestedQuadrant`(파생) 분리 — 점수 이중저장 안 함.
- system/PR/Hermes 신호는 `dedupKey`로 **upsert**. 원인 해소 시 `status` auto-resolve.
- mismatch는 `snapshot`으로 drift 비교. join key는 `ticketKeyPattern`.

## 5. AgentRunner (Rust)

```rust
#[async_trait]
pub trait AgentRunner: Send + Sync {
    fn engine(&self) -> Engine;
    async fn run(&self, spec: AgentJobSpec, bounds: Bounds, cancel: CancellationToken)
        -> Result<AgentOutcome, AgentError>;
}

pub struct Bounds { pub timeout: Duration, pub max_turns: u32, pub cost_cap_usd: f64 }

pub struct CodexRunner { codex_bin: PathBuf, worktree_root: PathBuf }

#[async_trait]
impl AgentRunner for CodexRunner {
    fn engine(&self) -> Engine { Engine::Codex }
    async fn run(&self, spec, bounds, cancel) -> Result<AgentOutcome, AgentError> {
        let wt = self.prepare_worktree(&spec.repo)?;            // 코드 잡 격리
        let mut child = Command::new(&self.codex_bin)
            .args(["exec", "--json", "--sandbox", spec.sandbox.as_flag(), "--cd", wt.path()])
            .arg(&spec.prompt)
            .stdout(Stdio::piped()).stderr(Stdio::piped())
            .kill_on_drop(true).spawn()?;
        let outcome = tokio::select! {
            r = self.consume(&mut child, &bounds) => r?,         // JSONL 파싱 + turns/cost 강제
            _ = sleep(bounds.timeout)            => { child.kill().await?; return Err(AgentError::Timeout) }
            _ = cancel.cancelled()               => { child.kill().await?; return Err(AgentError::Cancelled) }
        };
        self.finalize(wt, &spec.rail)?;   // 제안=worktree 폐기, 실행=diff/PR 보존
        Ok(outcome)                       // Proposal | result. 외부 직접 mutate 안 함
    }
}
```

> Codex CLI 플래그명(`exec`, `--json`, `--sandbox`, `--cd`, `-a`)은 버전마다 다를 수 있으니
> Phase 6에서 실제 설치본으로 확인할 것. graceful degrade(미설치 시 자동화 비활성) 필수.

## 6. SSOT & Sync 규칙

- Notion = 백로그/안건 *내용*의 SSOT. 로컬 미러는 read cache + write-through.
- SQLite = 매트릭스 상태·신호·승격 이력·에이전트 잡의 SSOT.
- Notion API rate limit 3 req/s + pagination 준수. bounded retry + backoff + jitter.
- 오프라인 우선: 네트워크 불가 시 UI 무차단, 승격은 큐잉 후 reconcile.

## 7. dedup / auto-resolve

- 폴링이 만드는 신호는 `dedupKey`로 upsert (append 아님). 매 cycle 중복 카드 방지.
- 원인 해소 감지(예: CI 통과, Notion 상태 일치) 시 신호 auto-resolve.
- 재트리거 체인(CI triage 등)은 `retryKey` + `retryCount` 캡. 초과 시 Q1 escalate.

## 8. Worktree & Branch Diff (Phase 5)

- **git 접근은 Rust에.** git2(libgit2) 우선, 복잡 케이스는 `git` CLI 셸아웃.
- **나열:** `git worktree list` → `Worktree` upsert. 브랜치 = `refs/heads/*` + 원격 추적.
- **diff 모드:**
  - `working` = 미커밋 워킹트리 diff
  - `staged` = index diff
  - `vs_base` = `git diff <baseBranch>...<head>` (3-dot, merge-base 기준)
  - `branch↔branch` = 임의 두 ref 비교
- **read-only.** Diff Viewer는 절대 워킹트리/브랜치를 변경하지 않는다(체크아웃·리셋 없음).
- **성능:** 파일 목록(통계)을 먼저, 파일별 hunk는 지연 로드. 대용량 diff는 가상 스크롤.
- **연결:** PR Radar의 PR 브랜치, 실행 레일(Phase 10)의 Codex worktree를 같은 뷰로 검수.
- **멀티 repo:** 개인/업무 모든 enabled repo의 worktree를 `projectId`로 필터해 동시 표시.
