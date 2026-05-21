@AGENTS.md

# Work Radar — Claude 진입점

이 파일은 **thin entry**다. 지속적 규칙은 `AGENTS.md`(working agreement)와
`PLAN.md`(Phase 계획 + INVARIANTS)에 있다. 이 파일에 규칙을 중복하지 않는다.

---

## 작업 전 읽을 것

| 문서 | 목적 |
|---|---|
| `PLAN.md` §1 | INVARIANTS 7개 — 모든 Phase에서 강제. 위반하는 구현은 done이 아님. |
| `PLAN.md` (해당 Phase) | Deliverables / Done-criteria — Phase 시작 전 반드시 확인. |
| `DESIGN.md` | 시각 디자인 정본 (Cohere 스타일, white editorial). 컴포넌트·토큰·Do/Don't 포함. |
| `docs/architecture.md` | 시스템 구조, 모듈 경계, IPC 계약. |
| `docs/reference/commands.md` | 빌드·검증 명령 인덱스 (Rust / Frontend / Tauri / Phase 검증 번들). |

명령은 여기에 중복하지 않는다. 모든 명령은 `docs/reference/commands.md`를 참조할 것.

---

## Git / PR 컨벤션

- **커밋 = Conventional Commits.** `{type}({scope}): {message}` (`feat`/`fix`/`docs`/`refactor`/`test`/`chore`/`build`/`ci`). 제목은 명령형 한 줄.
- **이슈 참조는 PR 제목/본문에만.** 커밋 메시지에는 이슈 번호를 넣지 않는다.
- **한 PR = 한 관심사.** feature와 광범위 refactor를 섞지 않는다(AGENTS.md 금지 규칙).
- **PR은 `.github/PULL_REQUEST_TEMPLATE.md`를 채운다** — INVARIANTS 체크 + 실행한 검증 명령 출력 포함.
- **`main` 직접 커밋/푸시 금지.** 브랜치에서 작업 후 PR로 머지. (현재 remote 없음 → 연결 시 적용.)
- **Phase 종료 시 INVARIANTS reviewer 패스**(self-approve 금지) 후 머지.

---

## Claude-specific 메모

- **self-approve 금지.** Phase 종료 시 INVARIANTS 위반 여부는 별도 reviewer 패스로 확인한다.
- **검증은 실제 실행 증거로.** 체크박스는 실행/관찰 결과여야 한다. prose 우회 금지.
- **결정 레일에 자동화 침투 금지.** Codex/규칙이 매트릭스 분류·승격을 자동 확정하면 안 된다.
- **가장 작은 변경.** 요청 범위를 벗어난 리팩터·정리는 하지 않는다.
- **결정/트레이드오프는 `docs/decisions.md`에** 한 줄로 남긴다.
