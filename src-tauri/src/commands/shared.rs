//! 도메인 간 공유 상수/헬퍼. 단일 도메인 전용은 해당 서브모듈에 둔다.
//! (SIGNAL_COLS는 백로그 F에서 `signal_store`로 이전.)

#[cfg(test)]
pub(crate) mod test_support {
    use crate::db::{init_db, Db};
    use crate::models::{CreateProjectInput, CreateSignalInput, Kind, ProjectKind};
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::{SystemTime, UNIX_EPOCH};

    pub(crate) async fn fresh_db() -> Db {
        static SEQ: AtomicU64 = AtomicU64::new(0);
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let seq = SEQ.fetch_add(1, Ordering::Relaxed);
        let path = std::env::temp_dir().join(format!("wr-cmd-test-{nanos}-{seq}.db"));
        // 느린 CI 러너(예: windows-latest)에서 병렬 테스트가 몰리면 초기 풀 획득이
        // acquire_timeout(5s, 프로덕션 fail-fast 계약)을 넘겨 PoolTimedOut 플레이크가 난다.
        // 그 스파이크만 bounded retry(3회, 백오프)로 흡수 — 다른 에러는 즉시 실패.
        let mut delay_ms = 500u64;
        for _ in 0..2 {
            match init_db(&path).await {
                Ok(db) => return db,
                Err(sqlx::Error::PoolTimedOut) => {
                    tokio::time::sleep(std::time::Duration::from_millis(delay_ms)).await;
                    delay_ms *= 2;
                }
                Err(e) => panic!("init_db: {e:?}"),
            }
        }
        init_db(&path).await.expect("init_db")
    }

    pub(crate) fn input(title: &str, kind: Option<Kind>) -> CreateSignalInput {
        CreateSignalInput {
            title: title.to_string(),
            kind,
            project_id: None,
        }
    }

    pub(crate) fn project_input(name: &str, kind: ProjectKind) -> CreateProjectInput {
        CreateProjectInput {
            name: name.to_string(),
            kind,
            notion_backlog_db_id: None,
            notion_agenda_db_id: None,
        }
    }
}
