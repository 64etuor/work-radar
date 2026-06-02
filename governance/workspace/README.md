# Boule SSOT Workspace

markdown이 단일 진실의 원천(SSOT). 인덱스(Postgres, Phase F+)는 파생물이며 이 디렉토리에서
완전 재구축 가능하다(write-first rule). 운영 규율은 `HARNESS.md`.

## 인식론적 사다리 (L0–L4) — 무엇을 참이라 믿는가

- `events/`     L0 — append-only, immutable. `YYYY-MM-DD/HH-MM-SS_<type>.md`
- `patterns/`   L1 — 반복 관찰 (active/ archived/)
- `hypotheses/` L2 — 검증 가능 가설 (testing/ archived/)
- L3 Decisions / L4 Principles는 여기 복제하지 않는다 — 정본은
  `docs/adr/` + `docs/decisions.md` + `docs/areas/decision-rails.md`. 어댑터가 인덱싱.

## 실행 평면 (Spec → Plan → Task → Session → Handoff) — 지금 무엇이 흐르는가

같은 L0 이벤트 스토어에 라이딩. **verdict 권위 없음.** 상태는 전부 이벤트 fold에서 **파생**
(keystone invariant — `HARNESS.md` §3). `status:`를 손으로 고치지 않는다.

- `specs/`      무엇을 만들지 — **본문=사람 저술** (proposed/ active/ accepted/ archived/) · 추적됨
- `plans/`      어떻게 분해 — 파생 투영 (proposed/ active/ done/ archived/) · `*.md` gitignore
- `tasks/`      실행 단위 — 파생 투영 (ready/ active/ blocked/ review/ done/ archived/) · `*.md` gitignore
- `sessions/`   런타임 관찰 객체 — 파생 (active/ waiting/ blocked/ checkpointing/ handoff_ready/ closed/ crashed/) · `*.md` gitignore · Phase D
- `handoffs/`   연속성 계약 — 파생 (pending/ consumed/ archived/) · `*.md` gitignore · Phase G
- `orchestrator/` 정책·상태머신·라우팅·세이프티레일·session-templates — **사람 저술** · 추적됨 · Phase E

## 공통

- `reviews/`    External Reviewer 산출물 (런타임 출력 · gitignore)
- `state/`      재생성 가능 캐시 view (파생)
- `agents/`     에이전트 명세서 (SSOT의 일부 · ALLOWED_PATHS 선언)
- `interfaces/` MCP 명령/도구 명세

> `.gitkeep`은 디렉토리 트리를 보존한다. 파생 디렉토리의 생성 `<id>.md`는 런타임 출력이므로
> gitignore된다(`governance/.gitignore`). 트리만 있고 비어 보이는 건 정상 — 상태는 `events/`에 있다.
