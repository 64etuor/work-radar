---
name: sqlx-sqlite
description: Use when touching work-radar's SQLite layer (schema, queries, migrations, FTS5, dedup) — sqlx 0.8 pool setup, migrations-only schema changes (no ad-hoc ALTER), runtime-checked query_as patterns, FTS5 external-content sync triggers, dedup upsert, and the local-DB-as-SSOT invariant.
---

# SQLite 데이터 레이어 (sqlx 0.8)

이 SQLite DB가 매트릭스 상태·신호·승격 이력·에이전트 잡의 **SSOT**. Notion=내용 SSOT(여긴 미러/링크). 스키마 변경은 새 마이그레이션 파일로만.

## 의존성 / 풀 (src-tauri/src/db.rs)
- `sqlx = { version = "0.8", features = ["runtime-tokio", "sqlite", "migrate"] }`
- `pub type Db = SqlitePool;` (Tauri managed state로 공유)
- 초기화 패턴:
```rust
let opts = SqliteConnectOptions::new()
    .filename(db_path).create_if_missing(true).foreign_keys(true);
let pool = SqlitePoolOptions::new().max_connections(5).connect_with(opts).await?;
sqlx::migrate!("./migrations").run(&pool).await?;   // 컴파일 타임 임베드
```
- DB 위치: OS app-data 경로의 `work-radar.db`.

## 스키마 변경 = 새 마이그레이션만 (INVARIANT)
- `migrations/NNNN_name.sql` 새 번호 파일 추가 (예: `0002_add_X.sql`). **임의 ALTER 금지**, **이미 적용된 마이그레이션 편집 금지**.
- `PRAGMA foreign_keys = ON`, TEXT 타임스탬프 `DEFAULT (datetime('now'))`, JSON은 TEXT 컬럼(`links`/`snapshot`/`*_payload`).

## 쿼리 패턴
- 현재는 **런타임 체크** `sqlx::query_as::<_, T>(...)` 사용 (T는 `sqlx::FromRow`). 컴파일타임 매크로 아님 → `.sqlx` offline 캐시 불필요.
- ⚠️ 만약 `query!`/`query_as!` **매크로**로 전환하면, CI 오프라인 빌드를 위해 `cargo sqlx prepare`로 `.sqlx/`를 생성·커밋해야 한다(또는 DATABASE_URL 제공). 전환 전 이 트레이드오프 확인.

## dedup upsert (INVARIANT: append 아님)
- system/PR/Hermes 신호는 `signals.dedup_key`(부분 UNIQUE 인덱스)로 upsert:
  `INSERT INTO signals(...) VALUES(...) ON CONFLICT(dedup_key) DO UPDATE SET ...`
- 원인 해소 시 auto-resolve(예: CI 통과 → status 변경/신호 소멸). 중복 생성 0.

## FTS5 전역 검색
- external-content 가상 테이블: `signals_fts USING fts5(title, body, content='signals', content_rowid='rowid')`.
- AFTER INSERT/DELETE/UPDATE **트리거 3종**이 동기화(`'delete'` 명령으로 외부콘텐츠 삭제). 새 신호 컬럼이 FTS 대상이면 트리거도 같이 갱신.
- 검색: `SELECT ... FROM signals_fts WHERE signals_fts MATCH 'query'`. (libsqlite3-sys bundled = FTS5 포함.)

## 검증
- `cargo test` — `migrations_create_six_tables_and_fts`(6테이블 + FTS MATCH), `list_projects_returns_empty_on_fresh_db`.
- 명령: `docs/reference/commands.md`.
