//! 중앙 라이브러리(G1, ADR-0006 레일 ②) — work-radar 소유 managed 스킬 스토어.
//! managed 스킬 = `app_data_dir/skills-library/<provider>/<name>/`. **디스크가 managed SSOT**.
//!
//! 순수 fs 레이어(앱 핸들·DB 비의존 → tempdir로 hermetic 테스트). 가역성 계약(레일 ②): import는
//! 외부(src)를 **읽기만** 하고 중앙에 복사하며, remove는 **중앙 복사본만** 지운다(외부 파일 무손상).
//! 심링크는 따라가지 않는다(외부 dir 안전 — 복사가 외부 트리 밖으로 새지 않음). 비밀 비취급.
//
// 본 모듈의 fs 헬퍼는 Result<_, AppError>로 통일(단일 envelope, 레포 전역 규약) → 모듈 단위 허용.
#![allow(clippy::result_large_err)]

use crate::error::AppError;
use crate::models::SkillProvider;
use std::path::{Path, PathBuf};

/// managed 스토어가 다루는 provider 세그먼트(디렉터리명). `SkillProvider`의 모든 변종.
const PROVIDERS: [SkillProvider; 5] = [
    SkillProvider::Claude,
    SkillProvider::Codex,
    SkillProvider::Openclaw,
    SkillProvider::Hermes,
    SkillProvider::Other,
];

/// `SkillProvider` → 중앙 스토어 디렉터리 세그먼트. `#[serde(rename_all="lowercase")]`와 일치.
pub(crate) fn provider_segment(p: SkillProvider) -> &'static str {
    match p {
        SkillProvider::Claude => "claude",
        SkillProvider::Codex => "codex",
        SkillProvider::Openclaw => "openclaw",
        SkillProvider::Hermes => "hermes",
        SkillProvider::Other => "other",
    }
}

/// `<central>/<provider>/<name>`.
pub(crate) fn central_skill_dir(central_root: &Path, provider: &str, name: &str) -> PathBuf {
    central_root.join(provider).join(name)
}

/// 임의 스킬 이름 → 안전한 단일 경로 세그먼트. path-escape(`/`, `\`, `..`, 절대경로, 제어문자)를
/// 제거해 import가 `<central>/<provider>/` 밖으로 절대 못 나가게 한다(디렉터리 traversal 방어).
/// 빈 결과는 `"skill"`로 폴백.
pub(crate) fn sanitize_segment(s: &str) -> String {
    let cleaned: String = s
        .trim()
        .chars()
        .map(|c| match c {
            '/' | '\\' | '\0' => '_',
            c if c.is_control() => '_',
            c => c,
        })
        .collect();
    // 경로 컴포넌트로 위험한 형태(`.`, `..`, 선두/후미 점·공백 잔재)를 무력화.
    let cleaned = cleaned.trim().trim_matches('.').trim();
    if cleaned.is_empty() || cleaned == ".." || cleaned == "." {
        "skill".to_string()
    } else {
        cleaned.to_string()
    }
}

/// 외부 스킬 dir(src_dir, SKILL.md 포함)을 중앙으로 복사. dest dir 반환.
/// 기존 dest가 있으면 덮어쓰기 전에 제거(재import 멱등). 외부(src)는 읽기만 한다.
pub(crate) fn import_to_central(
    central_root: &Path,
    provider: &str,
    name: &str,
    src_dir: &Path,
) -> Result<PathBuf, AppError> {
    let dest = central_skill_dir(central_root, provider, name);
    if dest.exists() {
        std::fs::remove_dir_all(&dest)?; // 재import 멱등(이전 복사본 제거 후 새로 복사).
    }
    std::fs::create_dir_all(&dest)?;
    copy_dir_shallow(src_dir, &dest)?; // SKILL.md + 형제 파일/서브디렉터리 복사.
    Ok(dest)
}

/// 중앙 복사본만 삭제(가역). 외부 파일은 절대 건드리지 않는다.
pub(crate) fn remove_from_central(
    central_root: &Path,
    provider: &str,
    name: &str,
) -> Result<(), AppError> {
    let dest = central_skill_dir(central_root, provider, name);
    if dest.exists() {
        std::fs::remove_dir_all(&dest)?;
    }
    Ok(())
}

/// 디렉터리 재귀 복사(파일 + 서브디렉터리). 심링크는 따라가지 않고 건너뛴다(외부 dir 안전 — 복사가
/// 외부 트리 밖으로 새지 않음).
fn copy_dir_shallow(src: &Path, dest: &Path) -> Result<(), AppError> {
    for entry in std::fs::read_dir(src)? {
        let entry = entry?;
        let ft = entry.file_type()?;
        let from = entry.path();
        let to = dest.join(entry.file_name());
        if ft.is_symlink() {
            continue;
        } else if ft.is_dir() {
            std::fs::create_dir_all(&to)?;
            copy_dir_shallow(&from, &to)?;
        } else if ft.is_file() {
            std::fs::copy(&from, &to)?;
        }
    }
    Ok(())
}

/// 중앙 스토어를 스캔해 (provider, 스킬 dir) 목록을 돌려준다(SKILL.md를 가진 dir만). 부재/읽기불가
/// provider dir는 per-provider skip(무에러) — managed 0개면 빈 vec(no-op).
pub(crate) fn list_managed_dirs(central_root: &Path) -> Vec<(SkillProvider, PathBuf)> {
    let mut out = Vec::new();
    for p in PROVIDERS {
        let provider_dir = central_root.join(provider_segment(p));
        let Ok(entries) = std::fs::read_dir(&provider_dir) else {
            continue; // provider dir 부재/읽기불가 → skip(무에러).
        };
        for entry in entries.flatten() {
            let dir = entry.path();
            if dir.join("SKILL.md").is_file() {
                out.push((p, dir));
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn import_copies_then_remove_deletes_central_only_external_untouched() {
        let tmp = tempfile::tempdir().unwrap();
        // fake external skill
        let ext = tmp.path().join("ext/.claude/skills/foo");
        std::fs::create_dir_all(&ext).unwrap();
        let ext_md = ext.join("SKILL.md");
        std::fs::write(&ext_md, "---\nname: foo\n---\nbody").unwrap();
        // fake central root
        let central = tmp.path().join("skills-library");

        let dest = import_to_central(&central, "claude", "foo", &ext).expect("import");
        assert!(dest.join("SKILL.md").exists());
        assert_eq!(
            std::fs::read_to_string(dest.join("SKILL.md")).unwrap(),
            std::fs::read_to_string(&ext_md).unwrap()
        ); // content matches

        remove_from_central(&central, "claude", "foo").expect("remove");
        assert!(!dest.exists()); // central copy gone
        assert!(ext_md.exists()); // EXTERNAL FILE UNTOUCHED (rail ②)
    }
}
