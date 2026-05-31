//! 스킬 네트워크 설치(G1.5-PR1, ADR-0006 레일 ③) — GitHub repo → 중앙 라이브러리.
//!
//! `install_skill_from_git`(커맨드)는 GitHub tarball을 받아 추출하고, 선택적 subpath를 해석한 뒤
//! `install_from_dir`가 그 dir을 **검증→중앙 복사→provenance 기록→audit** 한다. **잡을 spawn하지
//! 않는다(#1/#2 불변)**: 파일 I/O + DB 쓰기뿐이다(자동 분류/실행 경로가 생기지 않는다).
//!
//! PR1은 **공개 repo 우선**: 토큰은 넘기지 않는다(None). 비공개 repo 인증(keychain 자격증명 선택)은
//! 설치 UI와 함께 후속 라운드에서 추가한다 — fetch 시그니처는 이미 토큰을 받는다(PR3 대비).
#![allow(clippy::result_large_err)]

use std::path::Path;

use sqlx::SqlitePool;
use tauri::{Manager, State};

use crate::db::Db;
use crate::error::AppError;
use crate::models::{Skill, SkillProvider};
use crate::skills::audit_log::audit;
use crate::skills::central_repo::{import_to_central, provider_segment, sanitize_segment};
use crate::skills::remote::{extract_tarball, fetch_tarball_bytes, parse_source};
use crate::skills::scan::parse_frontmatter;
use crate::skills::source::{upsert_skill_source, NewSkillSource};

/// 설치에 기록할 provenance.
pub(crate) struct InstallMeta<'a> {
    pub source_url: &'a str,
    pub source_ref: Option<&'a str>,
    pub subpath: Option<&'a str>,
    pub installed_commit: &'a str,
}

/// `p.file_name()` 폴백 이름(lossy). 없으면 `"skill"`.
fn dir_name(p: &Path) -> String {
    p.file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| "skill".to_string())
}

/// dest dir의 **얕은** 파일 개수(audit detail용 메타 — 내용 미열람). import.rs와 동일 관례.
fn count_files(dir: &Path) -> usize {
    std::fs::read_dir(dir)
        .map(|rd| {
            rd.flatten()
                .filter(|e| e.file_type().map(|ft| ft.is_file()).unwrap_or(false))
                .count()
        })
        .unwrap_or(0)
}

/// core: 테스트 가능(앱 핸들 비의존). `source_dir`(SKILL.md 포함)을 검증→중앙 복사→provenance→audit.
/// 비스킬 dir(SKILL.md 없음)은 **복사 전** 거부(중앙 오염 방지). 반환 Skill은 import core와 동일 형태.
pub(crate) async fn install_from_dir(
    pool: &SqlitePool,
    central_root: &Path,
    source_dir: &Path,
    provider: SkillProvider,
    meta: InstallMeta<'_>,
) -> Result<Skill, AppError> {
    // 복사 전 검증: SKILL.md가 있어야 스킬이다.
    let skill_md = source_dir.join("SKILL.md");
    let content = std::fs::read_to_string(&skill_md).map_err(|_| {
        AppError::terminal(
            "skills.install.not_a_skill",
            "설치 대상에 SKILL.md가 없습니다(유효한 스킬이 아님).".to_string(),
        )
    })?;
    let (fm_name, fm_desc) = parse_frontmatter(&content);
    let name = fm_name.unwrap_or_else(|| dir_name(source_dir));
    let seg = sanitize_segment(&name);
    let provider_str = provider_segment(provider);

    let dest = import_to_central(central_root, provider_str, &seg, source_dir)?;

    upsert_skill_source(
        pool,
        NewSkillSource {
            provider: provider_str,
            name: &seg,
            source_url: meta.source_url,
            source_ref: meta.source_ref,
            subpath: meta.subpath,
            installed_commit: meta.installed_commit,
        },
    )
    .await?;

    // detail은 비밀-free: 파일 수 + commit SHA만(본문·토큰 금지). 레일 ① 감사 기록.
    let detail = format!(
        "files={},commit={}",
        count_files(&dest),
        meta.installed_commit
    );
    audit(
        pool,
        "install",
        "managed_skill",
        &dest.to_string_lossy(),
        Some(meta.source_url),
        Some(&detail),
    )
    .await?;

    let md_path = dest.join("SKILL.md");
    Ok(Skill {
        id: format!("managed:{}", md_path.to_string_lossy()),
        name,
        kind: "managed".into(),
        prompt: Some(fm_desc.unwrap_or_default()),
        binding: None,
        rail: None,
        enabled: true,
        model: None,
        reasoning_effort: None,
        fast_mode: false,
        source_path: Some(md_path.to_string_lossy().into_owned()),
        provider: Some(provider),
        tags: Vec::new(),
        fallback_prompt: None,
        created_at: String::new(),
        updated_at: String::new(),
    })
}

/// GitHub tarball 최상위 dir(`owner-repo-<sha>`)에서 resolved commit SHA 추출. 끝 SHA가 없으면 전체 이름.
/// G1.5-PR3 updater(check)가 동일 추출을 재사용 → `pub(crate)`.
pub(crate) fn commit_from_top_level(top: &str) -> String {
    top.rsplit('-').next().unwrap_or(top).to_string()
}

/// 앱 데이터 경로 아래 중앙 라이브러리 루트(`app_data_dir/skills-library`). import.rs와 동일.
fn central_root(app: &tauri::AppHandle) -> Result<std::path::PathBuf, AppError> {
    Ok(app
        .path()
        .app_data_dir()
        .map_err(|e| {
            AppError::terminal(
                "skills.app_data_dir",
                format!("앱 데이터 경로 해석 실패: {e}"),
            )
        })?
        .join("skills-library"))
}

#[tauri::command]
#[specta::specta]
pub async fn install_skill_from_git(
    db: State<'_, Db>,
    app: tauri::AppHandle,
    url: String,
    provider: SkillProvider,
) -> Result<Skill, AppError> {
    let source = parse_source(&url).ok_or_else(|| {
        AppError::terminal(
            "skills.install.invalid_url",
            format!("지원하지 않는 GitHub repo URL입니다: {url}"),
        )
    })?;

    // PR1: 공개 repo 우선 — 토큰 미사용(None). (비공개 인증은 설치 UI와 함께 후속.)
    let gz = fetch_tarball_bytes(&source, None).await?;
    let (tmp, top) = extract_tarball(&gz)?;
    let installed_commit = commit_from_top_level(&top);

    // 스킬 콘텐츠는 `<top>/<subpath?>` 아래. subpath 세그먼트는 sanitize로 탈출 방지.
    let mut content_dir = tmp.path().join(&top);
    if let Some(sub) = &source.subpath {
        for seg in sub.split('/').filter(|s| !s.is_empty()) {
            content_dir = content_dir.join(sanitize_segment(seg));
        }
    }
    if !content_dir.is_dir() {
        return Err(AppError::not_found(
            "skills.install.subpath_missing",
            "요청한 경로를 repo에서 찾을 수 없습니다.".to_string(),
        ));
    }

    let central = central_root(&app)?;
    install_from_dir(
        &db,
        &central,
        &content_dir,
        provider,
        InstallMeta {
            source_url: &url,
            source_ref: source.git_ref.as_deref(),
            subpath: source.subpath.as_deref(),
            installed_commit: &installed_commit,
        },
    )
    .await
}
