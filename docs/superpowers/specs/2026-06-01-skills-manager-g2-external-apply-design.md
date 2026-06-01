# G2-PR1 — 외부 dir 적용(심링크) 설계

- **날짜**: 2026-06-01
- **Phase**: G2 (외부 dir 적용), 첫 PR
- **ADR**: [0006](../../adr/0006-skills-registry-full-manager.md) — 레일 ① (외부 dir 쓰기 = 사용자 발동·가역·audit)
- **선행**: G1(중앙 라이브러리+import+audit) · G1.5(네트워크 설치+백업+update) — dev/로컬 완료
- **상태**: 설계 승인됨 → 구현 계획 대기

## 문제와 기대 영향

중앙 라이브러리(`app_data_dir/skills-library/<provider>/<name>/`)는 managed 스킬의 SSOT다(G1).
그러나 그 스킬을 **실제 에이전트가 쓰게** 하려면 외부 에이전트 스킬 dir
(`~/.{claude,codex,openclaw,hermes}/skills/<name>`)에 적용해야 한다. G2-PR1은 managed 스킬 1개를
외부 dir에 **심링크로 적용**하고 **가역적으로 해제**하는 경로를 추가한다.

기대 영향: 사용자가 work-radar에서 중앙 관리하는 스킬을 멀티-에이전트 환경에 한 번의 사용자 액션으로
켜고 끌 수 있다. 잡 자동실행과는 무관한 **순수 파일 I/O + 감사 기록**이다(#1/#2 불변).

## 비목표 (이 PR 범위 밖, 명시적 defer)

- **프리셋/번들(#13)** — 여러 스킬 일괄 적용/해제. → G2-PR2.
- apply/remove를 넘어선 per-agent enable/disable 토글 UX 확장.
- Windows 권한 엣지 처리(아래 `cfg(windows)` 분기 이상).
- 프로젝트 워크스페이스·양방향 sync(#16/#22) — G3.

## 메커니즘

- **적용(apply)**: `~/.<agent>/skills/<name>` → 심링크 → `app_data_dir/skills-library/<provider>/<name>`.
  외부 `skills/` 루트 dir이 없으면 생성한다(benign — 스킬 dir 자체이며 config/secret 파일이 아니다).
- **해제(unapply)**: 심링크만 제거한다.
- **타깃 해석**: 외부 루트는 기존 `resolve_skill_roots`(scan.rs) 재사용. `<name>`은 기존
  `sanitize_segment`(central_repo.rs)로 정제해 외부 루트 밖으로 절대 탈출하지 못하게 한다(traversal 방어).
- **대상 provider**: claude / codex / openclaw / hermes (외부 루트가 해석되는 4종). `other`/사용자 루트는
  적용 타깃이 아니다 → terminal error(`skills.apply.unsupported_provider`).

## 상태 = 디스크(새 표 없음 — INVARIANT #7 / scan ethos 일치)

심링크는 **자기식별적**이다: 정규화된(canonical) 타깃이 중앙 루트 아래를 가리키므로 `(provider, name)`을
직접 복원할 수 있고, 적용 상태는 외부 루트를 읽어 **유도(derive)** 한다. 새 마이그레이션·캐시·drift가
없다. 이는 기존 스캔 설계("frontmatter-only, 디스크 SSOT, 캐싱 없음")와 일치한다. 감사 로그는 적용/해제
**이벤트**를 기록한다(레일 ①) — 상태 캐시가 아니라 사실 로그.

## 안전 규칙 (가역성·critic의 핵심)

1. **적용 시 타깃이 이미 우리 심링크**(canonical 타깃이 중앙 루트 아래) → 멱등 성공(no-op).
2. **적용 시 타깃이 실제 dir 또는 외부(foreign) 심링크로 존재** → terminal `skills.apply.collision`.
   **절대 덮어쓰지 않는다** — 데이터 손실 가드.
3. **해제(unapply)** 는 그 경로가 **심링크이고 canonical 타깃이 중앙 루트 아래일 때만** 제거한다.
   아니면 terminal `skills.apply.not_ours` → 거부. 이것이 "사용자 SKILL.md 무손상"을 보장한다.
4. 적용 전 중앙 스킬이 존재해야 한다(없으면 `skills.apply.no_source`).
5. 경로 가드: `sanitize_segment(name)`으로 외부 루트 탈출 차단.

## 새 모듈 + IPC (`src-tauri/src/skills/apply.rs`)

순수 fs 코어(앱 핸들 비의존 → tempdir hermetic 테스트) + 얇은 `#[tauri::command]` 래퍼.

- `apply_managed_skill(provider, name) -> ()` — 심링크 생성 +
  `audit("apply", "external_dir", <ext_path>, Some(<central>), Some("symlink"))`.
- `unapply_managed_skill(provider, name) -> ()` — 심링크 제거 + `audit("unapply", …)`.
- `list_applied_skills() -> Vec<AppliedSkill { provider, name, externalPath }>` — FE 배지용, 디스크에서 유도.

심링크 생성: `#[cfg(unix)]` `std::os::unix::fs::symlink`(주 타깃 darwin);
`#[cfg(windows)]` `std::os::windows::fs::symlink_dir`.

`AppliedSkill`은 PK를 노출하지 않으므로 i32/i64 이슈 없음(specta 안전). 커맨드 추가 → bindings는
`cargo test`로 재생성(GUI 부팅 불요).

## FE

`SkillsView`에 managed 스킬 행/패널의 "적용 / 해제" 어포던스. `list_applied_skills`로 상태를 읽고 두
커맨드를 호출한다. 인라인 확인만 사용(중첩 Dialog 없음 → Sheet Esc 계약 보존). 디자인 정본 `DESIGN.md`
(Cohere white editorial) · shadcn/lucide 온스택 준수.

## 테스트 (TDD, hermetic tempdir)

코어 테스트:

1. apply가 심링크 생성 → 타깃이 중앙 스킬 dir과 일치.
2. **apply→unapply가 외부 dir 원상복구**(심링크 사라지고, 사전 존재한 실제 형제 파일은 무손상) =
   ADR 가역성 테스트.
3. 적용 충돌: 타깃이 실제 dir이면 거부(`collision`), 외부 파일 무손상.
4. 해제 거부: 타깃이 외부 심링크/실제 dir이면 거부(`not_ours`), 무손상.
5. sanitize가 `../` 탈출 차단.
6. 멱등 재적용(우리 심링크 위 재적용 = 성공 no-op).
7. `list_applied_skills`가 디스크에서 정확히 유도.
8. apply/unapply 각각 audit 행 기록(레일 ①).
9. 미지원 provider(`other`) 거부.
10. 중앙 소스 부재 시 적용 거부(`no_source`).

## 위험·롤백·마이그레이션

- **마이그레이션 없음**(상태는 디스크 유도). 롤백 = 커밋 revert + 사용자가 이미 적용한 심링크는
  unapply로 제거(또는 수동 — 심링크라 무해).
- 외부 dir 쓰기 위험은 안전 규칙 1–5 + 가역성 테스트 + audit로 상쇄(ADR Confirmation 충족).
- #1/#2 불변: 파일 I/O뿐, 잡 spawn/실행 경로 없음.

## 검증 (commands.md 인덱스)

`cargo test` · `cargo clippy --all-targets -- -D warnings` · `cargo fmt --check` ·
`pnpm typecheck` · `pnpm lint` · `pnpm vitest run` · `git diff --exit-code src/bindings.ts`(신규 커맨드만 drift).
독립 opus critic ACCEPT 후에만 done. self-approve 금지.
