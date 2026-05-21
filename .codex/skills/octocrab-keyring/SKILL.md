---
name: octocrab-keyring
description: Use when work-radar calls GitHub/Notion or stores/reads credentials — keep all network + tokens in Rust (never the renderer), store secrets in the OS keychain via keyring (projects.credential_ref), and use bounded retry with backoff+jitter and surfaced terminal failure. Phase 2 (keychain) / 3 (Notion) / 4 (PR Radar).
---

# 외부 호출 + 시크릿 (octocrab / reqwest / keyring)

INVARIANT: **Notion/GitHub 호출은 Rust에**, **토큰은 OS keychain에만**. 렌더러·평문 SQLite에 토큰 노출 금지.

## 토큰 저장 (keyring 3.x)
- `keyring = { version = "3", features = ["apple-native"] }` (keyring 4.x는 feature 비어 재패키징됨 — 3.x 고정).
- API: `Entry::new(service, account)?.set_password / get_password / delete_credential`.
- `projects.credential_ref`(SQLite)에는 **keychain 키만** 저장하고 토큰 본문은 저장하지 않는다. project별 분리.
- keychain 모듈은 Phase 0에서 `#[allow(dead_code)]` 계약만 — 호출부는 Phase 2(Add Project)에서 연결.

## GitHub (octocrab) — Phase 4
- ⚠️ 현재 `octocrab`/`reqwest`는 Cargo.toml에 **아직 없음**. PR Radar 구현 시 추가.
- project별 클라이언트를 keychain 토큰으로 생성. open/my PR across repos. **페이지네이션** 처리.
- 도출 신호(CI/conflict/draft/age/linked-backlog)는 `ticket_key_pattern` 조인 + `dedup_key`로 upsert([[sqlx-sqlite]]).

## Notion (reqwest REST) — Phase 3
- rate-limit 인지(약 3 req/s). write-through + `promotions` append-only 로그.

## bounded retry only (INVARIANT)
- **무한 retry/poll 금지.** 모든 재시도는: 시도 횟수 캡 + 지수 backoff + **jitter**(네트워크) + terminal failure 노출.
- GitHub rate limit(~5000/h + secondary)·`Retry-After`·`X-RateLimit-Reset` 존중. 초과 시 backoff 후 실패를 사람에게 노출(삼키지 않음).
- 에러는 command 경계에서 `Result<_, String>`로 프런트에 노출([[tauri-specta-ipc]]).

## 검증
- 토큰이 keychain에 저장됨(평문 DB 아님), 재부팅 후 유지.
- 각 project 토큰으로 테스트 API ping 성공/실패 표시.
- rate limit 초과 시 무한 retry 없이 backoff 후 실패.
