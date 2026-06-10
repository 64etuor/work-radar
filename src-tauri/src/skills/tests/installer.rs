//! G1.5-PR1 네트워크 설치 테스트 (원본 tests.rs 1122–1433번 라인 이동).
use super::*;

#[test]
fn parse_source_accepts_common_forms() {
    use crate::skills::remote::parse_source;
    let s = parse_source("owner/repo").unwrap();
    assert_eq!(s.owner, "owner");
    assert_eq!(s.repo, "repo");
    assert_eq!(s.git_ref, None);
    assert_eq!(s.subpath, None);

    let s = parse_source("https://github.com/owner/repo").unwrap();
    assert_eq!(s.owner, "owner");
    assert_eq!(s.repo, "repo");

    let s = parse_source("github.com/owner/repo@main#skills/foo").unwrap();
    assert_eq!(s.git_ref.as_deref(), Some("main"));
    assert_eq!(s.subpath.as_deref(), Some("skills/foo"));

    let s = parse_source("https://github.com/owner/repo.git").unwrap();
    assert_eq!(s.repo, "repo");
}

#[test]
fn parse_source_rejects_garbage() {
    use crate::skills::remote::parse_source;
    assert!(parse_source("").is_none());
    assert!(parse_source("not-a-repo").is_none());
    assert!(parse_source("https://gitlab.com/owner/repo").is_none()); // GitHub 전용(이번 라운드)
}

#[test]
fn safe_relative_rejects_traversal_and_absolute() {
    use crate::skills::remote::safe_relative;
    use std::path::Path;
    assert!(safe_relative(Path::new("../escape.txt")).is_none());
    assert!(safe_relative(Path::new("a/../../escape")).is_none());
    assert!(safe_relative(Path::new("/abs/path")).is_none());
    assert!(safe_relative(Path::new("")).is_none());
    let ok = safe_relative(Path::new("owner-repo-abc/SKILL.md")).unwrap();
    assert_eq!(ok, Path::new("owner-repo-abc/SKILL.md"));
}

/// (path, contents) 엔트리로 gzip tarball을 메모리에 만든다(테스트 헬퍼).
fn make_targz(entries: &[(&str, &[u8])]) -> Vec<u8> {
    use flate2::write::GzEncoder;
    use flate2::Compression;
    use std::io::Write;
    let mut tar_buf = Vec::new();
    {
        let mut builder = tar::Builder::new(&mut tar_buf);
        for (path, contents) in entries {
            let mut header = tar::Header::new_gnu();
            header.set_size(contents.len() as u64);
            header.set_mode(0o644);
            header.set_cksum();
            builder.append_data(&mut header, path, *contents).unwrap();
        }
        builder.finish().unwrap();
    }
    let mut gz = GzEncoder::new(Vec::new(), Compression::default());
    gz.write_all(&tar_buf).unwrap();
    gz.finish().unwrap()
}

#[test]
fn extract_tarball_returns_top_level_dir() {
    use crate::skills::remote::extract_tarball;
    let gz = make_targz(&[
        ("owner-repo-abc123/SKILL.md", b"---\nname: x\n---\nbody"),
        ("owner-repo-abc123/extra.txt", b"hi"),
    ]);
    let (tmp, top) = extract_tarball(&gz).unwrap();
    assert_eq!(top, "owner-repo-abc123");
    assert!(tmp.path().join("owner-repo-abc123/SKILL.md").is_file());
    assert!(tmp.path().join("owner-repo-abc123/extra.txt").is_file());
}

/// 단일 엔트리 raw ustar tar.gz를 만든다. `tar::Builder`는 `..` 경로를 빌드타임에 거부하므로
/// 악성 경로(tar-slip)를 주입하려면 헤더를 직접 작성해야 한다(체크섬 포함).
fn make_raw_tar_gz(name: &str, data: &[u8]) -> Vec<u8> {
    use flate2::write::GzEncoder;
    use flate2::Compression;
    use std::io::Write;

    let mut header = [0u8; 512];
    let name_bytes = name.as_bytes();
    header[..name_bytes.len()].copy_from_slice(name_bytes);
    header[100..108].copy_from_slice(b"0000644\0"); // mode
    header[108..116].copy_from_slice(b"0000000\0"); // uid
    header[116..124].copy_from_slice(b"0000000\0"); // gid
    let size = format!("{:011o}\0", data.len()); // size(12B)
    header[124..136].copy_from_slice(size.as_bytes());
    header[136..148].copy_from_slice(b"00000000000\0"); // mtime
    header[156] = b'0'; // typeflag = regular file
    header[257..263].copy_from_slice(b"ustar\0");
    header[263..265].copy_from_slice(b"00");
    // 체크섬: chksum 필드를 8칸 공백으로 둔 채 전체 바이트 합산.
    for b in &mut header[148..156] {
        *b = b' ';
    }
    let sum: u32 = header.iter().map(|&b| b as u32).sum();
    let chksum = format!("{sum:06o}\0 "); // 6 octal + nul + space = 8B
    header[148..156].copy_from_slice(chksum.as_bytes());

    let mut tar = Vec::new();
    tar.extend_from_slice(&header);
    tar.extend_from_slice(data);
    let pad = (512 - (data.len() % 512)) % 512;
    tar.resize(tar.len() + pad, 0); // 데이터 블록 패딩
    tar.resize(tar.len() + 1024, 0); // 종료 = 두 개의 zero 블록

    let mut gz = GzEncoder::new(Vec::new(), Compression::default());
    gz.write_all(&tar).unwrap();
    gz.finish().unwrap()
}

#[test]
fn extract_tarball_rejects_tar_slip() {
    use crate::skills::remote::extract_tarball;
    // 악성 ".." 엔트리는 추출 거부(경로 탈출 방어, ADR-0006). raw tar로 빌드타임 검증을 우회해 주입.
    let gz = make_raw_tar_gz("../escape.txt", b"evil");
    let res = extract_tarball(&gz);
    assert!(res.is_err(), "tar-slip(.. 경로) 엔트리는 거부해야 한다");
    // 탈출 파일이 임시 루트 밖에 생기지 않았는지(거부가 쓰기보다 먼저 일어남) 보강 확인.
    assert!(!std::path::Path::new("/tmp/escape.txt").exists());
}

#[test]
fn extract_tarball_capped_allows_within_caps() {
    use crate::skills::remote::extract_tarball_capped;
    // 작은 상한이라도 한도 내 아카이브는 정상 추출(가드가 정상 경로를 막지 않음).
    let gz = make_targz(&[
        ("owner-repo-abc123/SKILL.md", b"---\nname: x\n---\nbody"),
        ("owner-repo-abc123/extra.txt", b"hi"),
    ]);
    let (tmp, top) =
        extract_tarball_capped(&gz, 4096, 100).expect("한도 내 아카이브는 추출되어야 한다");
    assert_eq!(top, "owner-repo-abc123");
    assert!(tmp.path().join("owner-repo-abc123/SKILL.md").is_file());
}

#[test]
fn extract_tarball_capped_rejects_oversize_total() {
    use crate::skills::remote::{extract_tarball_capped, RemoteFetchError};
    // 압축 해제 총량이 상한을 넘으면 거부(decompression bomb 가드). 0 바이트는 잘 압축되므로
    // 작은 gz로 큰 압축 해제 크기를 만들 수 있다 — bomb의 본질.
    let big = vec![0u8; 4096];
    let gz = make_targz(&[("owner-repo-abc123/big.bin", &big)]);
    let res = extract_tarball_capped(&gz, 1024, 100);
    assert!(
        matches!(res, Err(RemoteFetchError::Terminal(_))),
        "총량 상한 초과는 Terminal로 거부해야 한다, got {res:?}"
    );
}

#[test]
fn extract_tarball_capped_rejects_too_many_entries() {
    use crate::skills::remote::{extract_tarball_capped, RemoteFetchError};
    // 엔트리 개수가 상한을 넘으면 거부(수백만 tiny 엔트리 가드).
    let entries: Vec<(String, &[u8])> = (0..10)
        .map(|i| (format!("owner-repo-abc123/f{i}.txt"), b"x" as &[u8]))
        .collect();
    let borrowed: Vec<(&str, &[u8])> = entries.iter().map(|(p, c)| (p.as_str(), *c)).collect();
    let gz = make_targz(&borrowed);
    let res = extract_tarball_capped(&gz, 1_000_000, 3);
    assert!(
        matches!(res, Err(RemoteFetchError::Terminal(_))),
        "엔트리 개수 상한 초과는 Terminal로 거부해야 한다, got {res:?}"
    );
}

#[test]
fn remote_fetch_error_classification() {
    use crate::error::{AppError, ErrorKind};
    use crate::retry::Retryable;
    use crate::skills::remote::RemoteFetchError;

    assert!(RemoteFetchError::Transient("x".into()).is_retryable());
    assert!(!RemoteFetchError::Terminal("x".into()).is_retryable());
    assert!(!RemoteFetchError::NotFound("x".into()).is_retryable());
    assert!(!RemoteFetchError::Forbidden("x".into()).is_retryable());

    let ae: AppError = RemoteFetchError::NotFound("nope".into()).into();
    assert_eq!(ae.kind, ErrorKind::NotFound);
    let ae: AppError = RemoteFetchError::Transient("blip".into()).into();
    assert_eq!(ae.kind, ErrorKind::Transient);
    assert!(ae.retryable);
}

#[test]
fn fetch_budget_is_bounded() {
    // 무한 retry 금지 가드(ADR-0006 레일 ③/④ bounded). 상수라 컴파일타임 assert로 잠근다.
    const { assert!(crate::skills::remote::FETCH_MAX_ATTEMPTS <= 5) };
}

#[tokio::test]
async fn upsert_and_get_skill_source() {
    use crate::skills::source::{get_skill_source, upsert_skill_source, NewSkillSource};
    let pool = fresh_db().await;

    upsert_skill_source(
        &pool,
        NewSkillSource {
            provider: "claude",
            name: "demo",
            source_url: "github.com/owner/repo",
            source_ref: Some("main"),
            subpath: None,
            installed_commit: "abc123",
        },
    )
    .await
    .unwrap();

    let got = get_skill_source(&pool, "claude", "demo")
        .await
        .unwrap()
        .expect("row present");
    assert_eq!(got.source_url, "github.com/owner/repo");
    assert_eq!(got.installed_commit, "abc123");
    assert!(!got.auto_update);

    // 재upsert는 같은 (provider,name) 행을 갱신(중복 없음).
    upsert_skill_source(
        &pool,
        NewSkillSource {
            provider: "claude",
            name: "demo",
            source_url: "github.com/owner/repo",
            source_ref: Some("main"),
            subpath: None,
            installed_commit: "def456",
        },
    )
    .await
    .unwrap();
    let got = get_skill_source(&pool, "claude", "demo")
        .await
        .unwrap()
        .unwrap();
    assert_eq!(got.installed_commit, "def456");
}

#[tokio::test]
async fn install_from_dir_copies_records_and_audits() {
    use crate::skills::installer::{install_from_dir, InstallMeta};
    let pool = fresh_db().await;
    let tmp = TempDir::new().unwrap();
    make_skill(tmp.path(), "demo", "---\nname: demo\n---\nhello");
    let source_dir = tmp.path().join("demo");
    let central_root = tmp.path().join("lib");

    let skill = install_from_dir(
        &pool,
        &central_root,
        &source_dir,
        SkillProvider::Claude,
        InstallMeta {
            source_url: "github.com/owner/repo",
            source_ref: Some("main"),
            subpath: None,
            installed_commit: "abc123",
        },
    )
    .await
    .unwrap();

    assert_eq!(skill.kind, "managed");
    assert!(central_root.join("claude/demo/SKILL.md").is_file());

    let prov = crate::skills::source::get_skill_source(&pool, "claude", "demo")
        .await
        .unwrap()
        .unwrap();
    assert_eq!(prov.installed_commit, "abc123");

    let entries = crate::skills::audit_log::list_skill_audit_core(&pool)
        .await
        .unwrap();
    assert!(entries.iter().any(|e| e.action == "install"));
}

#[tokio::test]
async fn install_from_dir_rejects_non_skill() {
    use crate::skills::installer::{install_from_dir, InstallMeta};
    let pool = fresh_db().await;
    let tmp = TempDir::new().unwrap();
    let not_skill = tmp.path().join("blob");
    std::fs::create_dir_all(&not_skill).unwrap();
    std::fs::write(not_skill.join("random.txt"), b"nope").unwrap();
    let central_root = tmp.path().join("lib");

    let res = install_from_dir(
        &pool,
        &central_root,
        &not_skill,
        SkillProvider::Claude,
        InstallMeta {
            source_url: "github.com/owner/repo",
            source_ref: None,
            subpath: None,
            installed_commit: "x",
        },
    )
    .await;
    assert!(res.is_err(), "비스킬 dir은 거부");
    assert!(!central_root.exists(), "거부 시 중앙 오염 없음");
}
