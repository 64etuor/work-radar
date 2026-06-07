# 거버넌스 문서 컨벤션 (정본)

이 문서는 **Boule 거버넌스 하네스의 문서를 어디에 두고, 어떻게 명명하고, 무엇이
정본인지**를 한 장으로 못 박는다. 결정 배경은 `docs/decisions.md`의 2026-06-07
breadcrumb 참조. 이 컨벤션은 codex 자문(by-path 제약 소스 검증) 후 채택됐다.

## 1. Home — 거버넌스 문서는 `governance/docs/` 아래에 둔다

| 종류 | 위치 |
| --- | --- |
| 설계 spec | `governance/docs/design/` |
| 구현 plan | `governance/docs/plans/` |
| 런북 | `governance/docs/runbooks/` |
| 오케스트레이션 로그 | `governance/docs/orchestration/` |
| 카탈로그/프런트도어 | `governance/docs/INDEX.md` |
| 이 컨벤션 | `governance/docs/conventions.md` |

- **`specs/` 별칭을 쓰지 않는다.** 거버넌스 spec 버킷은 `design/` 하나다(이미 우세 컨벤션).
- **`docs/superpowers/{specs,plans}/`는 generator 착지장일 뿐, 거버넌스 정본이 아니다.**
  `superpowers:brainstorming` / `writing-plans` 스킬이 기본으로 거기에 쓴다 →
  거버넌스 산출물이면 **생성 직후 `governance/docs/{design,plans}/`로 `git mv`**
  (히스토리 보존). 옮기기 전의 `docs/superpowers/` 거버넌스 문서는 **무효(미정본)**로 본다.

## 2. by-path 예외 — 옮기면 안 되는 L3/L4 정본 (코드가 경로로 읽음)

거버넌스 하네스 **코드가 런타임에 경로를 하드코딩**해 읽는 파일은 repo-root `docs/`에
**잔류한다**. 이동 = 파서 회귀(코드 변경 없이는 금지). 정본 소스:
`governance/src/index/build.ts`(`docs/adr`, `docs/decisions.md`,
`docs/areas/decision-rails.md`) + `governance/src/mcp/server.ts`.

| 경로 | 읽는 곳 | 비고 |
| --- | --- | --- |
| `docs/adr/` | `build.ts` `adrDir` | 앱+거버넌스 ADR 공용 네임스페이스. 거버넌스 ADR(0007/0008/0009)도 여기. |
| `docs/decisions.md` | `build.ts` `parseDecisionLog` | repo 전역 Phase 로그(앱+거버넌스 교차). **통합 유지** — 분리하려면 파서 코드 변경 필요. |
| `docs/areas/decision-rails.md` | `build.ts` `parseRails` | 7 INVARIANTS. |

> 거버넌스 ADR을 `governance/docs/`로 옮기거나 거버넌스 전용 decisions 로그를
> 분리하려면 **반드시 `build.ts` 파서를 함께 바꾸고 vitest로 검증**해야 한다 —
> docs-only 패스 비대상. 섞지 말 것(한 PR=한 관심사).

## 3. Canonical — "현재 Boule 전체"의 단일 진입점

**프런트도어 = `governance/docs/INDEX.md`** (카탈로그/라우터). INDEX가 아래로 라우팅:

| 알고 싶은 것 | 정본 |
| --- | --- |
| **아키텍처 / as-built 전모** | `design/2026-06-02-boule-v3-orchestrator-control-plane-design.md` §7 Phase Ledger |
| **라이브-자율 실행 큐(현재 진행)** | `plans/2026-06-07-boule-v3-live-autonomy-master-plan.md` |
| per-feature 설계 입력 | `design/`의 개별 spec (프런트도어 아님 — 하위 입력) |
| L3/L4 결정 소스 | `docs/adr/0007–0009`, `docs/decisions.md` (이동 금지 — §2) |

- **마스터 플랜은 프런트도어가 아니다** — 움직이는 실행 큐다.
- **v3 control-plane 설계도 프런트도어가 아니다** — 아키텍처 정본이지 배치/라우팅 소유가 아니다.
- per-phase 설계 9개는 2026-06-04에 §7 Phase Ledger로 **흡수·삭제**됐다(git 히스토리 보존).
  plan들의 `Spec:`/`Design:` 헤더는 그 삭제된 파일이 아니라 **§7로 가리킨다**.

## 4. 명명 규칙 (종류별)

| 종류 | 패턴 | 예 |
| --- | --- | --- |
| ADR | `{NNNN}-{kebab}.md` | `docs/adr/0008-orchestrator-dispatch-decision-rail.md` |
| 설계 spec | `YYYY-MM-DD-{topic}-design.md` | `design/2026-06-07-boule-tick-bounded-driver-design.md` |
| 구현 plan | `YYYY-MM-DD-{topic}.md` | `plans/2026-06-07-boule-v3-live-autonomy-master-plan.md` |
| 런북 | `YYYY-MM-DD-{topic}.md` (point-in-time) | `runbooks/2026-06-07-live-loop-smoke.md` |
| append-only 로그 | 안정적 서술 이름(날짜 프리픽스 없음) | `orchestration/hermes-boule-decision-log.md` |

- ADR 네임스페이스 규칙은 `docs/adr/README.md`가 정본 — 중복하지 않는다.
- 날짜 프리픽스는 **생성일**(작업 시작일), 사후 갱신 시에도 유지.

## 5. 한 줄 요약 (AI가 헷갈릴 때)

> 거버넌스 문서? → `governance/docs/`. 진입점? → `governance/docs/INDEX.md`.
> v3 전모? → control-plane 설계 §7. 지금 뭐 하는 중? → live-autonomy master plan.
> ADR/decisions/decision-rails는 `docs/`에 **그대로** 둔다(코드가 경로로 읽음).
