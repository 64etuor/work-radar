# 명령 인덱스 (Commands Reference)

> 이 파일은 `CLAUDE.md`와 `AGENTS.md`가 가리키는 **정본 명령 인덱스**다.
> 모든 빌드·검증 명령은 여기서만 관리한다. 실제 `package.json` scripts 및
> `src-tauri/Cargo.toml` 구성과 정확히 일치한다.

---

## Frontend

패키지 매니저: **pnpm**. 루트에서 실행.

| 명령             | 설명                                                                                                                                                                         |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm install`   | 의존성 설치 (`pnpm-lock.yaml` 기준 재현)                                                                                                                                     |
| `pnpm dev`       | Vite 개발 서버 시작 (HMR 활성)                                                                                                                                               |
| `pnpm build`     | TypeScript 컴파일(`tsc`) 후 Vite 번들 빌드                                                                                                                                   |
| `pnpm typecheck` | `tsc --noEmit` — 타입 오류만 검사, 출력 파일 없음                                                                                                                            |
| `pnpm lint`      | `eslint .` — flat config(`@eslint/js` + `typescript-eslint` + `react-hooks` v7 + `react-refresh`). 게이트 = 에러만 차단(react-hooks v7 경고는 의도적 비차단, decisions 참조) |
| `pnpm preview`   | 빌드 결과물을 로컬 서버로 미리보기                                                                                                                                           |

---

## Tauri

Tauri CLI는 `pnpm tauri` 래퍼로 실행한다 (`package.json` `"tauri": "tauri"` 스크립트).

| 명령               | 설명                                                         |
| ------------------ | ------------------------------------------------------------ |
| `pnpm tauri dev`   | Tauri 개발 모드 실행 — 앱 부팅 및 통합 동작 확인의 기준 명령 |
| `pnpm tauri build` | 릴리스용 네이티브 바이너리 빌드 (코드 서명 포함)             |

---

## Rust

**Cargo manifest 위치: `src-tauri/Cargo.toml`**

루트에서 실행 시 반드시 `--manifest-path src-tauri/Cargo.toml`를 붙이거나,
`src-tauri/` 디렉터리 안에서 실행해야 한다.

| 명령                                                              | 설명                                                 |
| ----------------------------------------------------------------- | ---------------------------------------------------- |
| `cargo build --manifest-path src-tauri/Cargo.toml`                | Rust 크레이트 컴파일                                 |
| `cargo test --manifest-path src-tauri/Cargo.toml`                 | 모든 단위·통합 테스트 실행                           |
| `cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets` | 린트 경고 검사 (`-- -D warnings`로 CI에서 오류 처리) |
| `cargo fmt --manifest-path src-tauri/Cargo.toml --check`          | 포맷 검사 (변경 없이 확인만)                         |
| `cargo fmt --manifest-path src-tauri/Cargo.toml`                  | 포맷 자동 수정 (커밋 전 로컬 정리용)                 |

---

## Phase 검증 번들

`AGENTS.md` 검증 절의 각 규칙을 구체적인 명령으로 대응시킨다.
각 Phase done-criteria를 **실제 실행 증거**로 채울 때 이 번들을 사용한다.

### Rust 검증

```bash
cargo test --manifest-path src-tauri/Cargo.toml
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
```

- `cargo test`: 로직 회귀 방지. 실패 시 Phase 완료 불가.
- `cargo clippy --all-targets -- -D warnings`: 경고를 오류로 처리. CI와 동일 기준.

### 프런트엔드 검증

```bash
pnpm typecheck
pnpm lint
```

- `pnpm typecheck` (`tsc --noEmit`): 타입 안전성 확인.
- `pnpm lint` (`eslint .`): 린트. 게이트는 **에러만 차단** — react-hooks v7 경고는 의도적 비차단(점진 정리는 백로그, decisions 참조).

### Tauri 통합 검증

```bash
pnpm tauri dev
```

- `pnpm tauri dev` 부팅 확인: 앱이 크래시 없이 기동되면 통합 검증 통과.
- Tauri 통합은 이 명령으로만 확인한다 (headless 검증 수단 없음).

### 전체 검증 순서 (Phase 종료 전 권장)

```bash
# 1. Rust
cargo fmt --manifest-path src-tauri/Cargo.toml --check
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
cargo test --manifest-path src-tauri/Cargo.toml

# 2. 프런트엔드
pnpm typecheck
pnpm build

# 3. Tauri 통합
pnpm tauri dev
```

> INVARIANTS 7개 위반 여부는 별도 reviewer 패스로 확인한다 (self-approve 금지).
> 위 명령이 모두 통과해도 reviewer 패스 전에는 done이 아니다.

---

## 관련 문서

- [error-handling.md](./error-handling.md) — 에러 처리·로깅 지침(AppError, tracing 레벨, Do/Don't).
