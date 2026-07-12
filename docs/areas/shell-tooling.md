# Shell Tooling — Agent shell gotchas

이 환경은 agent Bash가 rtk(Rust Token Killer) hook으로 감싸여 있고, `.cargo/bin`이
기본 PATH에 없다. 이 두 사실이 빌드/검증 명령을 종종 망친다.

## 1. rtk hook이 파이프/대용량 스트림을 truncate

관측된 사고:

- `curl ... | sh` (rustup install): rtk가 `(N more lines...)` 마커를 스크립트 stream에
  주입 → `sh: syntax error near unexpected token`.
- `tail` / `cat` 로그 파일: `read: -N: invalid option` 에러.
- `curl ... | python3` JSON: truncated → parse 실패.

**가드:** 네트워크/큰 출력을 인터프리터·페이저에 직접 파이프 금지.

- `curl -o file ...` → 파일 실행 / `python3 -c "open('file')..."`.
- 로그는 **Read 도구** (또는 `grep`/`python3`)로 — `tail`/`cat` 금지.

## 2. rtk cargo summary는 신뢰 불가

`cargo ...`는 rtk가 `rtk cargo ...`로 rewrite한다. clippy/test 출력을 짧은 요약 줄로
바꾸고 거짓 non-zero exit를 보고할 수 있다.

관측: `cargo clippy --all-targets -- -D warnings`에서 rtk가 `--`/`-D warnings` 분리자를
mangle해 `-D`를 filename으로 build.rs에 넘김 → false 빌드 실패. summary는 "1 errors"
거짓말, 실 exit는 0.

**가드:** 신뢰 필요한 cargo 출력/exit는 **`rtk proxy cargo ...`**로 rewrite 우회 +
파일 redirect + Read.

```bash
rtk proxy cargo clippy --all-targets -- -D warnings > /tmp/clippy.log 2>&1
echo "EXIT=$?"
# then: Read /tmp/clippy.log
```

`Finished` / `test result: ok` 줄을 raw 로그에서 직접 확인. rtk 백그라운드 exit 보고도
신뢰 불가.

## 3. `cargo`는 agent 기본 PATH에 없음

`cargo`는 `$HOME/.cargo/bin/cargo`에 있지만 Bash tool의 non-interactive shell PATH에
없다(`which cargo` not found).

**.husky/pre-commit이 `cargo fmt --check`를 실행** — husky subshell도 cargo 없으므로
일반 `git commit`이 code 127로 abort.

**가드:** cargo 명령과 git commit 앞에 export:

```bash
export PATH="$HOME/.cargo/bin:$PATH" && cargo ...
export PATH="$HOME/.cargo/bin:$PATH" && git commit -m "..."
```

`--no-verify`로 우회 금지 (검증 스킵). `cargo`는 `src-tauri/`에서 실행하거나
`--manifest-path src-tauri/Cargo.toml`.

## 4. fmt timing — `cargo fmt` BEFORE `git add`

Executor agent가 만든 Rust는 **clippy/test pass + rustfmt 미적용** 인 경우가 많다
(clippy ≠ fmt). 훅은 `fmt --check`(reject, 자동수정 아님).

worst case: 훅은 **on-disk** 파일을 보고, `git commit`은 **staged** 버전을 기록한다 →
`git add` 후 `cargo fmt` 실행하면 훅은 pass(디스크 clean)지만 커밋이 stale unformatted
코드를 캡처한다.

**가드:** executor 출력에 **항상 `git add` 전에 `cargo fmt` 실행**. 커밋 grouping이
이미 망가졌고 푸시 전이면 `git reset --mixed <base>` + (포맷된) 디스크에서 재스테이징.

## 5. find with `-not`/`-exec`

rtk find wrapper는 compound predicates(`-not`, `-exec`)를 지원하지 않는다 → fallback으로
`/usr/bin/find` 절대경로 사용:

```bash
/usr/bin/find /Users/davidpark/private_project/work-radar/src -type f -name "*.tsx"
```

## 6. Bash `read: -N: invalid option`

zsh의 `tail`/`head` 일부 invocation이 `read -N`(bash-only)을 요청하는 함수에 hit하면
실패. 위 1번 가드(Read 도구 사용) 적용.

## 7. ESLint 게이트는 errors-only (의도적)

`pnpm lint`는 react-hooks v7 추가 룰을 **warn으로 강등**(35건). CI는 에러만 차단. 일괄
리팩터로 35건을 한 PR에 정리하지 말 것 — `AGENTS.md` 금지(광범위 refactor 섞기).
점진 정리는 백로그 follow-up.

벤더 디렉터리(`.claude`/`.codex`/`.omc`)·`src/bindings.ts`·`src-tauri`는 lint ignore.

## 8. macOS dev 키체인 프롬프트 — 앱 실행은 반드시 서명 경로로

macOS 키체인 ACL은 앱의 **코드서명 신원**(designated requirement)에 묶인다. ad-hoc
서명(맨 `cargo build` 산출물)은 빌드마다 신원이 바뀌어 "항상 허용"이 무효화되고
리빌드/재실행마다 암호 프롬프트가 재발한다.

**장치(전부 자동):**

- `pnpm tauri dev` → `scripts/tauri-wrapper.sh`가 실행 직전 codesign 러너를 주입.
- `src-tauri/.cargo/config.toml`의 cargo runner(`scripts/exec-signed.sh`)가 **wrapper를
  우회하는 실행**(`cargo run`, IDE 실행, 맨 `tauri dev`)까지 실행 직전 서명. cargo test
  바이너리는 서명 없이 pass-through(keychain 비의존).
- 서명 정본 = `scripts/dev-codesign-lib.sh`(고정 identity "Work Radar Dev" + identifier).
  DR 안정성 회귀 가드 = `pnpm test:codesign`.

**가드:**

- 최초 1회 `pnpm tauri:dev:setup`(전용 keychain + self-signed identity, 멱등).
- 키체인 다이얼로그에서는 **"항상 허용"**(항목당 1회) — "허용"은 매번 다시 묻는다.
- 외부에서 바이너리를 직접 exec하는 소비자(예: Hermes의 `work-radar --mcp-stdio`)는
  `scripts/exec-signed.sh <binary> [args...]`로 감싸야 같은 보장을 받는다.
- escape hatch: `WORK_RADAR_UNSIGNED_DEV=1`(서명 생략 — 프롬프트 재발 감수).

## 정본 / 참조

- `docs/reference/commands.md` — 명령 정본
- `~/.claude/projects/-Users-davidpark-private-project-work-radar/memory/`
  - `rtk-hook-truncates-pipes.md`
  - `rtk-cargo-summary-unreliable.md`
  - `work-radar-no-cargo-in-agent-shell.md`
  - `work-radar-eslint-adoption.md`
