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
| 거버넌스 ADR | `governance/docs/adr/` (0007–) |
| 거버넌스 결정 로그 | `governance/docs/decisions.md` |
| 카탈로그/프런트도어 | `governance/docs/INDEX.md` |
| 진행 상태·실행 큐 (moving ledger) | `governance/docs/STATUS.md` |
| 이 컨벤션 | `governance/docs/conventions.md` |
| 앱 운영층 boule 문서 (앱 ticker·Control Room 등 **앱 코드가 주체**) | 앱 정본 위치(`docs/plans/`·`docs/superpowers/{specs,plans}/`) — INDEX 카탈로그가 교차 라우팅 |

- **`specs/` 별칭을 쓰지 않는다.** 거버넌스 spec 버킷은 `design/` 하나다(이미 우세 컨벤션).
- **`docs/superpowers/{specs,plans}/`는 generator 착지장일 뿐, 거버넌스 정본이 아니다.**
  `superpowers:brainstorming` / `writing-plans` 스킬이 기본으로 거기에 쓴다 →
  거버넌스 산출물이면 **생성 직후 `governance/docs/{design,plans}/`로 `git mv`**
  (히스토리 보존). 옮기기 전의 `docs/superpowers/` 거버넌스 문서는 **무효(미정본)**로 본다.

## 2. L3/L4 ingestion — 인덱스가 읽는 결정/원칙 소스 (additive)

인덱스 어댑터는 **하드코딩이 아니라 source list**(`governance/src/index/sources.ts`
`DEFAULT_INDEX_SOURCES`)로 L3/L4를 발견한다. `buildIndex(repoRoot, fs, sources?)`가 목록을
순회하며 read(누락 소스는 fail-soft). 그래서 거버넌스 L3/L4는 `governance/docs/` 아래에
두면서 repo-root 앱 L3/L4도 그대로 읽힌다.

| 소스 | 위치 | id | 비고 |
| --- | --- | --- | --- |
| 앱 ADR | `docs/adr/` | `ADR-NNNN`(frontmatter) | repo 앱 결정. **배치=도메인**(범위 분할 아님). |
| 거버넌스 ADR | `governance/docs/adr/` | `ADR-NNNN`(frontmatter) | **id는 repo 전역 단일 시퀀스 — next = 양 dir 통틀어 max+1**(`docs/adr/README.md` 정본). dir 간 중복=빌드 hard-error. |
| 결정 로그(단일) | `docs/decisions.md` | `DL-NNN`(순서) | repo 전역 breadcrumb — **거버넌스 포함 신규 전부 여기**(2026-06-12 GDL 동결 후). |
| 거버넌스 결정 로그(동결) | `governance/docs/decisions.md` | `GDL-NNN`(순서) | 2026-06-07 cutover 시도 → **2026-06-12 동결**(이중 로그 라우팅이 실무 미준수 — 헤더 참조). 인덱스는 계속 read(id 안정). |
| 결정 원칙(rails) | `docs/areas/decision-rails.md` | `INVARIANT-N` | 7 INVARIANTS, repo 전역(Boule 전용 아님) — 잔류. |

규칙:
- **소스 위치를 바꾸려면 `src/index/sources.ts`를 고친다**(build.ts 본문 아님) + vitest 검증.
  코드 변경이므로 docs-only 패스와 섞지 않는다(한 PR=한 관심사).
- **decisions.md는 단일 로그로 회귀(2026-06-12).** prospective split(2026-06-07)은 5일 실증에서
  미준수(거버넌스 breadcrumb 다수가 DL 착지) → GDL을 GDL-004에서 동결하고 **새 breadcrumb은
  전부 `docs/decisions.md`(DL)**. 기존 항목·id는 불변(연대기 보존), 인덱스는 두 로그를 계속 읽는다.
- `decision-rails.md`는 repo 전역이라 이동하지 않는다.

## 3. Canonical — "현재 Boule 전체"의 단일 진입점

**프런트도어 = `governance/docs/INDEX.md`** (카탈로그/라우터). **라우팅 표의 정본은 INDEX다 —
여기에 표를 중복하지 않는다**(과거 중복본이 INDEX와 함께 썩었다, 2026-06-12 제거).
**진행 상태·실행 큐 = `STATUS.md`**(유일한 moving ledger).

- **INDEX는 라우팅 전용** — 상태 셀(✅/🅿️/큐) 금지. plan 문서는 착수 시점 스냅샷(`plans/README.md`),
  진행은 STATUS만 든다.
- **마스터 플랜·v3 control-plane 설계는 프런트도어가 아니다** — INDEX가 라우팅하고 STATUS가 진행을 든다.
- per-phase 설계 9개는 2026-06-04에 §7 Phase Ledger로 **흡수·삭제**됐다(git 히스토리 보존).
  plan들의 `Spec:`/`Design:` 헤더는 그 삭제된 파일이 아니라 **§7로 가리킨다**.

## 4. 명명 규칙 (종류별)

| 종류 | 패턴 | 예 |
| --- | --- | --- |
| ADR | `{NNNN}-{kebab}.md` | `governance/docs/adr/0008-orchestrator-dispatch-decision-rail.md` |
| 설계 spec | `YYYY-MM-DD-{topic}-design.md` | `design/2026-06-07-boule-tick-bounded-driver-design.md` |
| 구현 plan | `YYYY-MM-DD-{topic}.md` | `plans/2026-06-07-boule-v3-live-autonomy-master-plan.md` |
| 런북 | `YYYY-MM-DD-{topic}.md` (point-in-time) | `runbooks/2026-06-07-live-loop-smoke.md` |
| append-only 로그 | 안정적 서술 이름(날짜 프리픽스 없음) | `orchestration/hermes-boule-decision-log.md` |

- ADR 네임스페이스 규칙은 `docs/adr/README.md`가 정본 — 중복하지 않는다.
- 날짜 프리픽스는 **생성일**(작업 시작일), 사후 갱신 시에도 유지.

## 5. 한 줄 요약 (AI가 헷갈릴 때)

> 거버넌스 문서? → `governance/docs/`. 진입점? → `governance/docs/INDEX.md`.
> v3 전모? → control-plane 설계 §7. **지금 뭐 하는 중? → `STATUS.md`.**
> 거버넌스 ADR? → `governance/docs/adr/`(id는 repo 전역 단일 시퀀스). 결정 breadcrumb? → `docs/decisions.md`(DL 단일 — GDL은 동결).
> 앱 L3/L4·decision-rails는 `docs/` 잔류. 인덱스가 둘 다 read(소스 목록=`src/index/sources.ts`, §2).
