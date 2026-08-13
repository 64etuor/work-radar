# Boule — STATUS (유일한 moving ledger)

**"지금 무엇이 어디까지 진행됐나"는 이 파일만 답한다.** `INDEX.md`는 라우팅 전용(상태 셀 금지),
plan 문서는 착수 시점 스냅샷(`plans/README.md`)이다. 이 분리(front-door vs moving ledger)는
2026-06-12 정합 패스에서 도입 — INDEX 안의 상태 셀·실행 큐가 주 단위로 썩던 문제의 구조적 해법.

갱신 규칙: 트랙이 랜딩/중단될 때 이 파일을 같은 커밋에서 갱신하고 `Updated:`를 찍는다.

**Updated: 2026-08-13**

## 현재 실행 큐

정본 plan: `plans/2026-06-12-boule-omc-alignment-operability-master-plan.md`
(critic ACCEPT 2026-06-12 — Boule×OMC 비교 진단 + 문서 정합 + 운용성 페이즈)

| 순서 | 슬라이스 | 상태 |
| --- | --- | --- |
| P0 | 문서 정합 (INDEX/STATUS/area-map/conventions/배너/런북/GDL 동결) | ✅ 2026-06-12 (이 커밋) |
| P5a | harness 영구 문서 `governance/docs/harness/`로 이동 (HARNESS·agents·interfaces·orchestrator) | ✅ 2026-06-12 |
| P1 | Disarmed→Armed 운용 표면 (래치 해제 UI·Go-Live remedy·merge-대기 칩·cmux 해석기·bin alias) | ✅ 2026-06-12 (라이브 GUI 스모크=사용자) |
| P2 | 완료 권위 실전화 (checkless 게이트·evaluator rung 배선·check 계약 주입) | ✅ 2026-06-12 (evaluator 라이브 1회 실증=운영 잔존) |
| P3 | tick mutex·launchd schedule CLI·브릿지 경로 수정·escalation TTL/outbound | ✅ 2026-06-12 (launchd 실설치=사용자 발동) |
| P4 | unmerged 산출물 표면화·usage 파싱·실패 피드백 루프 | ✅ 2026-06-12 (stream-json 라이브 1-shot 스모크 잔존) |
| P5b | housekeep launchd 스케줄·구 workspace 아카이브 결정(=동결 유지) | ✅ 2026-06-12 |

**큐 소진(2026-06-12)** — P0–P5 전부 랜딩. 다음 트랙은 새 plan을 이 표에 등록하고 시작한다.

2026-08-13 보안 경화: 자율 executor 기본은 OS `workspace-write` sandbox를 강제하는 Codex이며,
Claude executor는 동등한 sandbox가 생길 때까지 fail-closed 비활성이다. deterministic 완료 판정은
worktree 안에서 이번 step이 생성/변경한 regular-file 상대 경로 artifact만 인정한다. 계획 입력의
임의 command 실행과 절대/탈출/symlink/기존 artifact 자기인증은 제거됐다.

## Landed tracks (최신 위, 날짜=랜딩일)

증거 규약: SHA는 휘발 인용을 피하고 **plan/spec 문서 + `docs/decisions.md`(DL) breadcrumb + git log**로
교차 확인한다(gitignored 경로 인용 금지).

| 날짜 | 트랙 | 정본 문서 |
| --- | --- | --- |
| 06-12 | **정합·운용성 P0–P5 전 페이즈 랜딩** (P2 vitest 780 → P3 828 → P5b 871 / 앱 cargo 691·FE 542; 각 슬라이스 별도 critic ACCEPT) | `plans/2026-06-12-boule-omc-alignment-operability-master-plan.md` + DL breadcrumb 2026-06-12 |
| 06-12 | Boule×OMC 정합·운용성 마스터플랜 (critic ACCEPT) | `plans/2026-06-12-boule-omc-alignment-operability-master-plan.md` |
| 06-11 | 관찰 체인 보강(thin 4곳) + `boule housekeep` CLI | DL breadcrumb 2026-06-11 |
| 06-10 | step worktree chaining (plan 브랜치 위 step 누적) + 하네스 결함 수정(cmux truncation/REPL wedge 등) | `plans/2026-06-10-step-worktree-chaining.md` |
| 06-10 | ticker scheduler 신뢰성 (heartbeat + self-heal + bounded escalation, migration 0046) | `docs/superpowers/specs/2026-06-10-ticker-scheduler-reliability-design.md` (앱층) |
| 06-09 | Control Room live schematic (INFRA bar + READINESS 5-gate + work lanes, 4s poll) | `docs/superpowers/specs/2026-06-09-control-room-live-schematic-design.md` (앱층) |
| 06-09 | Boule Ops T3(ticker UI)+T4b(per-project snapshot — state/*.json projection 은퇴→`boule snapshot` fold) | `docs/plans/2026-06-08-boule-operations-layer.md` (앱층; T5 OS-scheduler는 위 큐 P3로 승계) |
| 06-08 | Autonomous-Coding Policy Engine M1–M6b (난이도 라우팅·예산·완료권위·정족수 + Settings UI) | `plans/2026-06-08-autonomous-coding-master-plan.md` + ADR-0010 |
| 06-08 | configurable backends + token-exhaustion fallback (Slice 1 codex `CODEX_HOME` 격리 포함) | `plans/2026-06-07-configurable-backends-wiring.md` |
| 06-07 | v3 live autonomy L0–L6 (라이브 풀사이클 실증·graduated `autonomyLevel`·`boule tick`·per-repo `.boule`) | `plans/2026-06-07-boule-v3-live-autonomy-master-plan.md` + ADR-0009 |
| 06-07 | 문서 정합성 1차 (governance/docs home·INDEX·conventions·additive sources) | `conventions.md` + GDL-001 |
| 06-04~06 | v3 Phase A–I + v1 P4/P5/P6 Slice 1 (전부 critic ACCEPT) | v3 설계 §7 Phase Ledger |
| 05-31~06-02 | v1 기초(P1·P2a·P2b·quorum·escalation roundtrip·ingress·harvest·pattern detector) | `INDEX.md` 슬라이스 카탈로그 |

## External residuals (사용자/라이브 표면 필요 — 에이전트 단독 불가)

- **Go-Live 라이브 스모크**: 래치된 프로젝트 → 사유 확인 → 해제 → 체크리스트 green → Tick now 성공 1회 관찰(P1 done-criteria; 런북 §0.7 의식 참조).
- **launchd 실설치**: `boule schedule install --repo <repo>` (+ 필요 시 `--kind housekeep`) — 사용자 발동(ADR-0006).
- **evaluator rung 라이브 1회 실증**: backends.evaluator 구성 후 task_completed 인증 + 음성 경로 관찰(P2).
- **실 폰 Telegram escalation 왕복 스모크**: inbound 경로는 `.boule/workspace`로 수정됨(2026-06-12) — sync-once → 탭 → resume 관찰(P3).
- `feat/governance-boule-p1` PARKED 브랜치 처분 결정 (Boule v1 메인트리 ~85커밋, 미푸시).
