//! 원격 스킬 소스(G1.5-PR1, ADR-0006 레일 ③) — GitHub repo ref 파싱 + tarball fetch/추출.
//!
//! 이번 라운드는 **GitHub 전용**. git 바이너리를 쓰지 않는다: `…/tarball/<ref>`를 reqwest로 받아
//! gzip tarball을 추출하되 tar-slip(경로 탈출)을 방어한다(모든 엔트리 경로 컴포넌트가 `Normal`이어야
//! 함). 토큰(비공개 repo용)은 호출자가 keychain에서 읽어 넘기며 로그에 절대 남기지 않는다.
//!
//! 네트워크 호출은 `retry::with_retry`로 bounded(backoff+jitter, terminal failure 노출) — 무한 retry 없음.
#![allow(clippy::result_large_err)]

use std::io::Read;
use std::path::{Component, Path, PathBuf};

use tempfile::TempDir;

use crate::retry::{with_retry, Retryable};

/// tarball fetch bounded retry 예산(무한 retry 금지 가드).
pub(crate) const FETCH_MAX_ATTEMPTS: u32 = 3;
const FETCH_BASE_DELAY_MS: u64 = 200;

/// 파싱된 GitHub 소스 ref.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RemoteSource {
    pub owner: String,
    pub repo: String,
    pub git_ref: Option<String>,
    pub subpath: Option<String>,
}

/// `owner/repo`, `github.com/owner/repo`, `https://github.com/owner/repo`를 파싱한다.
/// 선택적 `@ref`와 `#subpath` 지원(monorepo에서 한 스킬만 설치). GitHub 외 호스트/형식 불량은 `None`.
pub fn parse_source(input: &str) -> Option<RemoteSource> {
    let raw = input.trim();
    if raw.is_empty() {
        return None;
    }

    // 1) 선택적 #subpath 분리.
    let (without_sub, subpath) = match raw.split_once('#') {
        Some((head, sub)) if !sub.is_empty() => (head, Some(sub.to_string())),
        _ => (raw, None),
    };

    // 2) 선택적 @ref 분리.
    let (locator, git_ref) = match without_sub.split_once('@') {
        Some((head, r)) if !r.is_empty() => (head, Some(r.to_string())),
        _ => (without_sub, None),
    };

    // 3) scheme + host 제거. github.com만 허용.
    let path = locator
        .strip_prefix("https://")
        .or_else(|| locator.strip_prefix("http://"))
        .unwrap_or(locator);
    let path = match path.strip_prefix("github.com/") {
        Some(rest) => rest,
        None => {
            if path.contains('.') {
                return None; // github.com 아닌 호스트.
            }
            path // 맨 owner/repo.
        }
    };

    let mut parts = path.split('/');
    let owner = parts.next()?.to_string();
    let repo = parts.next()?.trim_end_matches(".git").to_string();
    if parts.next().is_some() {
        return None; // 세그먼트 과다.
    }
    if owner.is_empty() || repo.is_empty() {
        return None;
    }
    Some(RemoteSource {
        owner,
        repo,
        git_ref,
        subpath,
    })
}

/// 원격 fetch 실패 분류 — bounded retry + AppError 매핑용. 메시지에 응답 본문/토큰을 넣지 않는다.
#[derive(Debug)]
pub enum RemoteFetchError {
    /// 네트워크/5xx/429 — 재시도 가능.
    Transient(String),
    /// 404 — repo/ref 없음.
    NotFound(String),
    /// 401/403 — 인증/권한.
    Forbidden(String),
    /// 기타 4xx, 잘못된 아카이브, 추출 결과가 스킬 아님.
    Terminal(String),
}

impl Retryable for RemoteFetchError {
    fn is_retryable(&self) -> bool {
        matches!(self, RemoteFetchError::Transient(_))
    }
}

/// tar-slip 방어: 아카이브 엔트리 경로를 안전한 상대 경로로만 받아들인다. 모든 컴포넌트가 `Normal`이어야
/// 하며(`..`/절대경로/prefix/`.`는 거부), 빈 경로도 거부한다. 안전하면 정규화된 상대 경로를 돌려준다.
pub(crate) fn safe_relative(path: &Path) -> Option<PathBuf> {
    let mut out = PathBuf::new();
    let mut depth = 0usize;
    for comp in path.components() {
        match comp {
            Component::Normal(os) => {
                out.push(os);
                depth += 1;
            }
            _ => return None, // ParentDir/RootDir/Prefix/CurDir → 거부.
        }
    }
    if depth == 0 {
        None
    } else {
        Some(out)
    }
}

/// gzip tarball을 새 temp dir로 추출. 경로 탈출(tar-slip)을 막기 위해 모든 엔트리 경로의 컴포넌트가
/// `Normal`이어야 한다(`..`/절대경로/prefix는 거부). `(TempDir, 최상위_dir_이름)`을 돌려준다 —
/// GitHub tarball은 모든 내용을 단일 `owner-repo-<sha>/` dir로 감싼다.
pub fn extract_tarball(gz_bytes: &[u8]) -> Result<(TempDir, String), RemoteFetchError> {
    use flate2::read::GzDecoder;

    let tmp = TempDir::new().map_err(|e| RemoteFetchError::Terminal(format!("temp dir: {e}")))?;
    let root = tmp.path().to_path_buf();

    let mut archive = tar::Archive::new(GzDecoder::new(gz_bytes));
    let mut top_level: Option<String> = None;

    let entries = archive
        .entries()
        .map_err(|e| RemoteFetchError::Terminal(format!("read archive: {e}")))?;
    for entry in entries {
        let mut entry =
            entry.map_err(|e| RemoteFetchError::Terminal(format!("archive entry: {e}")))?;
        let is_dir = entry.header().entry_type().is_dir();
        let path = entry
            .path()
            .map_err(|e| RemoteFetchError::Terminal(format!("entry path: {e}")))?
            .into_owned();

        // tar-slip 방어: 안전한 상대 경로만 허용(`..`/절대경로 거부). 빈 경로는 skip.
        let Some(safe) = safe_relative(&path) else {
            if path.components().next().is_none() {
                continue;
            }
            return Err(RemoteFetchError::Terminal(format!(
                "unsafe archive path: {}",
                path.display()
            )));
        };
        // 최상위 dir 이름 기록(GitHub tarball은 단일 `owner-repo-<sha>/`로 감싼다).
        if let Some(Component::Normal(first)) = safe.components().next() {
            top_level.get_or_insert_with(|| first.to_string_lossy().into_owned());
        }

        let dest = root.join(&safe);
        if is_dir {
            std::fs::create_dir_all(&dest)
                .map_err(|e| RemoteFetchError::Terminal(format!("mkdir: {e}")))?;
        } else {
            if let Some(parent) = dest.parent() {
                std::fs::create_dir_all(parent)
                    .map_err(|e| RemoteFetchError::Terminal(format!("mkdir: {e}")))?;
            }
            let mut buf = Vec::new();
            entry
                .read_to_end(&mut buf)
                .map_err(|e| RemoteFetchError::Terminal(format!("read entry: {e}")))?;
            std::fs::write(&dest, &buf)
                .map_err(|e| RemoteFetchError::Terminal(format!("write entry: {e}")))?;
        }
    }

    let top = top_level.ok_or_else(|| RemoteFetchError::Terminal("empty archive".into()))?;
    Ok((tmp, top))
}

/// `source`의 GitHub tarball 바이트를 bounded retry로 받는다. `token`(있으면)은 Bearer로 보내며
/// 로그에 남기지 않는다. 공개 repo는 `token = None`으로 동작한다. `git_ref`가 없으면 기본 브랜치
/// (`/tarball`에 ref 미지정)를 받는다.
pub async fn fetch_tarball_bytes(
    source: &RemoteSource,
    token: Option<&str>,
) -> Result<Vec<u8>, RemoteFetchError> {
    let reference = source.git_ref.clone().unwrap_or_default();
    let url = format!(
        "https://api.github.com/repos/{}/{}/tarball/{}",
        source.owner, source.repo, reference
    );
    let base = std::time::Duration::from_millis(FETCH_BASE_DELAY_MS);

    with_retry(FETCH_MAX_ATTEMPTS, base, |_attempt| {
        let url = url.clone();
        let token = token.map(|t| t.to_string());
        async move {
            let client = reqwest::Client::builder()
                .user_agent("work-radar")
                .build()
                .map_err(|e| RemoteFetchError::Terminal(format!("http client: {e}")))?;
            let mut req = client
                .get(&url)
                .header("Accept", "application/vnd.github+json");
            if let Some(t) = token {
                req = req.bearer_auth(t);
            }
            let resp = req
                .send()
                .await
                .map_err(|e| RemoteFetchError::Transient(format!("request failed: {e}")))?;
            let status = resp.status();
            if status.is_success() {
                let bytes = resp
                    .bytes()
                    .await
                    .map_err(|e| RemoteFetchError::Transient(format!("read body failed: {e}")))?;
                return Ok(bytes.to_vec());
            }
            // 상태 → 분류. 응답 본문은 로그/메시지에 넣지 않는다(detail 노출 가능).
            let code = status.as_u16();
            Err(match code {
                404 => RemoteFetchError::NotFound(format!("repo or ref not found ({code})")),
                401 | 403 => RemoteFetchError::Forbidden(format!("forbidden ({code})")),
                429 | 500..=599 => RemoteFetchError::Transient(format!("server error ({code})")),
                _ => RemoteFetchError::Terminal(format!("request rejected ({code})")),
            })
        }
    })
    .await
}
