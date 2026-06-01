# G2-PR2 — 배치 적용/해제(에페메랄 프리셋) 설계

- **날짜**: 2026-06-01
- **Phase**: G2 (외부 dir 적용), 둘째 PR — #13 프리셋/번들
- **ADR**: [0006](../../adr/0006-skills-registry-full-manager.md) — 레일 ① (외부 dir 쓰기 = 사용자 발동·가역·audit)
- **선행**: G2-PR1(단일 스킬 외부 dir 적용=심링크 + `apply_core`/`unapply_core` 코어) — 로컬 완료(미푸시)
- **상태**: 설계 승인됨 → 구현 계획 대기

## 문제와 기대 영향

G2-PR1은 managed 스킬 **1개**를 외부 에이전트 dir에 심링크로 적용/해제한다. 멀티-에이전트
환경에서 스킬을 켜고 끌 때 사용자는 보통 **여러 개를 한 번에** 다루고 싶어 한다(스킬 N개를
하나씩 클릭하는 건 번거롭다). G2-PR2는 managed 스킬 여러 개를 **한 번의 사용자 액션으로
일괄 적용/해제**하는 경로를 추가한다.

기대 영향: 사용자가 managed 목록에서 N개를 선택해 한 번에 적용/해제할 수 있고, 각 항목의
결과(적용됨/충돌로 스킵/소스 없음 등)를 **건별로** 확인한다. 잡 자동실행과는 무관한 **순수
파일 I/O + 감사 기록**이다(#1/#2 불변) — G2-PR1 코어를 그대로 반복 호출할 뿐 새 쓰기 메커니즘이
아니다.

## 비목표 (이 PR 범위 밖, 명시적 defer)

- **이름 붙은(영속) 프리셋** — 사용자가 명명·저장·재사용하는 번들. 이는 디스크에서 유도할 수 없는
  **새 영속 상태**(새 SQLite 표 + 마이그레이션)를 요구한다 → 본 PR은 **에페메랄 배치만**. 향후
  필요 시 별도 PR(별도 관심사).
- **한 스킬 → 여러 에이전트 fan-out** — 한 스킬을 claude+codex+… 여러 dir에 동시 적용. 중앙
  스킬은 한 provider 아래에만 존재하므로 provider 경계를 넘는 새 심링크 의미가 필요 → 범위 밖.
- **all-or-nothing 원자성 + 롤백** — best-effort(건별 보고)로 결정됨. dry-run/롤백 경로 없음.
- per-agent enable/disable 토글 UX 확장 · Windows 권한 엣지 · 프로젝트 워크스페이스/양방향 sync(#16/#22, G3).

## 모델 (결정 요약)

세 가지가 사용자 결정으로 확정됐다:

1. **에페메랄 배치** — 새 표/마이그레이션 없음, 디스크 SSOT 유지(INVARIANT #7). G2-PR1 코어 위
   순수 합성.
2. **multi-select managed 스킬** — 사용자가 managed 목록에서 N개 선택, **각 스킬은 자기 provider의
   대표 외부 루트**에 적용/해제(claude 스킬→`~/.claude`, codex 스킬→`~/.codex` …). 중앙 라이브러리
   모델(스킬 = provider-scoped)과 일치. 새 개념 없음.
3. **best-effort + 건별 결과** — 한 항목이 충돌/실패해도 배치는 중단하지 않는다. 각 항목 결과를
   `BatchItemResult`로 수집해 FE가 표시. 부분 롤백 복잡도 없음. G2-PR1 안전 규칙(충돌=거부, 덮어쓰기
   금지)과 일치.

## 새 타입 + IPC (`src-tauri/src/skills/apply.rs` 추가만)

전부 PK 미노출 → specta 안전(i64 이슈 없음). bindings 추가 = 커맨드 2개 + 타입 3개(가산 drift).

```rust
// 입력: 배치 항목 1건의 참조.
pub struct SkillRef { provider: SkillProvider, name: String }

// 출력: 항목 1건의 결과.
pub struct BatchItemResult {
    provider: SkillProvider,
    name: String,
    outcome: BatchOutcome,
    message: Option<String>, // error/충돌 등 사람이 읽는 상세(성공 시 None)
}

pub enum BatchOutcome {
    Applied,             // 새로 심링크 생성 OR 이미 우리 심링크(멱등) — post-state 동일이라 통합
    Collision,           // 타깃에 외부 파일/스킬 존재 → 스킵(덮어쓰지 않음). 안전-critical 가시.
    NoSource,            // 중앙 라이브러리에 스킬 없음
    Removed,             // 우리 심링크 제거 OR 이미 부재(no-op) — post-state 동일이라 통합
    NotOurs,             // unapply 타깃이 외부 파일/심링크 → 거부. 안전-critical 가시.
    UnsupportedProvider, // provider의 외부 루트 미해석(other/사용자 루트)
    Error,               // 기타 I/O 오류(message에 상세)
}
```

`Applied`는 신규 생성과 멱등(이미 우리 것)을 **통합**한다 — 사후 상태가 동일(심링크 존재, 중앙
타깃). `Removed`도 제거와 이미-부재를 통합(사후 상태=부재). **안전-critical 스킵**인 `Collision`과
`NotOurs`는 별도 값으로 가시 유지(사용자가 "왜 안 됐는지" 알아야 함).

### 코어 (앱 핸들 비의존 → tempdir hermetic, G2-PR1 패턴 동일)

```text
apply_batch_core(pool, central_root, roots: &[(SkillProvider, PathBuf)], items: &[SkillRef])
    -> Vec<BatchItemResult>
unapply_batch_core(... 동일 시그니처 ...) -> Vec<BatchItemResult>
```

- 각 항목: `roots`에서 그 provider의 외부 루트를 찾는다. 없으면 → `UnsupportedProvider`(코어 호출
  안 함). 있으면 **기존 단일 `apply_core`/`unapply_core`를 호출**하고 그 `Result`를 outcome으로
  매핑한다. **변이 로직은 G2-PR1 코어에 단일 소스로 유지** — 배치는 루프 + 분류만 한다(중복/drift 0).
- 에러→outcome 매핑은 `AppError`의 코드로 분기한다. 문자열 리터럴 산재를 피하려고 네 코드
  (`collision`/`no_source`/`not_ours`/`unsupported_provider`)를 **공유 `pub(crate) const`로 승격**해
  단일 코어와 배치 매퍼가 함께 참조한다(국소적·범위 내 개선).
- **best-effort**: 한 항목 실패가 배치를 중단시키지 않는다. 유효 항목은 그대로 적용된다.

### 감사 (변경 없음 — 자동 상속)

건별 `audit()`는 이미 `apply_core`/`unapply_core` **내부**에서 **실제 변이 시에만** 기록된다(멱등/
충돌/not_ours/부재 경로는 기록 안 함). 배치는 이를 그대로 상속 — **배치 레벨 감사 행 없음**. 레일 ①과
일관(상태 캐시가 아니라 사실 이벤트 로그).

### 커맨드 (얇은 래퍼)

```text
apply_managed_skills(items: Vec<SkillRef>)   -> Result<Vec<BatchItemResult>, AppError>
unapply_managed_skills(items: Vec<SkillRef>) -> Result<Vec<BatchItemResult>, AppError>
```

`central_root(app)`을 1회 해석 + `scan::apply_roots()`로 `roots`(provider별 대표 외부 루트, 지원
provider만) 구성 후 코어에 위임. 미지원 provider 항목은 `roots`에 없어 자동으로
`UnsupportedProvider`. 커맨드 추가 → bindings는 `cargo test`로 재생성(GUI 부팅 불요).

## FE (`SkillsView` / `ManagedViewer`)

가산 변경 — G2-PR1의 **인라인 단일 적용/해제는 유지**한다(제거 아님).

- managed 목록에 **선택 어포던스**(행별 체크박스) 추가.
- 1개 이상 선택 시 **배치 바** 노출: 선택 수 + "선택 적용 / 선택 해제" 버튼.
- 클릭 → `apply_managed_skills` / `unapply_managed_skills`를 선택된 `SkillRef[]`로 호출 → 건별 결과
  요약을 인라인으로 표시(예: "5 적용 · 1 스킵(충돌) · 1 소스 없음").
- 완료 후 `["skills","applied"]` invalidate(기존 `useAppliedSkills` 갱신).
- **인라인 확인만**(중첩 Dialog 없음 → Sheet Esc 계약 보존). shadcn/lucide 온스택, `DESIGN.md`
  (Cohere white editorial) 준수.
- **선결 검증(plan)**: shadcn Checkbox 프리미티브 존재 여부를 먼저 확인. 없으면 온스택 컨트롤로
  폴백 — 새 의존성 추가 아님(`docs/areas/shadcn-migration.md` 규율).

## 테스트 (TDD, hermetic tempdir, G2-PR1 스타일)

1. **all-valid 배치 적용**: 유효 스킬 N개 → 전부 `Applied`, 심링크 N개 생성, audit 행 N개.
2. **mixed 배치 적용**: 유효 1 + 충돌 타깃 1(외부 파일 무손상) + 중앙 부재 1 → 건별 outcome
   정확(`Applied`/`Collision`/`NoSource`), 유효 항목은 그대로 적용됨(**best-effort 증명**).
3. **멱등 재적용**: 우리 심링크 위 배치 재적용 → 전부 `Applied`, **새 audit 행 0**(멱등 경로 무기록).
4. **배치 해제**: 우리 심링크 제거 → `Removed`, audit 행 기록 + 외부 심링크 타깃 → `NotOurs` 거부
   (무손상) + 부재 타깃 → no-op(`Removed`, audit 0).
5. **미지원 provider 항목**: `other` 포함 배치 → 그 항목 `UnsupportedProvider`, 나머지 항목은 정상
   처리(중단 안 함).
6. **빈 배치**: `items=[]` → 빈 `Vec`, 에러 아님.

## 위험·롤백·마이그레이션

- **마이그레이션 없음**(에페메랄, 상태는 디스크 유도). 롤백 = 커밋 revert + 이미 적용된 심링크는
  무해(단일/배치 unapply로 제거 가능).
- 외부 dir 쓰기 위험은 G2-PR1 안전 규칙 1–5(코어 재사용)을 그대로 상속 — 배치는 새 쓰기 경로를
  도입하지 않으므로 추가 위험 표면 없음.
- **#1/#2 불변**: 파일 I/O뿐, 잡 spawn/실행 경로 없음.
- **INVARIANT #7**: 새 영속 상태 없음(디스크 SSOT).

## 검증 (commands.md 인덱스)

`cargo test`(바인딩 재생성) · `cargo clippy --all-targets -- -D warnings` · `cargo fmt --check` ·
`pnpm typecheck` · `pnpm lint` · `pnpm vitest run` ·
`git diff --exit-code src/bindings.ts`(가산 drift = 커맨드 2개 + `SkillRef` + `BatchItemResult` +
`BatchOutcome`만 예상).

독립 opus critic ACCEPT 후에만 done. self-approve 금지. **로컬 커밋만 — 미푸시**(푸시는 사용자
명시 요청 시 별도).
