//! 앱 에러 로그 — 로테이팅 파일 로그 (errors.log, 최대 5개 아카이브 × ~1 MiB).
//!
//! 규칙:
//!  - 로깅 자체가 실패해도 UI 흐름으로 절대 panic/throw 하지 않는다 (Result::ok() 처리).
//!  - 로테이션: 추가 전 파일이 1 MiB 초과면 최오래된 아카이브부터 drop 후 rotate.

use std::fs::{self, OpenOptions};
use std::io::Write as _;
use std::path::{Path, PathBuf};

use chrono::Utc;

/// 로그 디렉터리 경로를 갖는 앱-관리 로거.
pub struct AppLogger {
    dir: PathBuf,
}

impl AppLogger {
    pub fn new(dir: PathBuf) -> Self {
        Self { dir }
    }

    /// `errors.log` 경로를 반환한다.
    pub fn log_path(&self) -> PathBuf {
        self.dir.join("errors.log")
    }

    /// 에러 한 줄을 `errors.log`에 추가한다.
    ///
    /// 추가 전 파일 크기가 1 MiB를 초과하면 rotate 후 추가.
    /// 실패는 silently 무시한다 (UI 흐름에 영향 없음).
    pub fn log_error(&self, scope: &str, message: &str, trace_id: &str) {
        if let Err(_e) = self.do_log_error(scope, message, trace_id) {
            // 로깅 실패는 조용히 — UI에 전파하지 않는다.
        }
    }

    fn do_log_error(&self, scope: &str, message: &str, trace_id: &str) -> std::io::Result<()> {
        // 로그 디렉터리가 없으면 생성.
        fs::create_dir_all(&self.dir)?;

        let log_path = self.log_path();

        // 크기가 1 MiB 초과면 rotate.
        if should_rotate(&log_path, ROTATE_THRESHOLD_BYTES) {
            rotate_logs(&self.dir, MAX_ARCHIVES);
        }

        let now = Utc::now().to_rfc3339();
        let line = format!("{now} [{trace_id}] {scope}: {message}\n");

        let mut file = OpenOptions::new().create(true).append(true).open(&log_path)?;
        file.write_all(line.as_bytes())?;
        Ok(())
    }
}

/// 로테이션 임계치 (1 MiB).
const ROTATE_THRESHOLD_BYTES: u64 = 1024 * 1024;

/// 최대 아카이브 개수.
const MAX_ARCHIVES: usize = 5;

/// 파일이 `cap`을 초과하면 true. 파일이 없으면 false.
pub fn should_rotate(path: &Path, cap: u64) -> bool {
    match fs::metadata(path) {
        Ok(meta) => meta.len() > cap,
        Err(_) => false,
    }
}

/// 최대 `max_archives`개를 유지하는 rename 계획을 반환한다.
///
/// 반환: `(from, to)` 쌍의 벡터, 이 순서대로 rename 하면 된다.
/// - errors.4.log → errors.5.log (먼저 drop: errors.{max_archives}.log 삭제)
/// - errors.3.log → errors.4.log
/// - ...
/// - errors.log   → errors.1.log
pub fn rotation_renames(max_archives: usize) -> Vec<(String, String)> {
    let mut plan = Vec::new();
    // 가장 오래된 아카이브부터 한 칸씩 뒤로 민다.
    // i = max_archives-1 → 1 (즉 errors.{max_archives-1}.log → errors.{max_archives}.log)
    for i in (1..max_archives).rev() {
        plan.push((format!("errors.{i}.log"), format!("errors.{}.log", i + 1)));
    }
    // 현재 로그를 .1 로.
    plan.push(("errors.log".to_string(), "errors.1.log".to_string()));
    plan
}

/// 실제 파일 rotate 수행. 없는 파일 rename은 무시.
fn rotate_logs(dir: &Path, max_archives: usize) {
    // 최오래된 아카이브 삭제.
    let oldest = dir.join(format!("errors.{max_archives}.log"));
    let _ = fs::remove_file(&oldest);

    for (from, to) in rotation_renames(max_archives) {
        let src = dir.join(&from);
        let dst = dir.join(&to);
        if src.exists() {
            let _ = fs::rename(&src, &dst);
        }
    }
}

// ── Tauri 커맨드 ──────────────────────────────────────────────────────────────

use tauri::State;

/// 에러를 로그에 기록한다. 로깅 자체 실패는 Ok(())로 삼킨다 (UI 흐름 보호).
#[tauri::command]
#[specta::specta]
pub fn log_app_error(
    logger: State<AppLogger>,
    scope: String,
    message: String,
    trace_id: String,
) -> Result<(), String> {
    logger.log_error(&scope, &message, &trace_id);
    Ok(())
}

/// errors.log 파일 경로를 반환한다 (설정 화면 표시용).
#[tauri::command]
#[specta::specta]
pub fn app_log_path(logger: State<AppLogger>) -> Result<String, String> {
    Ok(logger.log_path().to_string_lossy().into_owned())
}

// ── 단위 테스트 ───────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::TempDir;

    #[test]
    fn rotation_renames_plan_is_correct() {
        let plan = rotation_renames(5);
        // 순서: 4→5, 3→4, 2→3, 1→2, errors.log→1
        assert_eq!(plan[0], ("errors.4.log".to_string(), "errors.5.log".to_string()));
        assert_eq!(plan[1], ("errors.3.log".to_string(), "errors.4.log".to_string()));
        assert_eq!(plan[2], ("errors.2.log".to_string(), "errors.3.log".to_string()));
        assert_eq!(plan[3], ("errors.1.log".to_string(), "errors.2.log".to_string()));
        assert_eq!(plan[4], ("errors.log".to_string(), "errors.1.log".to_string()));
        assert_eq!(plan.len(), 5);
    }

    #[test]
    fn should_rotate_returns_false_when_file_missing() {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("nonexistent.log");
        assert!(!should_rotate(&path, 1024));
    }

    #[test]
    fn should_rotate_returns_false_below_threshold() {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("errors.log");
        fs::write(&path, b"small").unwrap();
        assert!(!should_rotate(&path, 1024 * 1024));
    }

    #[test]
    fn should_rotate_returns_true_above_threshold() {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("errors.log");
        // 임계치보다 1바이트 많은 데이터 기록.
        let data = vec![b'x'; 1024 * 1024 + 1];
        fs::write(&path, &data).unwrap();
        assert!(should_rotate(&path, ROTATE_THRESHOLD_BYTES));
    }

    #[test]
    fn log_error_appends_line() {
        let tmp = TempDir::new().unwrap();
        let logger = AppLogger::new(tmp.path().to_path_buf());
        logger.log_error("test_scope", "something went wrong", "abcd1234");
        let content = fs::read_to_string(logger.log_path()).unwrap();
        assert!(content.contains("[abcd1234] test_scope: something went wrong"));
    }

    #[test]
    fn log_error_rotates_when_over_threshold() {
        let tmp = TempDir::new().unwrap();
        let dir = tmp.path().to_path_buf();

        // 1 MiB + 1 byte のファイルを作成して threshold を超えさせる.
        let log_path = dir.join("errors.log");
        let big = vec![b'x'; ROTATE_THRESHOLD_BYTES as usize + 1];
        fs::write(&log_path, &big).unwrap();

        let logger = AppLogger::new(dir.clone());
        logger.log_error("scope", "msg", "tid00001");

        // 元ファイル(errors.log)は新しい小さいログになっている.
        let new_content = fs::read_to_string(dir.join("errors.log")).unwrap();
        assert!(new_content.contains("[tid00001] scope: msg"));

        // 古いファイルが errors.1.log に移動されている.
        assert!(dir.join("errors.1.log").exists());
        let old_content = fs::read_to_string(dir.join("errors.1.log")).unwrap();
        assert_eq!(old_content.len(), ROTATE_THRESHOLD_BYTES as usize + 1);
    }
}
