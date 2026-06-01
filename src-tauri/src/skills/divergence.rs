//! 프로젝트 vendored 카피 드리프트 감지(G3-PR2, ADR-0006 #22 부분 — 감지 전용).
//!
//! 프로젝트 스킬 dir(`<repo>/.claude/skills/<name>` 등)이 중앙 managed 카피와 바이트 동일한지
//! 디스크에서 비교한다. **읽기 전용**: 어떤 dir에도 쓰지 않고, 마이그레이션/네트워크/잡 spawn 없음
//! (#1/#2/#7). 적용/해소(복사·pull/push)는 후속 PR. 심링크 멤버는 드리프트 불가라 후보 제외.
//! 경로는 표시·매칭 전용 — 로그 금지(C7).
#![allow(clippy::result_large_err)]

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

/// 트리 비교용 항목 표현(파일 내용 / 심링크 타깃 / 디렉터리 마커).
#[derive(PartialEq, Eq)]
enum TreeEntry {
    File(Vec<u8>),
    Symlink(PathBuf),
    Dir,
}

/// `root` 아래를 재귀 수집해 (상대경로 → 항목) 맵을 만든다. 심링크는 따라가지 않는다(트리 밖 비교
/// 차단). IO 오류는 None(호출자가 Diverged로 매핑 — 보수적).
fn collect_tree(root: &Path) -> Option<BTreeMap<PathBuf, TreeEntry>> {
    let mut map = BTreeMap::new();
    walk_tree(root, root, &mut map)?;
    Some(map)
}

fn walk_tree(root: &Path, dir: &Path, map: &mut BTreeMap<PathBuf, TreeEntry>) -> Option<()> {
    for entry in std::fs::read_dir(dir).ok()? {
        let entry = entry.ok()?;
        let path = entry.path();
        let rel = path.strip_prefix(root).ok()?.to_path_buf();
        let ft = entry.file_type().ok()?;
        if ft.is_symlink() {
            map.insert(rel, TreeEntry::Symlink(std::fs::read_link(&path).ok()?));
        } else if ft.is_dir() {
            map.insert(rel, TreeEntry::Dir);
            walk_tree(root, &path, map)?;
        } else if ft.is_file() {
            map.insert(rel, TreeEntry::File(std::fs::read(&path).ok()?));
        }
        // 기타 타입(fifo 등)은 스킬에 없음 — 무시.
    }
    Some(())
}

/// 두 스킬 디렉터리 트리가 동일한지(상대경로 집합 + 파일별 바이트 + 심링크 타깃). 한쪽이라도 읽기
/// 실패면 false(보수적).
fn trees_equal(a: &Path, b: &Path) -> bool {
    match (collect_tree(a), collect_tree(b)) {
        (Some(ta), Some(tb)) => ta == tb,
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write(p: &Path, body: &str) {
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(p, body).unwrap();
    }

    #[test]
    fn trees_equal_true_for_identical_with_subdir() {
        let tmp = tempfile::tempdir().unwrap();
        let a = tmp.path().join("a");
        let b = tmp.path().join("b");
        for root in [&a, &b] {
            write(&root.join("SKILL.md"), "---\nname: x\n---\nbody");
            write(&root.join("sub/extra.txt"), "hello");
        }
        assert!(trees_equal(&a, &b));
    }

    #[test]
    fn trees_equal_false_for_edited_file() {
        let tmp = tempfile::tempdir().unwrap();
        let a = tmp.path().join("a");
        let b = tmp.path().join("b");
        write(&a.join("SKILL.md"), "one");
        write(&b.join("SKILL.md"), "two");
        assert!(!trees_equal(&a, &b));
    }

    #[test]
    fn trees_equal_false_for_extra_file() {
        let tmp = tempfile::tempdir().unwrap();
        let a = tmp.path().join("a");
        let b = tmp.path().join("b");
        write(&a.join("SKILL.md"), "same");
        write(&b.join("SKILL.md"), "same");
        write(&b.join("extra.txt"), "x");
        assert!(!trees_equal(&a, &b));
    }

    #[test]
    fn trees_equal_false_for_missing_file() {
        let tmp = tempfile::tempdir().unwrap();
        let a = tmp.path().join("a");
        let b = tmp.path().join("b");
        write(&a.join("SKILL.md"), "same");
        write(&a.join("gone.txt"), "y");
        write(&b.join("SKILL.md"), "same");
        assert!(!trees_equal(&a, &b));
    }

    #[test]
    fn trees_equal_false_when_one_missing() {
        let tmp = tempfile::tempdir().unwrap();
        let a = tmp.path().join("a");
        write(&a.join("SKILL.md"), "same");
        assert!(!trees_equal(&a, &tmp.path().join("nonexistent")));
    }
}
