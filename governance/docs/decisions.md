# 거버넌스 결정 로그 (Boule 하네스)

Boule 거버넌스 하네스의 Phase 트레이드오프·운영 breadcrumb (append-only).
구조적 결정은 `adr/`(거버넌스 ADR), 작은 Phase 노트는 여기.

**Cutover (2026-06-07):** 이 로그는 이 시점부터 **앞으로의 거버넌스 breadcrumb만** 담는다.
이전 거버넌스 항목은 repo-root `docs/decisions.md`에 앱 항목과 시간순으로 섞여 그대로 남는다
(연대기·`DL-NNN` id 안정성 보존 위해 과거 발굴/이동 안 함; `conventions.md` §2). 인덱스 빌드는
두 로그를 **둘 다** 읽으며, 이 로그의 행은 `GDL-NNN`으로 부여돼 repo 로그 `DL-NNN`과 충돌하지 않는다.

규칙: 새 **거버넌스(Boule)** breadcrumb → 여기. 새 **앱(work-radar)** breadcrumb → `docs/decisions.md`.

---

- **거버넌스 문서/하네스 구조 정합성 — 이상적 구조 확정(2026-06-07)**: codex 자문(`codex exec`, session `019ea1c4`)으로 "가장 이상적인 구조"를 설계. **결정**: (1) L3/L4 ingestion을 하드코딩 3경로에서 **configurable additive source list**(`src/index/sources.ts` `DEFAULT_INDEX_SOURCES`)로 리팩터 — `build.ts`가 `docs/adr/`+`governance/docs/adr/`, `docs/decisions.md`+`governance/docs/decisions.md`를 **둘 다** read(back-compat, fail-soft); `parseDecisionLog`에 `idPrefix` 옵션(기본 `DL`, 거버넌스 `GDL`=id 충돌 회피); ADR id가 두 dir에 중복이면 **hard-error**(silent overwrite 금지). (2) 거버넌스 ADR `0007–0009`를 `governance/docs/adr/`로 `git mv`(frontmatter `adr-id`라 ID 불변; 본문 무수정=immutability 유지). (3) `decisions.md`는 **prospective split만** — 이 로그 신설, 과거 ~250줄 교차 항목은 발굴 안 함(연대기·`DL-NNN` 보존). (4) `src/`(24 axis 모듈)·`workspace/`는 **이미 이상적 → 무변경**(rename=churn). 정본 규칙=`conventions.md`. **검증**: governance `tsc --noEmit` 0 · vitest `test/index` 29/29(신규: governance-source ingest·dup-ADR throw·GDL prefix) · 앱 `bindings.ts`/migration 무변경. 마이그레이션 = Phase 1(docs-only, `a371b9c`) + Phase 2(이 커밋, 코드+ADR 이동). critic 별도 패스 ACCEPT 후 done.

- **configurable-backends Slice 1 — codex `CODEX_HOME` hook isolation(2026-06-08)**: codex 자문(session `019ea1c4`)으로 설계. 문제=operator `~/.codex`(oh-my-codex+cmux+computer-use+telegram, 의도적 daily setup)의 훅(config.toml `notify`/`plugin_hooks`/`developer_instructions` + `hooks.json`)이 conductor가 cmux surface에서 띄운 `codex exec`를 hijack(빈 응답). **결정: operator 설정 제거 대신 격리** — conductor codex를 clean per-repo `${governanceWorkspace}/codex-home`(훅 없는 `config.toml`=`plugin_hooks=false`/`notify=[]`, hooks.json/plugins 없음)로 spawn(`CODEX_HOME=` prefix는 `codex exec`에만 scope, `&& complete-task` tail은 미상속). operator `~/.codex` 무손상·portable. **auth tradeoff(기록)**: env key(`OPENAI_API_KEY`/`CODEX_API_KEY`) 우선 → 파일 0; 없으면 operator `auth.json`을 **symlink**(복사 X — OAuth 시크릿 중복/stale 방지; 단일 실 identity). ⚠codex가 OAuth refresh하면 symlink로 operator 실파일에 write-through됨 — 의도적 수용(같은 identity). 둘 다 없으면 spawn 전 **throw**(미인증 codex 안 띄움); dangling link(operator가 auth 회전/삭제)는 정리 후 throw. clean home은 runtime 산물(config+auth symlink+codex session history) → **`governance/.gitignore`에 `workspace/codex-home/` 추가**(commit 금지=PII/시크릿; per-repo 모드는 target repo `.boule/`가 커버). **검증**: tsc 0 · conductor 61(신규 ensureCleanCodexHome 7: config/symlink/env-skip/throw/hooks.json-rm/idempotent/dangling) · full 590 · governance-only(앱 무영향). opus critic 별도 패스 REQUEST-CHANGES(MAJOR=gitignore 누락) → 수정(+dangling Open-Q 처리) → done. `plan/autonomous-orchestration`(dev 위 rebase) 로컬. RFC §3 = `2026-06-07-configurable-backends-wiring.md`.
