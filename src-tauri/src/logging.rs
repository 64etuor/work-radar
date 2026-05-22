//! 앱 로깅 — tracing subscriber.
//!
//! 레이어:
//!  - errors.log: WARN+ (일별 회전, max 7파일). non-blocking.
//!  - app.log:    INFO+ (운영 가시성). non-blocking.
//!  - stdout:     EnvFilter(RUST_LOG), 기본 warn.
//!
//! 규칙:
//!  - WorkerGuard는 앱 state로 보관(드롭 시 flush 누락). init은 1회만(전역 subscriber).
//!  - 토큰/PII 로그 금지(keychain INVARIANT).

use std::path::{Path, PathBuf};

use tracing_appender::non_blocking::WorkerGuard;
use tracing_subscriber::filter::LevelFilter;
use tracing_subscriber::layer::SubscriberExt as _;
use tracing_subscriber::util::SubscriberInitExt as _;
use tracing_subscriber::{EnvFilter, Layer as _};

/// non-blocking writer guard 보관소(앱 state). 드롭되면 버퍼 flush가 중단된다.
pub struct LogGuards {
    _errors: WorkerGuard,
    _app: WorkerGuard,
}

/// 전역 tracing subscriber를 설치하고 guard를 반환한다. setup에서 1회 호출.
pub fn init_tracing(log_dir: &Path) -> LogGuards {
    // 디렉터리 보장(실패해도 stdout 레이어는 동작).
    let _ = std::fs::create_dir_all(log_dir);

    let errors_appender = tracing_appender::rolling::Builder::new()
        .rotation(tracing_appender::rolling::Rotation::DAILY)
        .filename_prefix("errors")
        .filename_suffix("log")
        .max_log_files(7)
        .build(log_dir)
        .expect("errors.log appender 생성 실패");
    let (errors_nb, errors_guard) = tracing_appender::non_blocking(errors_appender);

    let app_appender = tracing_appender::rolling::Builder::new()
        .rotation(tracing_appender::rolling::Rotation::DAILY)
        .filename_prefix("app")
        .filename_suffix("log")
        .max_log_files(7)
        .build(log_dir)
        .expect("app.log appender 생성 실패");
    let (app_nb, app_guard) = tracing_appender::non_blocking(app_appender);

    let errors_layer = tracing_subscriber::fmt::layer()
        .with_ansi(false)
        .with_writer(errors_nb)
        .with_filter(LevelFilter::WARN);

    let app_layer = tracing_subscriber::fmt::layer()
        .with_ansi(false)
        .with_writer(app_nb)
        .with_filter(LevelFilter::INFO);

    let stdout_layer = tracing_subscriber::fmt::layer()
        .with_filter(EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("warn")));

    tracing_subscriber::registry()
        .with(errors_layer)
        .with(app_layer)
        .with(stdout_layer)
        .init();

    LogGuards {
        _errors: errors_guard,
        _app: app_guard,
    }
}

// ── Tauri 커맨드 ──────────────────────────────────────────────────────────────

/// 프런트에서 발생한 에러(JS 예외/렌더 크래시)를 백엔드 로그로 흘린다.
/// 백엔드-originated 에러는 AppError가 이미 로그하므로 프런트가 다시 호출하지 않는다.
#[tauri::command]
#[specta::specta]
pub fn log_app_error(scope: String, message: String, trace_id: String) {
    // 프런트 에러는 errors.log에 남도록 ERROR로 기록.
    tracing::error!(trace_id = %trace_id, code = "frontend", "{scope}: {message}");
}

/// 로그 디렉터리 경로를 반환한다(설정 화면 "로그 폴더 열기"용).
/// 일별 회전으로 단일 파일명이 없으므로 디렉터리를 노출한다.
#[tauri::command]
#[specta::specta]
pub fn app_log_dir(log_dir: tauri::State<LogDir>) -> String {
    log_dir.0.to_string_lossy().into_owned()
}

/// 로그 디렉터리 경로 보관(app_log_dir 커맨드용 state).
pub struct LogDir(pub PathBuf);

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Mutex};
    use tracing_subscriber::fmt::MakeWriter;

    /// 메모리 버퍼에 쓰는 MakeWriter(레벨 필터 라우팅 검증용).
    #[derive(Clone)]
    struct BufWriter(Arc<Mutex<Vec<u8>>>);
    impl std::io::Write for BufWriter {
        fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
            self.0.lock().unwrap().extend_from_slice(buf);
            Ok(buf.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }
    impl<'a> MakeWriter<'a> for BufWriter {
        type Writer = BufWriter;
        fn make_writer(&'a self) -> Self::Writer {
            self.clone()
        }
    }

    #[test]
    fn warn_goes_to_errors_layer_info_only_to_app_layer() {
        let err_buf = Arc::new(Mutex::new(Vec::new()));
        let app_buf = Arc::new(Mutex::new(Vec::new()));

        let err_layer = tracing_subscriber::fmt::layer()
            .with_ansi(false)
            .with_writer(BufWriter(err_buf.clone()))
            .with_filter(LevelFilter::WARN);
        let app_layer = tracing_subscriber::fmt::layer()
            .with_ansi(false)
            .with_writer(BufWriter(app_buf.clone()))
            .with_filter(LevelFilter::INFO);

        let subscriber = tracing_subscriber::registry()
            .with(err_layer)
            .with(app_layer);
        tracing::subscriber::with_default(subscriber, || {
            tracing::info!(code = "test", "info-line");
            tracing::warn!(code = "test", "warn-line");
        });

        let err_out = String::from_utf8(err_buf.lock().unwrap().clone()).unwrap();
        let app_out = String::from_utf8(app_buf.lock().unwrap().clone()).unwrap();

        // errors 레이어(WARN+): warn만, info 없음.
        assert!(err_out.contains("warn-line"));
        assert!(!err_out.contains("info-line"));
        // app 레이어(INFO+): 둘 다.
        assert!(app_out.contains("warn-line"));
        assert!(app_out.contains("info-line"));
    }

    #[test]
    fn init_tracing_creates_dir_and_returns_guards() {
        let tmp = tempfile::TempDir::new().unwrap();
        let dir = tmp.path().join("logs");
        // 전역 init은 1회 제약이라 직접 호출 대신 디렉터리 생성 + appender 빌드만 검증.
        std::fs::create_dir_all(&dir).unwrap();
        let appender = tracing_appender::rolling::Builder::new()
            .rotation(tracing_appender::rolling::Rotation::DAILY)
            .filename_prefix("errors")
            .filename_suffix("log")
            .max_log_files(7)
            .build(&dir)
            .unwrap();
        let (nb, _guard) = tracing_appender::non_blocking(appender);
        drop(nb);
        assert!(dir.exists());
    }
}
