# Boule × OMC 정합·운용성 마스터 플랜 (문서 정합 + "켜면 정말 도는" 루프)

- **Date**: 2026-06-12
- **Author**: claude (Fable) — 병렬 리서치 에이전트 3개(boule as-built 진단 / OMC 4.14.6 메커니즘 / 문서·구조 감사) + 본 세션 직접 스팟체크(`tick.ts` 호출부, SUPERSEDED 배너, `.gitignore`, adapter wrapper tail, `EvaluateFn` grep). 모든 file:line 주장은 2026-06-12 워킹트리 기준.
- **Status**: SPEC / 마스터플랜 — critic ACCEPT 후 페이즈별 별도 슬라이스로 집행(각 슬라이스 TDD + 별도 critic 패스).
- **선행 정본**:
  - `governance/docs/design/2026-06-02-boule-v3-orchestrator-control-plane-design.md` — 아키텍처 정본.
  - `governance/docs/plans/2026-06-08-autonomous-coding-master-plan.md` — 정책 엔진(난이도·예산·완료권위·정족수, ADR-0010). 이 플랜은 그 **미배선 잔여를 운용성 관점에서 마감**한다.
  - `docs/plans/2026-06-08-boule-operations-layer.md` — 앱 ticker/T3/T4b. 이 플랜의 P1/P3가 그 T5(OS 스케줄러)와 운용 UX를 잇는다.
- **이 플랜이 닫는 갭(사용자 요구 2026-06-12)**: ① boule 작동 원리 vs OMC 플러그인 비교 ② 문서·폴더 구조 정합 ③ "지금은 제대로 작동하지 않는다"의 근본 원인 제거 — 켜면 정말 도는 루프.

---

## 0. 한 줄 요약

**기계는 진짜다 — 2026-06-10 풀사이클 라이브 실증(`.boule/workspace/events/2026-06-10/` spec→plan→6 task/session/complete), vitest 732/732. 그런데 오늘 "안 도는" 이유는 단일 결함이 아니라 운용성 부재의 합성이다:** 시스템이 기본 disarmed(3중 OFF 스위치 + attention 래치)이고, check 없는 step은 구조적으로 `needs_human`에 박히며(LLM evaluator rung은 tick 경로에서 도달 불가), 루프 수명이 앱 수명에 종속되고(OS 스케줄러 부재), 에스컬레이션이 사람에게 도달하지 않으며(outbound 미배선·inbound는 구 워크스페이스), 완주한 작업조차 unmerged 브랜치에 좌초한다. 각 갭은 작지만 **합성이 "자율"을 0으로 만든다.**

OMC가 "되는" 이유는 더 좋은 코드가 아니라 **운용 원칙**이다: 파일이 진실을 들고(prompts carry instructions, files carry truth), 하네스 이벤트가 루프를 틱하고, 모든 것이 bounded이며, 인프라는 fail-open·게이트는 명시적 teardown으로 닫힌다. Boule은 이 원칙 대부분을 **이미 설계로 갖고 있다**(cron-is-clock, 이벤트 소싱, 구조적 anti-self-approve) — 빠진 것은 마지막 배선과 운용 표면이다.

## 1. 작동 원리 비교 — Boule vs OMC (oh-my-claudecode 4.14.6)

리서치 대상: `/Users/davidpark/.claude/plugins/cache/omc/oh-my-claudecode/4.14.6/` (hooks/scripts/skills/agents 전수 분석).

| 차원 | OMC | Boule | 판정 |
| --- | --- | --- | --- |
| 루프 드라이버 | Claude Code hook 이벤트가 틱: Stop hook(`scripts/persistent-mode.mjs`)이 상태파일 읽고 `{decision:"block", reason:<재주입 프롬프트>}` — 플랫폼이 틱을 **항상 쏴준다** | `boule tick` = bounded 외부 박동(cron-is-clock, `src/orchestrator/tick.ts:77`). 설계 동형 — 단 "cron"이 안 깔려 있음. 유일한 자동 드라이버 = 앱 내 30s tokio ticker(`src-tauri/src/governance/ticker_scheduler.rs`), 앱과 함께 죽음 | 설계 대등, **배선 격차** |
| 상태 SSOT | `.omc/state/sessions/<id>/<mode>-state.json` — 원자적 쓰기, TTL(2h staleness, tombstone 24h), 세션 소유권 검사 | `.boule/workspace` 이벤트 소싱(append-only) — 더 강한 모델 | Boule 우위 |
| 완료 판정 | Stop hook은 절대 "done"을 판정 안 함 — 명시적 `/cancel` ritual(상태파일 삭제)이 done. ralph는 prd.json 기계판독 criteria + 별도 reviewer | deterministic `step.check`(command/artifact)가 유일한 자동 권위, 실패=`needs_human` fail-closed. evaluator-LLM rung은 **도달 불가**(아래 §2-R2) | Boule이 더 엄격하나 **절반 배선** |
| anti-self-approve | 프롬프트/에이전트 수준(reviewer는 `disallowedTools: Write, Edit`) | **구조 수준**: executor role MCP에 verdict 툴 자체가 부재(`conductor/handlers.ts` envelope) + Type-1 Guardian | Boule 우위 |
| bounded | iteration budgets(ralph 100, autopilot 20…), 소진 시 정의된 행동(allow stop/auto-disable) | max-steps, bounded retry, TTL escalation — 동등. 단 **budget 레일은 inert**(§2-R6) | 대등(예산만 미완) |
| 실패 처리 | 전 계층 fail-open(`run.cjs` — hook이 죽어도 세션은 산다) + 에러 시그니처 retry-count가 다음 프롬프트에 주입 | 게이트 fail-closed(올바름 — 외부 부수효과 있음) + 인프라 bounded escalation. 단 실패 텔레메트리(stderr digest)가 **다음 attempt 프롬프트로 피드백되지 않음** | 철학 차이는 정당, 피드백 루프 이식 가치 |
| HITL | 사람이 대화 중 상주 = 운영자 항상 in-loop | **비동기 HITL**인데 도달 채널 미완(§2-R4) — 가장 큰 격차 | OMC는 문제 자체가 없음(상주), Boule은 채널 필요 |
| 활성화 UX | 키워드 1개("ralph") → 상태파일 생성 → 즉시 가동 | 3 토글(tick_enabled/live_enabled/latch) + cmux env + MCP 세션 + check 있는 plan — **의식(ritual) 8단계** | OMC 압도적 우위 — P1의 표적 |
| 문서 구조 | front-door(GETTING-STARTED/ARCHITECTURE) vs moving ledger(CHANGELOG) 분리, dir-local AGENTS.md + 생성/갱신 스탬프, `docs/shared/` cite-don't-copy | INDEX 한 장이 라우팅+상태+큐를 겸직 → 주 단위로 rot(§3) | OMC 패턴 채택 |

### 1.1 이식할 운용 원칙 → Boule 적용처

| # | OMC 원칙 (출처) | Boule 적용 |
| --- | --- | --- |
| 1 | 루프를 하네스 이벤트로 외부화 (`persistent-mode.mjs`) | 이미 동형(tick). **cadence만 완성** → P3(a) |
| 2 | 파일 상태 SSOT + 원자적 쓰기 | 이미 우위(이벤트 소싱). tick 동시실행 mutex만 추가 → P3(a) |
| 3 | 모든 상태 읽기에 TTL+소유권 가드 | `pending_escalations`의 "만료=숨김while halt 지속" 결함 수정 → P3(d) |
| 4 | bounded + 소진 시 정의된 행동 | budget 레일 실화(usage 파싱+캡) → P4(b) |
| 5 | 인프라 fail-open·운용 가시성 | readiness 항목별 remedy 표면화 → P1(b) |
| 6 | 완료 = 명시적 ritual, 모델 주장 아님 | check 계약 authoring 게이트 + evaluator rung 배선 → P2 |
| 7 | 구조적 anti-self-approve | 이미 우위 — 유지(회귀 금지) |
| 8 | 실패 텔레메트리가 다음 시도에 주입 | redispatch 시 직전 attempt stderr digest를 step-prompt에 포함 → P4(c) |
| 9 | 플랫폼 생존 메커니즘과 싸우지 않기 | launchd 네이티브 채택(데몬 자작 금지) → P3(a) |
| 10 | 활성화는 한 동작, 종료도 한 동작 | "Go Live" 단일 표면 + 래치 해제 affordance → P1(a) |

**기각**: OMC 코드 직접 이식(플랫폼이 다름 — OMC는 Claude Code hook 생태계, Boule은 독립 하네스), OMC식 fail-open을 게이트에 적용(외부 부수효과가 있는 Boule은 게이트 fail-closed가 옳다).

## 2. "왜 안 도는가" — 근본 원인 (ranked, 증거)

> 표기: 코드 증거는 직접 확인 또는 리서치 에이전트 확인(2026-06-12). DB 증거는 라이브 앱 DB
> (`~/Library/Application Support/co.kr.mirrorless.workradar/work-radar.db`) read-only 조회(2026-06-12).

- **R1. 시스템이 disarmed 상태로 출고·방치됨.** 유일 등록 프로젝트(이 repo)가 `tick_enabled=0, attention_required=1, live_enabled=0` — 2026-06-10 08:52 `needs_human`(exit 10) 이후 래치 고정. due-scan이 3중으로 제외(`ticker_scheduler.rs:152-166`). 스케줄러 heartbeat는 오늘도 살아있으나(fired=0) 프로젝트는 영원히 안 쏨. `live_enabled=0` ⇒ stub adapter(`ticker.rs:91-93`), readiness는 `BOULE_CONDUCTOR_MODE=live` 요구(`readiness.ts:74-77`) ⇒ 켜도 `readiness_failed`. **래치 해제 버튼이 없고**(해제 경로 = 수동 Tick now가 비-attention으로 끝나는 것뿐, `ticker.rs:692-721`), 재무장 의식이 어디에도 문서화 안 됨.
- **R2. checkless step ⇒ `needs_human` 구조적 보장.** tick 경로의 완료 권위는 deterministic `step.check`뿐: `runTick`이 `completeReportedDone(workspaceDir, deps.completionDeps, now, rand)`를 **options 없이 호출**(`tick.ts:138`, 직접 확인) ⇒ `options.evaluate` 부재 ⇒ evaluator rung 도달 불가. repo 전역에 라이브 `EvaluateFn` 구현 0개(타입 정의는 `conductor/completion.ts`뿐, grep 확인). 2026-06-10 래치의 직접 원인("1 completion check(s) need a human"). ADR-0010 Deferred §는 이를 명시적으로 남겨뒀다("the chain is built; the live judge call is the next executor wiring") — 즉 모순이 아니라 **수락된 설계의 마지막 미배선 잔여**(체인 배관은 있으나 rung은 죽은 코드).
- **R3. cadence가 앱 수명에 종속.** cron/launchd/systemd 배선 0(repo 전역 grep + `crontab -l` 빈 것 확인, OS 스케줄러는 T5 명시 deferred — `docs/plans/2026-06-08-boule-operations-layer.md:106-108`). 앱을 닫으면 자율성 소멸.
- **R4. HITL 도달 채널 미완.** ① outbound `governance/bridge/boule_sync_telegram.py`는 수동 one-shot, 호출자 0 ② inbound `~/.hermes/.../governance_bridge.py:46-48` 기본 워크스페이스 = **구** `governance/workspace`(라이브는 `.boule/workspace`) — 폰에서 탭해도 conductor가 안 보는 곳에 기록 ③ 앱에 choose/approve UI 없음 ④ `pending_escalations`는 72h TTL 후 항목을 **숨기는데** halt는 영구 지속(`pending.ts:31-32` vs `conductor.ts:128`) — 운영자 리스트에서 사라진 채 plan만 멈춰 있음.
- **R5. 완주해도 보이지 않음.** merge-back은 인간 전용(`adapter.ts:60-62` — 올바른 게이트), 그러나 **표면화가 없어** 지금도 unmerged plan 브랜치 2개가 조용히 방치(`boule/evt_20260610_075405_4553`, `boule/evt_20260610_142645_26fa` — `git branch --no-merged dev`로 확인). "풀 자율 성공"의 가시 결과가 0.
- **R6. budget/난이도 레일이 장식.** wrapper tail이 `--usage-tokens`를 절대 안 보냄(`adapter.ts:214-239` 직접 확인 — exit-code/dirty/stderr-digest만) ⇒ 전 attempt `usage:"unknown"` ⇒ `reservedSpend`=max(`budget.ts:173-184`). `cmdTick`은 `TickDeps.budget`을 아예 구성 안 함. 현 config에 budget 캡·backends 체인 부재 ⇒ 토큰 소진 fallback도 stall로 귀결(`handlers.ts:224-229`).
- **R7. 운용 마찰 잔재.** `boule` bin alias 부재(`governance/package.json`에 bin 없음 — 매번 `node --experimental-strip-types …` 주문), `CMUX_SOCKET_PATH`는 preflight 필수(`preflight.ts:71-77`)인데 앱이 주입하지 않음(상속 의존 — Dock 실행 시 영구 `infra_failed`), reviewer quorum은 `.boule/mcp.json`에 `BOULE_REVIEWER_MODE=live` 미설정으로 stub(`server.ts:87-95`), `server.ts:45` 기본 워크스페이스도 구 경로, `housekeep` 무스케줄.

## 3. 문서·폴더 정합 인벤토리

### 3.1 BLOCKER (에이전트를 능동적으로 오도)

- **B1. 경쟁 실행 큐 2개 + 순환 라우팅.** `INDEX.md:11` "라이브-자율 실행 큐(현재 진행)" → 06-07 플랜, 동시에 `INDEX.md:86-100` "다음 실행 큐: 정본 plan = 06-04 continuation, P6 Slice 2 🆕 next". 그 06-04 플랜 머리에는 "**SUPERSEDED (2026-06-10)** … do not execute this queue; see INDEX"(직접 확인) — INDEX는 실행하라, 플랜은 INDEX로 가라. 순환. 더해 `conventions.md` §3이 INDEX 라우팅 표를 **중복 보유**(같은 stale 포인터) — 라우팅 표가 두 곳이라 함께 썩었다.
- **B2. 루트 라우팅에서 governance 우주로 가는 길 0.** `CLAUDE.md`/`AGENTS.md`/`docs/areas/area-map.md`/`docs/architecture.md` 4개 파일에 governance/boule 매치 0(grep 확인). `governance/**`, `src-tauri/src/governance/**`, `.boule` 글롭에 대응하는 area 행 부재. 신선한 에이전트는 INDEX·conventions·HARNESS를 우연으로만 발견.

### 3.2 MAJOR (낡아서 혼동)

- **M1. INDEX가 최근 3세대 트랙 누락**: `2026-06-07-configurable-backends-wiring.md`, `2026-06-08-autonomous-coding-master-plan.md`(ADR-0010 as-built), `2026-06-10-step-worktree-chaining.md`, 앱측 `docs/plans/2026-06-08-boule-operations-layer.md`, ticker-reliability·control-room 스펙들(`docs/superpowers/specs|plans/2026-06-09*, 2026-06-10*`) 전부 INDEX 비가시.
- **M2. Phase I 상태 자기모순**: `INDEX.md:36,61` "I parked" vs `INDEX.md:74` "I ✅ Slice 1 DONE locally" — 실제는 dev 랜딩+라이브 실증(2026-06-07).
- **M3. GDL cutover 규칙 사문화**: `governance/docs/decisions.md:11` "새 거버넌스 breadcrumb → GDL" 선언 후 5일간 GDL 4건 vs 순수 거버넌스 breadcrumb 다수가 앱 `docs/decisions.md`(DL)에 착지(`:582,:583,:585` + `d6463f1`, `9db1902`). 규칙이 픽션.
- **M4. ADR 넘버링 규칙이 충돌 유도**: 앱 `docs/adr/0011-*`이 존재하는데 `docs/adr/README.md:92-93`·`conventions.md:35-36`·`INDEX.md:13`은 "앱 0001–0006 / 거버넌스 0007–" 범위 분할 서술 — 다음 거버넌스 ADR 저자가 0011을 민트하면 충돌(인덱스 hard-error가 사후 방어할 뿐).
- **M5. 구 워크스페이스가 라이브 SSOT로 문서화**: `governance/workspace/events/` 최신 = 2026-06-02(동결), 라이브는 `.boule/workspace/events/`(~06-10). 그런데 `governance/README.md:13` "workspace/ — git-tracked SSOT", `workspace/README.md:29`는 T4b로 은퇴한 `state/` 캐시를 현역 서술. HARNESS.md·agents/*.md 등 **영구 문서가 동결된 런타임 트리 안에** 산다.
- **M6. 런북이 gitignore 결정과 모순**: `runbooks/2026-06-07-live-loop-smoke.md:26` "`boule.config.json` (committed)" vs `.gitignore:22` `.boule/` 전체 ignore(직접 확인).

### 3.3 MINOR

`.omx/artifacts/` 인용(존재하지 않는 gitignored 경로를 증거로 — SHA로 인용해야 함, `INDEX.md:74`·v3 설계 `:344`), `docs/prototypes/.omc/` 부유 상태 디렉터리, "app-layer boule-ops 문서" 카테고리가 conventions에 미정의(boule 문서가 3개 plan 디렉터리에 산개하는 원인), `governance/README.md:4` Postgres→실제 PGlite, 런북 §1 placeholder 경로(실제 = `governance/bridge/boule-mcp.mjs`), `.omx`가 `.git/info/exclude`에만 ignore(`.gitignore` 비일관).

### 3.4 상태 디렉터리 스프롤 (5 roots vs OMC 1 root)

| Dir | 판정 |
| --- | --- |
| `.boule/` (config·mcp.json·workspace) | **LIVE** — per-repo 런타임 SSOT, gitignored |
| `governance/workspace/` | 런타임으론 **CORPSE**(2026-06-02 동결) / 문서 홈으론 현역(HARNESS.md·agents·MCP.md) — 분리 필요 |
| `governance/workspace/state/` | **CORPSE** (T4b 은퇴, 빈 dir) |
| `governance/scripts/orchestration/` | LIVE (ADR-0010 D6 툴킷) |
| `.omc/`, `.omx/` | 외부 도구 소유(혼동 방지 라벨만) · `docs/prototypes/.omc/`는 삭제 |

### 3.5 타깃 구조 (P0 산출물)

```
CLAUDE.md / AGENTS.md / docs/areas/area-map.md
  └─ +area 행: "Boule governance harness"
     globs: governance/** | src-tauri/src/governance/** | .boule 설정
     → governance/docs/INDEX.md (+ conventions.md, HARNESS)

governance/docs/
  INDEX.md        # 프런트도어 = 라우팅 전용 (상태 셀·큐 0개)
  STATUS.md       # 신설 — 유일한 moving ledger: 현재 큐 + dated landed-tracks 표
  conventions.md  # §3 라우팅 표 중복 제거(INDEX 위임 1줄로) + app-layer boule-ops 배치 규칙
                  # + ADR 넘버링 = repo 전역 max+1 + GDL 처분 반영
  plans/README.md # 신설 — "plan은 착수 시점 스냅샷, todo로 읽지 말 것; 진실 = STATUS/decisions/git"
  (harness 영구 문서 이동은 P5 — P0는 LEGACY 배너까지만)
governance/workspace/   # "LEGACY — frozen 2026-06-02, live = .boule/workspace" 배너, 빈 state/ 삭제
.gitignore              # + .omx/
```

## 4. 개선 페이즈

> 공통 규율: 한 PR=한 관심사. 각 페이즈 = 별도 슬라이스(TDD) + 별도 critic 패스 + `docs/reference/commands.md` 게이트(governance vitest·tsc, 앱은 typecheck/lint/vitest, Rust 변경 시 cargo 3종). 페이즈 간 의존은 명시된 것만(P3a→P1c).

### P0 — 문서 정합 (docs-only, 코드 0, 단일 PR)

**변경**: §3.5 타깃 구조 그대로. 구체 항목: ① INDEX `§다음 실행 큐`(:86-100) 삭제 + Phase I 상태 단일화(M2) + 누락 트랙 라우팅(M1) + 상태/큐를 STATUS.md로 이관 ② STATUS.md 신설(현재 큐 = 이 플랜 P1–P5 + dated landed-tracks 표; **이 플랜 자체를 등록**) ③ area-map 행 추가 + CLAUDE.md 빠른 라우팅 1줄 + AGENTS.md Important Paths 1줄(B2) ④ conventions.md: 라우팅 표 중복 제거, ADR 규칙 = "repo 전역 단일 시퀀스, next = max(양 dir)+1, 배치는 도메인"(M4 — `docs/adr/README.md` 동기 수정), app-layer boule-ops 카테고리 정의, GDL 처분 ⑤ **GDL 처분(권고: 은퇴)** — 5일 실증 실패(§3.2-M3), `governance/docs/decisions.md`를 GDL-004에서 동결(닫는 항목 1줄)하고 "모든 breadcrumb → 앱 DL" 규칙으로 회귀; ingestion은 additive(`src/index/sources.ts`)라 코드 무변경, 기존 GDL id 안정 ⑥ legacy 배너(M5: `governance/README.md`·`workspace/README.md`·HARNESS §9) + 빈 `workspace/state/` 삭제 ⑦ 런북 수정(M6 + placeholder) — 여기에 **재무장 의식 8단계를 "오늘 손으로 켜는 법"으로 명문화**(코드 고치기 전에도 시스템을 쓸 수 있게). 8단계 정본(런북에 이대로 전사): ❶ cmux 가능한 env에서 앱 실행(`CMUX_SOCKET_PATH` 상속 필요, 앱은 열어 둠) ❷ `.boule` init 확인(이 repo는 존재; 없으면 `boule init`) ❸ Control Room에서 LIVE 토글 + tick enabled + interval/max_steps ❹ attention 래치 해제: pending `needs_human` 해소 후 Tick now가 비-attention으로 종료돼야 리셋 ❺ MCP 세션(`claude --mcp-config .boule/mcp.json`)에서 `propose_spec`→`propose_plan` — **모든 step에 `check.command|artifact`** ❻ `autonomyLevel=full`이면 auto-accept(아니면 `accept_*` 수동) ❼ halt=`choose`(MCP)/needs_human=수정 후 Tick now/stall=redispatch ❽ 완주 후 `boule/<planId>` 수동 머지 ⑧ minors(.omx gitignore, prototypes/.omc 삭제, PGlite, .omx 인용→SHA).

**Done-criteria**: 신선한 에이전트 시뮬레이션 — CLAUDE.md→area-map→INDEX→STATUS 체인만으로 "현재 큐"를 1홉씩 정확 도달(라우팅 체인 수동 추적으로 검증); INDEX 내 상태 셀/큐 0; 수정 문서의 상대 링크 전수 해소(링크 체커 스크립트 1회 실행); breadcrumb은 DL에 1줄.

### P1 — Disarmed→Armed: "켜면 돈다" 운용 표면 (앱 Rust+FE)

**변경**: (a) **attention 래치 해제 affordance** — Control Room 프로젝트 행에 해제 버튼(확인 다이얼로그 + 래치 사유 `last_outcome`/`last_report_json` 표시; IPC = tauri-specta 신규 커맨드, DB UPDATE는 기존 row 필드라 마이그레이션 불요) (b) **Go-Live 체크리스트 패널** — 기존 READINESS strip을 항목별 remedy 텍스트+직결 토글로 보강(`tick_enabled`/`live_enabled`/interval/래치/cmux/git 각각 "왜 fail + 어떻게 고침") (c) **CMUX_SOCKET_PATH 해석기 공유화** — env → `.boule/boule.config.json` 필드 → 디스커버리(소켓 글롭) 순 폴백, 앱 ticker와 CLI tick 양쪽이 사용; 실패 시 기존 `infra_failed` bounded escalation 유지(headless 자동 강등 **금지** — 가시 pane이 운용 정본) (d) `boule` bin alias(`governance/package.json` `bin` 등록 — `node --experimental-strip-types` 주문 제거).

**Done-criteria**: 래치된 프로젝트를 GUI에서 사유 확인→해제→Go-Live 체크리스트 전 항목 green→Tick now 성공을 라이브 1회 관찰; Dock 실행(터미널 env 없음)에서 cmux 디스커버리로 readiness green; bindings drift 0.

### P2 — 완료 권위 실전화: needs_human 디폴트 탈출 (governance TS)

**변경**: (a) **authoring 게이트(fail-closed)** — plan accept 시 check 없는 step 검출: `autonomyLevel=full`의 autoAccept는 checkless plan을 **자동 수락하지 않고** 인간 accept로 강등(이유 명시 이벤트); 인간 accept는 경고와 함께 허용(명시적 `check: human` 표기 시 경고 억제). 침묵으로 needs_human에 도달하는 경로 제거 (b) **evaluator rung 배선 완성** — `cmdTick`이 `policy.backends.evaluator` 구성 시 `options.evaluate`를 전달(ADR-0010 accepted 설계의 마지막 배선 — 새 레일 아님); 라이브 `EvaluateFn` = one-shot `claude -p`(backends 체인 준수) JSON verdict, bounded timeout, parse 실패/소진 = 기존 fail-closed(`needs_human`) 유지; **config 미설정 시 현행과 동일 동작**(opt-in) (c) **step-prompt에 check 계약 주입** — executor가 무엇으로 판정받는지 프롬프트에 명시(현재 envelope에 있어도 prompt 본문에 누락 시 보강).

**Done-criteria**: checkless plan이 full-autonomy에서 auto-accept 강등되는 vitest; evaluator rung 단위·통합 테스트(stub) + 라이브 1회 실증(evaluator가 task_completed 인증); **음성 경로 1회 관찰 — evaluator parse-failure/timeout이 silent pass가 아니라 `needs_human`으로 폴백**(INVARIANT #1 임계 경로의 배선 중 회귀 방지); 기존 732 테스트 무회귀.

### P3 — 심장박동 독립 + 에스컬레이션 도달 (governance TS + 운영)

**변경**: (a) **T5 OS 스케줄러** — `boule schedule install|uninstall|status` CLI가 `~/Library/LaunchAgents/` plist 생성(StartInterval, repo별; **사용자 발동·가역·audit 로그** — ADR-0006 외부 dir 쓰기 레일 준수). 선행: **tick mutex**(`.boule/workspace` advisory lock, TTL 부착) — 앱 ticker와 launchd 동시 tick 이중 dispatch 방지. launchd env에는 P1(c) 디스커버리가 cmux 소켓을 해석 (b) **inbound bridge 경로 수정** — `governance_bridge.py` 기본 워크스페이스 → per-repo `.boule/workspace`(+ hermes gateway env 문서화); `server.ts:45` 기본값도 동기 수정 (c) **outbound 자동화** — tick 종료 시 pending escalation 존재하면 `boule_sync_telegram.py sync-once` 호출(기존 sent-marker dedup·bounded 유지; 실패는 tick 결과에 비차단 기록) (d) **pending TTL 결함 수정** — 만료 블록을 숨기지 않고 `expired` 상태로 계속 리스트(halt가 지속되는 한 비가시 금지).

**Done-criteria**: 앱 종료 상태에서 launchd가 tick 실행한 로그 관찰; 동시 tick 시도가 mutex로 단일화되는 테스트; 폰 Telegram으로 escalation 수신→`choose`→다음 tick resume 라이브 1회; 만료 escalation이 리스트에 잔존하는 테스트.

### P4 — 성과 가시화 + budget 실화 (governance TS + 앱)

**변경**: (a) **unmerged 산출물 표면화** — tick 결과·`boule snapshot`·Control Room에 완주-미머지 `boule/<planId>` 브랜치 목록 표시(머지는 인간 유지; gated auto-PR은 external-action-gate 커넥터 합류 시 별도 플랜) (b) **usage 파싱** — `claude -p --output-format json`/`codex exec --json` 출력에서 토큰 추출 → wrapper tail `record-attempt --usage-tokens`; `cmdTick`이 `TickDeps.budget` 구성 + config 기본 캡 문서화 (c) **실패 피드백 루프**(OMC 패턴 8) — redispatch/재시도 step-prompt에 직전 attempt stderr digest·exit code 요약 주입.

**Done-criteria**: 완주 플랜이 Control Room에 "merge 대기 N"으로 보임; 라이브 attempt 1회에서 usage가 unknown이 아닌 실측 기록; budget reconstruct가 실측 누적을 사용하는 테스트; 동일 실패 2연속 시 프롬프트에 직전 digest 포함 테스트.

### P5 — 구조 통합 (후순위, 독립)

**변경**: harness 영구 문서(HARNESS.md·agents/*.md·interfaces/MCP.md·orchestrator/README)를 `governance/docs/harness/`로 `git mv`(workspace는 순수 동결 아카이브로) → INDEX/area 라우팅 갱신; `housekeep` 저빈도 스케줄 — **P3(a) plist 재사용으로 확정**(tick 횟수 커플링 기각: disarmed 프로젝트에선 영원히 안 돌게 됨); 구 workspace 이벤트 harvest-후-아카이브 여부 결정(1줄 breadcrumb).

**Done-criteria**: HARNESS 참조 링크 전수 해소; housekeep 자동 실행 로그 1회.

## 5. Non-goals / 기각 옵션

- **상주 데몬 자작 기각** — cron-is-clock 설계 유지(`tick.ts:77`). launchd가 시계.
- **자동 merge-back 기각** — 외부 mutation은 인간/게이트 경유(INVARIANT). P4는 가시화까지만.
- **OMC 코드 이식 기각** — 원칙만 이식(§1.1). hook 생태계 의존 코드는 Boule 환경에 부적합.
- **게이트 fail-open 전환 기각** — Boule 게이트는 fail-closed가 옳다(외부 부수효과). fail-open은 인프라 계층(이미 bounded escalation)에 한정.
- **INDEX에 상태 셀 복원 금지** — front-door/ledger 분리(P0)가 rot 재발 방지의 핵심.
- **headless 자동 강등 기각** — cmux 가시 pane이 운용 정본(사용자 지시 2026-06-08). 디스커버리 실패는 escalation으로.

## 6. INVARIANT 체크 (`docs/areas/decision-rails.md` 7개 대조)

- **#1 자동화의 결정 레일 침투 금지**: P2(b) evaluator rung은 ADR-0010에서 이미 수락된 완료-권위 설계의 배선 완성이며 opt-in(config 미설정 = 현행 동일). P2(a)는 오히려 자동 수락을 **좁힌다**(checkless → 인간 강등). P3(a) 스케줄러는 시계일 뿐 — tick 내부 게이트(readiness/halt/autonomy) 전부 보존. P3(c) outbound는 read-only 알림. **침투 없음 — 오히려 fail-closed 강화.**
- **외부 토큰 keychain**: 신규 토큰 저장 없음(Telegram 브릿지는 기존 hermes 자격 경로 유지).
- **bounded retry only**: evaluator(1-shot+timeout), sync-once(기존 bounded), launchd(StartInterval 고정 — retry 아님), mutex TTL. 무한 루프 신설 없음.
- **SQLite 마이그레이션 전용**: P1 래치 해제는 기존 컬럼 UPDATE(스키마 불변). 신규 스키마 필요 시 마이그레이션.
- **IPC = tauri-specta**: P1 신규 커맨드 전부 bindings 재생성 + drift 0 게이트.
- **AppError envelope / 로그 PII 금지**: 신규 Rust 커맨드 동일 규율. Telegram 본문은 기존 브릿지 포맷(escalation 요약) 유지.
- **워킹트리 무손상**: P3(a) launchd tick도 기존 detached worktree 격리 그대로(`.boule/worktrees`).

## 7. 리스크 & 롤백

| 리스크 | 완화 |
| --- | --- |
| launchd tick ↔ 앱 ticker 이중 dispatch | P3(a) mutex가 **선행 deliverable**(스케줄러 설치 전 머지); tick 자체도 이벤트 소싱이라 중복 conduct만이 위험 — mutex가 차단 |
| evaluator LLM 비용·오판 | opt-in + bounded + verdict는 task 단위 fail-closed(`needs_human` fallback 유지); 정족수 확장은 후속 |
| P0 대수술이 타 세션과 충돌 | docs-only 단일 PR로 즉시; 충돌 시 문서 머지는 union-safe |
| cmux 디스커버리 오탐(죽은 소켓) | stat-isSocket 검사 후 채택(as-built; full connect-probe는 비용 대비 기각 — 오탐 시 기존 readiness-fail 경로로 안전 강등) |
| 만료-미전달 escalation의 1회 지연 전달 | **의도된 동작**(P3d as-built, critic 판정 수용): expired-but-undelivered 블록은 sent-marker dedup으로 **딱 1회** 전달된다 — halt가 실재하는데 침묵 드롭하던 것이 원래 버그. 운영자에게 stale 알림 1회 도달 가능성을 여기 명시 |
| GDL 은퇴가 06-07 결정 번복 | 5일 실증 데이터(§3.2-M3) 근거 명시 + breadcrumb 기록; ingestion 무변경이라 가역. in-flight 중 GDL 신규 행이 끼어들면 freeze note에 흡수(union-safe) |
| 롤백 | P1/P2/P3 각 슬라이스 독립 revert 가능(opt-in 설계); launchd는 `uninstall` 한 방(가역) |

## 8. 검증 명령 (인덱스 — 정본은 `docs/reference/commands.md`)

- governance: `pnpm vitest run`(governance/) + `tsc --noEmit` — 현 기준선 732/732.
- 앱 FE: `pnpm typecheck` + `pnpm lint` + `pnpm vitest run`; Rust: cargo test/clippy/fmt(P1).
- bindings drift 0(P1), 라이브 스모크 항목은 각 페이즈 done-criteria에 명시(관찰 = 증거).
