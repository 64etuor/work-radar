<!--
work-radar PR 템플릿. 규칙 출처: AGENTS.md(Working Agreement) + PLAN.md §1(INVARIANTS).
명령 전체 인덱스는 docs/reference/commands.md.
해당 없는 섹션은 지우지 말고 "해당 없음"으로 표시하세요.
-->

## Why — 문제 / 임팩트

> 무엇을 해결하나? 누가/무엇이 영향받나?

-

## What Changed — 변경 내용

> 동작 변화와 주요 파일·모듈을 요약.

-

## Architecture Fit — 아키텍처 적합성

> `docs/architecture.md`, 관련 ADR, `docs/decisions.md` 결정에 부합하는 이유. 레일 경계(결정/제안/실행)를 침범하지 않음을 명시.

-

## INVARIANTS (AGENTS.md / PLAN.md §1)

> 위반하는 구현은 done이 아님. 별도 reviewer 패스로 확인(self-approve 금지).

- [ ] 1 — 결정 레일은 사람만 (자동 분류/승격 없음)
- [ ] 2 — 모든 외부 변경은 Acceptance 게이트 통과
- [ ] 3 — 신호는 dedup upsert + auto-resolve
- [ ] 4 — 매트릭스는 결정 큐(거울 아님), ambient는 임계치 escalate
- [ ] 5 — 에이전트 잡 bound(timeout/turns/cost cap/kill) + 재트리거 캡
- [ ] 6 — 코드 작업 worktree 격리, 샌드박스 read-only 기본/danger 금지
- [ ] 7 — SSOT 분리 (Notion=내용, SQLite=상태)
- [ ] 해당 없음 — 이 PR은 위 레일에 영향 없음 (사유: )

## Tests — 검증

> 실행한 항목 체크 + 아래에 실제 명령/출력. 전체 명령: `docs/reference/commands.md`.

- [ ] `cargo fmt --check`
- [ ] `cargo clippy --all-targets -- -D warnings`
- [ ] `cargo test`
- [ ] `pnpm typecheck`
- [ ] `pnpm build`
- [ ] `pnpm tauri dev` 부팅/시각 확인 (GUI 변경 시)
- [ ] 해당 없음

```text
# 실행한 명령과 출력을 그대로 붙여넣기
```

## Docs / Decisions

- [ ] 문서 변경 불필요
- [ ] `docs/` 업데이트 (architecture/design 등)
- [ ] `docs/adr/`에 구조적 결정 추가/갱신
- [ ] `docs/decisions.md`에 Phase 트레이드오프 한 줄 추가
- [ ] `DESIGN.md` 업데이트 (UI/시각 변경 시)

## Risks / Rollback / Migration

> 잠재 리스크, 롤백 방법, SQLite 마이그레이션 노트.

-

## Deferred Follow-Ups — 의도적으로 미룬 작업

> 이번 범위에서 제외한 작업(이유/이슈 링크와 함께).

-
