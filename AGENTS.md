# Work Radar — Agent Working Agreement

이 파일은 이 앱을 **만드는** 에이전트(Ralph / Codex / Claude)를 위한 규칙이다.
(앱 *내부*에서 실행되는 Codex 자동화의 런타임 규칙은 `docs/architecture.md` 참조.)

## Goal

`PLAN.md`의 Phase를 순서대로, done-criteria를 검증 가능하게 충족시키며 진행한다.
가장 작고 국소적인 변경을 선호한다.

## 절대 규칙 (INVARIANTS)

`PLAN.md` §1의 7개 불변식이 최우선. 요약:

1. 결정 레일은 사람만 — 자동 분류/자동 승격 금지.
2. 모든 외부 변경은 Acceptance 게이트.
3. 신호는 dedup upsert + auto-resolve.
4. 매트릭스는 결정 큐(거울 아님), ambient는 임계치 escalate.
5. 에이전트 잡은 timeout/turns/cost cap/kill + 재트리거 캡.
6. 코드 작업은 worktree 격리, 사용자 트리 무손상.
7. SSOT 분리 (Notion=내용, SQLite=상태).

위반하는 구현은 done이 아니다.

## 기술 제약

- **Tauri 2 + Vite + React.** Next.js 금지(서버 프레임워크, webview에 부적합).
- **Notion/GitHub 호출은 Rust**(reqwest/octocrab)에. 토큰을 렌더러에 노출하지 말 것.
- **토큰은 OS keychain**(keyring). SQLite 평문/프런트 저장 금지. project별 분리.
- **IPC는 tauri-specta**로 타입 생성 — 수기 타입 중복 금지.
- **bounded retry only** — 무한 retry/poll 금지. backoff + jitter + terminal failure 노출.
- **SQLite 마이그레이션**으로만 스키마 변경. 임의 ALTER 금지.
- **시각 디자인은 `DESIGN.md`(정본)을 따른다.** Cohere 스타일(white editorial). 토큰(컬러/타이포/라운드/스페이싱)은 Tailwind v4 `@theme`, 컴포넌트는 shadcn/ui 위에. 웹/마케팅 전용 컴포넌트(announcement-bar·trust-logo-strip·blog-filter-chip·research-table·footer-newsletter)는 데스크톱 앱 셸에 쓰지 말 것. 이전 Raycast 방향은 폐기(`docs/archive/design-raycast.md`).

## 작업 전

- 해당 Phase의 Deliverables/Done-criteria를 먼저 읽는다.
- 기존 패턴/모듈을 재사용한 뒤 새 패턴을 도입한다.
- 레일 경계(결정/제안/실행)를 침범하지 않는지 먼저 확인한다.

## 검증

- 각 Phase done-criteria를 **실제 실행/관찰**로 채운다 (체크박스 = 증거).
- Rust: `cargo test` + `cargo clippy`. 프런트: 타입체크 + 린트.
- Tauri 통합은 `pnpm tauri dev`로 부팅 확인.
- 실행 못 한 검증은 못 했다고 명시한다.

## Phase 종료 시

- INVARIANTS 7개 위반 여부를 별도 reviewer 패스로 확인(self-approve 금지).
- 새 결정/트레이드오프는 `docs/decisions.md`에 한 줄.
- done-criteria 전부 green일 때만 다음 Phase.

## 금지

- 린트/테스트/타입체크를 prose로 우회.
- feature와 광범위 refactor 섞기.
- 무관 파일 정리.
- owner/context 없는 TODO.
- 자동화를 결정 레일에 침투시키기 (가장 중요한 금지).
