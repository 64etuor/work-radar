# Boule Spec/Plan — `feat/governance-boule-p1` (B1) vs `feat/boule-v2-planner` 비파괴 비교

**작성:** 2026-06-02 · **상태:** 사용자/Hermes 결정 대기용 (canonical 채택/폐기 결정 미포함, push/merge/delete 없음).
**목적:** 두 브랜치가 같은 Phase A 커밋 `89115fb`에서 분기해 Spec/Plan 실행평면을 **각각 다른 설계로** 구현했다. v3 invariants 기준으로 차이를 정리하고 B1-only 개선점의 포팅 가치를 평가한다.

> ⚠️ 범위 한계(정직): v2-planner의 plan/spec **core fold·guards·handlers**는 직접 읽고 비교했다. v2의 spec/handlers·project·**Conductor(Phase C)**·v2 테스트는 깊이 읽지 않았다 — v2 invariant 준수는 코드(읽은 부분) + 메모리 기록의 critic ACCEPT에 근거. v2 테스트를 직접 재실행하지 않았다.

## 1. 두 브랜치 현황

| | `feat/boule-v2-planner` (tip `e040394`) | `feat/governance-boule-p1` (tip `cbe55f1`, 이번 세션) |
|---|---|---|
| 분기점 | `89115fb` (Phase A) | `89115fb` (Phase A) |
| 빌드된 슬라이스 | **B**(Plan+**Planner**) `40ab6eb` · **B2**(Spec) `6d61af6` · **C**(Conductor) `e040394` | **B1**(Spec+Plan SSOT) `ccded49`→`cbe55f1` |
| 모듈 | `src/{spec,plan,conductor}/` | `src/{spec,plan}/` |
| Planner | ✅ 있음 (`proposePlan(intent,steps)` actor:planner) | ❌ B2로 연기(미구축) |
| Conductor | ✅ 있음 | ❌ 없음 |
| critic | ACCEPT (메모리 기록) | ACCEPT (MAJOR specTrail leak 수정 후, 이번 세션) |
| push | 미푸시·파킹 | 미푸시 |

## 2. Plan 아키텍처 — 근본적으로 다름

| 축 | v2-planner | B1 |
|---|---|---|
| 모델 | **단일 객체 상태머신** (TaskState 미러): `draft→active→needs_revision→completed/archived/superseded`. verdict 마커. | **불변 버전 lineage**: 각 버전=고유 이벤트 id, `plan_revised`=내용 보유 새 버전 + `supersedes:<prev>`. |
| `plan_revised` 의미 | **수정 요청** 전이(active→needs_revision, 사유 기록). plan **내용은 불변**(propose body 고정). | **새 내용 버전 생성**(이전을 supersede). 내용이 버전으로 진화. |
| 교체(supersede) | `plan_superseded` 터미널 마커. **교체한 plan에 대한 참조 미기록** → 교체 계보 이벤트에서 재구성 불가. | `supersedes` 명시 참조 + `currentPlanForSpec` lineage head 해석 + `multipleHeads`/`danglingSupersedes` 진단. |
| Plan↔Spec 연결 | **없음**(plan은 standalone, `related_to:[specId]` 안 검). Planner는 free-text `intent`를 받음. | **있음**(`plan_proposed`/`plan_revised` related_to:[specId]). |
| 순서/MINOR #2 | `id.localeCompare`로 "최신 accepted/revised 승" → **Phase A와 동일 tiebreak 상속**(미해소·미문서화). | 참조 기반 인과성, id=display/tiebreak 전용. **decisions.md에 contract 기록=해소**. |
| Spec | `draft|accepted|archived`, `proposeSpec(title,summary)` actor:author, **summary가 이벤트 body에**. Spec↔Plan 링크 없음. | `proposed|accepted|archived`, `proposeSpec(slug,title)`가 **`workspace/specs/sources/<slug>.md` 사람 저술 prose 존재 검증**. |

## 3. v3 Invariants 기준 평가

**INV #1 (Decision 권위 침투 금지)** — **양쪽 동등·구조적 준수.**
- v2: `proposePlan` actor:"planner"이고 Planner 모듈에 acceptance 경로 0(자기 plan 채택 불가, guards 주석에 명시). `acceptPlan`=별도·actor:"user" 하드핀. decision_* write 0.
- B1: negative test로 spec/plan 커맨드 decision_* write 0 실증. accept=actor:"user". lifecycle≠verdict.

**Append-only SSOT** — **B1이 lineage 추적에서 우위; v2에 실질 갭.**
- 양쪽 다 이벤트 append-only·status 파생.
- v2: plan 내용=propose 1회성. 내용 변경=supersede+재propose인데 **교체 링크 미기록** → "plan A를 plan B가 대체"를 이벤트에서 **재구성 불가**(append-only SSOT의 추적성 갭).
- B1: 각 revision=불변 아티팩트+`supersedes` 참조 → 계보 일급·완전 재구성.

**Plan = 분해이지 권위 아님** — **양쪽 동등.** 둘 다 verdict minting 0, 권위는 승인된 decision에서만.

## 4. B1-only 개선점 & v2 포팅 가치

| # | 개선점 | 포팅 가치 | 근거·방법 |
|---|---|---|---|
| (a) | **supersede에 교체 참조 기록** | **높음 (additive·invariant 강화)** | v2 `plan_superseded`가 교체 plan 포인터 미기록=append-only 추적성 갭. v2 `supersedePlan`에 `supersedes`/대체 plan `related_to` 추가(상태머신 모델 안 깨고 작은 추가). |
| (b) | **MINOR #2 ordering contract** (id=display 전용, 인과성=참조) | **중간 (대부분 문서화로 충분)** | v2가 localeCompare tiebreak 상속. 가장 싼 해소=v2에도 동일 contract 문서화(same-second 이중전이=사람페이스라 양성). (a) 포팅 시 supersede 경로는 자동으로 참조 기반화. 전면 재작성 불요. |
| (c) | Plan↔Spec 연결(`related_to:[specId]`) | **중간 (설계 정합)** | v3 실행평면은 Spec→Plan→Task 체인. v2 plan은 standalone. Planner가 spec id를 받게 확장 가능. 설계 토론감. |
| (d) | prose-file Spec(`specs/sources/`) 존재검증 | **낮음·선택** | v3 §3 "Spec 본문=사람 저술, event-source 안 함"에 B1이 더 문자 그대로 정합. v2는 summary를 이벤트에(경미한 텐션, but summary=요약이라 수용가능). 더 무겁고(파일 선저술) 비긴급. |
| (e) | `multipleHeads`/`danglingSupersedes` 진단 | **없음 (포팅 부적합)** | B1 lineage-head 모델의 산물. v2엔 "spec별 head" 개념 없음 → 대응 안 됨. 그대로 포팅 금지. |

## 5. 추천안 (사용자/Hermes 결정용)

1. **`feat/boule-v2-planner`를 canonical로** 채택 권장. 근거: 더 완성됨(Planner+Conductor 보유), needs_revision 리뷰루프가 HITL plan-loop(Phase C/E의 기반)에 더 맞음, critic ACCEPT. B1으로 rebase하면 B2(Planner)+C(Conductor)를 재구축해야 하는데, 그 대가로 얻는 lineage 모델은 v2가 supersede+재propose로 다르게 처리하는 영역이라 수지 안 맞음.
2. **B1에서 v2로 포팅할 작은 additive 2건**(둘 다 invariant 강화): (a) supersede 교체 참조 기록(추적성 갭 해소), (b) MINOR #2 ordering contract를 v2에도 문서화.
3. **저우선·설계 토론감**: (c) Plan↔Spec 연결, (d) prose-file Spec.
4. **포팅 금지**: (e) lineage 진단.
5. **B1 브랜치**: 현 상태 유지(미푸시·`feat/governance-boule-p1`에 recoverable). 위 (a)(b) 포팅 소스로만 의미. **삭제/머지 결정은 사용자/Hermes.**

## 6. 한 줄 요약

v2-planner와 B1은 Plan을 **상태머신 vs 불변 버전 lineage**로 다르게 모델링했다. 둘 다 INV #1·Plan-비권위는 동등 준수. B1은 **교체 계보 추적성**과 **MINOR #2 해소·Spec↔Plan 연결**에서 우위지만, v2가 **Planner+Conductor까지 완성**돼 있어 canonical로는 v2가 합리적이고, B1의 핵심 개선 2건(supersede 참조·ordering contract)만 v2로 포팅하는 것을 권장.
