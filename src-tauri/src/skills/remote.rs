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
pub(crate) const MAX_COMPRESSED_ARCHIVE_BYTES: usize = 64 * 1024 * 1024;
const FETCH_CONNECT_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(10);
const FETCH_REQUEST_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(30);

/// 압축 해제 총량 상한(decompression/tar-bomb 가드, bounded INVARIANT). 실제 스킬 repo는 이보다
/// 훨씬 작다 — bomb(수 KB → 수 GB)만 차단된다. 쿼터가 아니라 안전 가드.
pub(crate) const MAX_TOTAL_UNCOMPRESSED_BYTES: u64 = 256 * 1024 * 1024;
/// 아카이브 엔트리(파일+디렉터리) 개수 상한(수백만 tiny 엔트리 가드).
pub(crate) const MAX_ARCHIVE_ENTRIES: usize = 100_000;

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
///
/// 압축 해제 총량/엔트리 개수는 [`MAX_TOTAL_UNCOMPRESSED_BYTES`]/[`MAX_ARCHIVE_ENTRIES`]로 bound한다
/// (decompression/tar-bomb 가드). 상한 주입형 코어는 [`extract_tarball_capped`].
pub fn extract_tarball(gz_bytes: &[u8]) -> Result<(TempDir, String), RemoteFetchError> {
    extract_tarball_capped(gz_bytes, MAX_TOTAL_UNCOMPRESSED_BYTES, MAX_ARCHIVE_ENTRIES)
}

fn append_compressed_chunk(
    buffer: &mut Vec<u8>,
    chunk: &[u8],
    max_bytes: usize,
) -> Result<(), usize> {
    let observed = buffer.len().saturating_add(chunk.len());
    if chunk.len() > max_bytes.saturating_sub(buffer.len()) {
        return Err(observed);
    }
    buffer.extend_from_slice(chunk);
    Ok(())
}

async fn read_tarball_body_capped(
    mut resp: reqwest::Response,
) -> Result<Vec<u8>, RemoteFetchError> {
    if let Some(length) = resp.content_length() {
        if length > MAX_COMPRESSED_ARCHIVE_BYTES as u64 {
            return Err(RemoteFetchError::Terminal(format!(
                "archive too large (compressed_bytes={length}, max_bytes={MAX_COMPRESSED_ARCHIVE_BYTES})"
            )));
        }
    }

    let mut body = Vec::with_capacity(
        resp.content_length()
            .unwrap_or_default()
            .min(MAX_COMPRESSED_ARCHIVE_BYTES as u64) as usize,
    );
    while let Some(chunk) = resp
        .chunk()
        .await
        .map_err(|e| RemoteFetchError::Transient(format!("read body failed: {e}")))?
    {
        if let Err(observed) =
            append_compressed_chunk(&mut body, &chunk, MAX_COMPRESSED_ARCHIVE_BYTES)
        {
            return Err(RemoteFetchError::Terminal(format!(
                "archive too large (compressed_bytes_at_least={observed}, max_bytes={MAX_COMPRESSED_ARCHIVE_BYTES})"
            )));
        }
    }
    Ok(body)
}

/// [`extract_tarball`]의 상한 주입형 코어. `max_total_bytes`는 전체 압축 해제 바이트 합,
/// `max_entries`는 엔트리(파일+디렉터리) 개수의 상한이다. 어느 쪽이든 넘으면 `Terminal`로 거부하며,
/// 파일 버퍼는 남은 예산+1로 bound해 피크 메모리도 상한 이내로 유지한다(bomb가 메모리/디스크 고갈 불가).
pub(crate) fn extract_tarball_capped(
    gz_bytes: &[u8],
    max_total_bytes: u64,
    max_entries: usize,
) -> Result<(TempDir, String), RemoteFetchError> {
    use flate2::read::GzDecoder;

    let tmp = TempDir::new().map_err(|e| RemoteFetchError::Terminal(format!("temp dir: {e}")))?;
    let root = tmp.path().to_path_buf();

    let mut archive = tar::Archive::new(GzDecoder::new(gz_bytes));
    let mut top_level: Option<String> = None;
    let mut total_bytes: u64 = 0;
    let mut entry_count: usize = 0;

    let entries = archive
        .entries()
        .map_err(|e| RemoteFetchError::Terminal(format!("read archive: {e}")))?;
    for entry in entries {
        let mut entry =
            entry.map_err(|e| RemoteFetchError::Terminal(format!("archive entry: {e}")))?;

        // 엔트리 개수 가드: 수백만 tiny 엔트리로 디스크/inode를 고갈시키는 것을 막는다.
        entry_count += 1;
        if entry_count > max_entries {
            return Err(RemoteFetchError::Terminal(format!(
                "too many archive entries (> {max_entries})"
            )));
        }

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
            // 크기 가드: 남은 예산+1까지만 읽어 버퍼 할당을 bound(피크 메모리 ≤ 상한). 초과면 거부.
            // `total_bytes <= max_total_bytes` 불변(아래 검사 후에만 증가)이라 빼기는 underflow 없음.
            // `saturating_add`는 거대 cap 주입 시 `remaining+1` u64 overflow 방지(belt-and-suspenders).
            let remaining = max_total_bytes - total_bytes;
            let mut buf = Vec::new();
            (&mut entry)
                .take(remaining.saturating_add(1))
                .read_to_end(&mut buf)
                .map_err(|e| RemoteFetchError::Terminal(format!("read entry: {e}")))?;
            if buf.len() as u64 > remaining {
                return Err(RemoteFetchError::Terminal(format!(
                    "archive too large (uncompressed > {max_total_bytes} bytes)"
                )));
            }
            total_bytes += buf.len() as u64;
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
    let client = reqwest::Client::builder()
        .user_agent("work-radar")
        .connect_timeout(FETCH_CONNECT_TIMEOUT)
        .timeout(FETCH_REQUEST_TIMEOUT)
        .build()
        .map_err(|e| RemoteFetchError::Terminal(format!("http client: {e}")))?;

    with_retry(FETCH_MAX_ATTEMPTS, base, |_attempt| {
        let url = url.clone();
        let token = token.map(|t| t.to_string());
        let client = client.clone();
        async move {
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
                return read_tarball_body_capped(resp).await;
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn compressed_body_cap_accepts_limit_and_rejects_overflow() {
        let mut body = vec![1, 2];
        assert_eq!(append_compressed_chunk(&mut body, &[3, 4], 4), Ok(()));
        assert_eq!(body, vec![1, 2, 3, 4]);
        assert_eq!(append_compressed_chunk(&mut body, &[5], 4), Err(5));
        assert_eq!(body, vec![1, 2, 3, 4]);
    }
}
