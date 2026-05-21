# PR 체크리스트

## 문제 및 예상 임팩트

> 이 PR이 해결하는 문제와 머지 후 예상되는 영향을 간략히 기술하세요.

-

## 변경 내용

> 무엇을 어떻게 바꿨는지 요약하세요.

-

## 아키텍처 적합성

> `docs/architecture.md` 및 `docs/decisions.md`와 충돌하는 부분이 없는지 확인하세요.

-

## INVARIANTS 위반 없음

> AGENTS.md §1 / PLAN.md §1의 7대 불변식을 모두 지켰는지 체크하세요.

- [ ] INVARIANT 1: 결정 레일은 사람만 — 자동 분류/승격 없음
- [ ] INVARIANT 2: 모든 외부 변경은 Acceptance 게이트를 통과함
- [ ] INVARIANT 3: 신호는 dedup upsert + auto-resolve 방식 유지
- [ ] INVARIANT 4: 매트릭스는 결정 큐(거울 아님), ambient는 임계치 escalate
- [ ] INVARIANT 5: 에이전트 잡에 timeout/turns/cost cap/kill + 재트리거 캡 적용
- [ ] INVARIANT 6: 코드 작업은 worktree 격리; 샌드박스 기본 read-only, 쓰기는 명시 승인 시만, danger-full 금지
- [ ] INVARIANT 7: SSOT 분리 — Notion=내용, SQLite=상태

## 실행한 검증 명령

> 아래 명령 중 해당하는 것의 출력 결과를 붙여넣으세요.

```
# Rust
cargo fmt --check --manifest-path src-tauri/Cargo.toml
cargo clippy --all-targets --manifest-path src-tauri/Cargo.toml -- -D warnings
cargo test --manifest-path src-tauri/Cargo.toml

# Frontend
pnpm typecheck
pnpm build
```

## 리스크 / 롤백 / 마이그레이션

> 잠재적 리스크, 롤백 방법, 필요한 마이그레이션 작업을 기술하세요.

-

## 의도적으로 미룬 follow-up

> 이번 PR 범위에서 제외한 작업이 있다면 이슈 번호나 이유와 함께 기록하세요.

-
