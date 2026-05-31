//! 스킬 루트 해석/스캔/환경감지/외부파일 읽기·쓰기 + path-guard(G1-PR1 분할, 무행동변경).
//! 멀티루트 frontmatter 스캔(읽기 전용), env/repo/user 루트 합성(C6 단일 출처), 외부 SKILL.md
//! 읽기/쓰기는 ROOTS path-guard(C1) 하에서만. 로직 불변 — `commands/skills.rs`에서 그대로 이동.

use tauri::State;

use crate::commands::nav::{get_config, set_config};
use crate::commands::projects::fetch_all_repos;
use crate::db::Db;
use crate::error::AppError;
use crate::models::{
    ExternalSkill, Provider, Repo, SkillEnvironment, SkillProvider, UserSkillRoot,
};
use std::collections::HashSet;
use std::path::{Path, PathBuf};

/// 사용자 설정 임의 스킬 루트(P1.5 #3)의 `app_config` 키. 값은 `UserSkillRoot` JSON 배열 문자열.
/// 스키마 변경 없음(기존 key-value 스토어 재사용) — Phase 3만 마이그레이션 페이즈.
pub(crate) const KEY_USER_SKILL_ROOTS: &str = "skills.user_roots";
/// 재귀 루트의 깊이 캡(루트 기준). 실측(2026-05-30): hermes 스킬 최심 = depth 3, claude 중첩 = depth 2.
/// 4는 카테고리/그룹 중첩에 충분한 헤드룸이면서, 거대 트리(레포 등)에서 무한 하강을 막는 상한이다
/// (node_modules 등은 `is_ignored_dir`로 별도 차단, 리프 규칙으로 보통 더 일찍 멈춤).
pub(crate) const RECURSIVE_MAX_DEPTH: usize = 4;

/// 스캔·path-guard·detect가 **공유하는 단 하나의 루트 정의**(C6). P0=`(provider, path, recursive)`
/// 3-튜플이었으나 P1.5에서 깊이 메타(`max_depth`)를 더해 구조체로. `recursive`=true면 바운디드 재귀로
/// 중첩 카테고리 스킬까지 발견한다(아래 `scan_root`). ignore 리스트는 전 루트 동일(`is_ignored_dir`)이라
/// per-root 필드 대신 공유 술어로 둔다(YAGNI — 향후 per-root override가 필요하면 구조체라 비파괴 추가).
#[derive(Debug, Clone)]
pub(crate) struct SkillRoot {
    pub provider: SkillProvider,
    pub path: PathBuf,
    /// true면 리프 규칙 기반 바운디드 재귀, false면 직속 자식만(P0 동작).
    pub recursive: bool,
    /// recursive일 때 루트 기준 최대 하강 깊이(리프 규칙으로 보통 더 일찍 멈춤). 비재귀는 1.
    pub max_depth: usize,
}

impl SkillRoot {
    /// 비재귀 루트(직속 자식만 — P0 동작). 현재 테스트 전용.
    #[cfg_attr(not(test), allow(dead_code))]
    pub(crate) fn flat(provider: SkillProvider, path: PathBuf) -> Self {
        Self {
            provider,
            path,
            recursive: false,
            max_depth: 1,
        }
    }

    /// 바운디드 재귀 루트.
    pub(crate) fn recursive(provider: SkillProvider, path: PathBuf, max_depth: usize) -> Self {
        Self {
            provider,
            path,
            recursive: true,
            max_depth,
        }
    }
}

/// 레포-로컬 에이전트 스킬 dir 규칙(글로벌과 동일): `<repo>/.claude/skills`→Claude,
/// `.codex/skills`→Codex, `.agents/skills`→Codex(공유 agents dir). 각 루트는 recursive
/// (레포 거대 트리 방어: ignore + depth cap).
const REPO_SKILL_DIRS: [(&str, SkillProvider); 3] = [
    (".claude/skills", SkillProvider::Claude),
    (".codex/skills", SkillProvider::Codex),
    (".agents/skills", SkillProvider::Codex),
];

/// 레포-로컬 루트 합성(P1.5 #4): `provider=Local` + 비어있지 않은 `local_path` + `enabled`인 레포의
/// 에이전트 스킬 dir를 재귀 루트로. `Provider::Github`(remote-only, 로컬 체크아웃 없음)·비활성·빈 경로는
/// 제외. 존재하지 않는 dir도 합성한다(스캔이 graceful skip — env 루트와 동일 정책). 재귀+ignore 필수.
pub(crate) fn repo_skill_roots(repos: &[Repo]) -> Vec<SkillRoot> {
    let mut out = Vec::new();
    for repo in repos {
        if repo.provider != Provider::Local || !repo.enabled {
            continue;
        }
        let Some(base) = repo
            .local_path
            .as_deref()
            .map(str::trim)
            .filter(|p| !p.is_empty())
            .map(PathBuf::from)
        else {
            continue;
        };
        for (sub, provider) in REPO_SKILL_DIRS {
            out.push(SkillRoot::recursive(
                provider,
                base.join(sub),
                RECURSIVE_MAX_DEPTH,
            ));
        }
    }
    out
}

/// 재귀 하강 시 건너뛸 디렉터리 이름: 숨김 dir(`.git`/`.venv`/벤더된 에이전트 dotfile 등) + 표준
/// 빌드/벤더 dir. 특히 레포-로컬 루트(P1.5 #4)에서 거대 트리(node_modules 등) 폭주를 막는다. 루트 자체는
/// 명시 경로라 이 술어의 대상이 아니다(하강 중 하위 dir에만 적용).
fn is_ignored_dir(name: &str) -> bool {
    name.starts_with('.') || matches!(name, "node_modules" | "target" | "dist" | "vendor")
}

/// 스캔·path-guard·detect가 공유하는 ROOTS(C6 단일 출처). 정적 상수 → P1 env-aware resolution →
/// P1.5에서 재귀 + Hermes 루트로 진화. C6 단일 출처는 유지: 한 함수가 전 소비자에 같은 슬라이스를 준다.
///
/// `.agents/skills`는 도구 간 공유 발견 dir이라 P0부터 **Codex로 태깅**(upstream codex 귀속).
/// ⚑ Copilot 추가 시 `.agents/skills`는 공유되므로 **귀속 재검토 필요**.
///
/// DB-aware 합성 ROOTS(C6 단일 출처): [env-resolved 도구 루트] + [레포-로컬 루트] + [사용자 설정 임의
/// 루트(P1.5 #3)]. 전 소비자(스캔·detect·path-guard)가 이 함수를 통해 같은 슬라이스를 받는다 — 사용자
/// 루트도 자동으로 path-guard(C1)에 포함된다(개별 커맨드에 별도 주입 없음). 레포/사용자 루트 조회 실패는
/// graceful(가능분만으로 degrade) — 읽기 전용이라 안전.
pub(crate) async fn skill_roots_db(db: &Db) -> Vec<SkillRoot> {
    let mut roots = resolve_skill_roots(&SkillRootEnv::from_process());
    match fetch_all_repos(db).await {
        Ok(repos) => roots.extend(repo_skill_roots(&repos)),
        Err(e) => {
            tracing::debug!(target: "skills.roots", error = %e, "repo roots unavailable; env-only")
        }
    }
    match read_user_skill_roots(db).await {
        Ok(user) => roots.extend(user_skill_roots(&user)),
        Err(e) => {
            tracing::debug!(target: "skills.roots", error = %e, "user roots unavailable; skipping")
        }
    }
    roots
}

/// `app_config`에서 사용자 설정 루트를 읽어 역직렬화한다(미설정/빈 값이면 빈 vec). DB read·역직렬화
/// 실패는 호출자가 graceful 처리(skill_roots_db) 또는 에러 노출(get 커맨드)한다.
pub(crate) async fn read_user_skill_roots(db: &Db) -> Result<Vec<UserSkillRoot>, AppError> {
    let raw = get_config(db, KEY_USER_SKILL_ROOTS)
        .await
        .map_err(AppError::from)?;
    match raw.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        None => Ok(Vec::new()),
        Some(json) => serde_json::from_str::<Vec<UserSkillRoot>>(json).map_err(|e| {
            AppError::terminal(
                "skills.user_roots_parse",
                format!("사용자 스킬 루트 설정을 읽지 못했습니다: {e}"),
            )
        }),
    }
}

/// 사용자 입력 루트 검증·정규화(트림 + **절대경로 강제** + dedup). 비절대/빈 경로는 거부한다(path-guard가
/// 의미 있으려면 절대 필요). 존재하지 않는 dir은 허용(안전망). 커맨드와 테스트가 공유하는 단일 검증 출처.
#[allow(clippy::result_large_err)] // 단일 AppError envelope(레포 전역 규약) — 모듈 관용과 동일.
pub(crate) fn normalize_user_skill_roots(
    roots: Vec<UserSkillRoot>,
) -> Result<Vec<UserSkillRoot>, AppError> {
    let mut seen: HashSet<String> = HashSet::new();
    let mut cleaned: Vec<UserSkillRoot> = Vec::new();
    for r in roots {
        let path = r.path.trim().to_string();
        if path.is_empty() {
            return Err(AppError::validation(
                "skills.user_root_empty",
                "스킬 루트 경로가 비었습니다.",
            ));
        }
        if !Path::new(&path).is_absolute() {
            return Err(AppError::validation(
                "skills.user_root_relative",
                "스킬 루트는 절대 경로여야 합니다(상대 경로는 허용되지 않습니다).",
            ));
        }
        if seen.insert(path.clone()) {
            cleaned.push(UserSkillRoot { path });
        }
    }
    Ok(cleaned)
}

/// 사용자 루트 → `SkillRoot`(provider=Other, recursive, 도구 루트와 동일 depth cap). 빈/공백 경로는
/// 스킵한다(env/repo 루트와 동일 정책). provider는 루트별 영속하지 않고 여기서 Other로 합성한다.
pub(crate) fn user_skill_roots(roots: &[UserSkillRoot]) -> Vec<SkillRoot> {
    roots
        .iter()
        .filter_map(|r| {
            let p = r.path.trim();
            (!p.is_empty()).then(|| {
                SkillRoot::recursive(SkillProvider::Other, PathBuf::from(p), RECURSIVE_MAX_DEPTH)
            })
        })
        .collect()
}

/// 루트 resolution 입력(테스트는 직접 주입 → hermetic, 프로세스 env 전역 변이 없음). 프로세스 env를
/// 한 번에 캡처한다.
pub(crate) struct SkillRootEnv {
    pub(crate) home: Option<PathBuf>,
    pub(crate) claude_config_dir: Option<PathBuf>,
    pub(crate) codex_home: Option<PathBuf>,
    pub(crate) xdg_config_home: Option<PathBuf>,
}

impl SkillRootEnv {
    fn from_process() -> Self {
        let var = |k: &str| std::env::var_os(k).map(PathBuf::from);
        Self {
            home: var("HOME"),
            claude_config_dir: var("CLAUDE_CONFIG_DIR"),
            codex_home: var("CODEX_HOME"),
            xdg_config_home: var("XDG_CONFIG_HOME"),
        }
    }
}

/// env → 루트 경로 목록 해석(C6 단일 출처). 도구별 우선순위:
/// 1. **명시 override env**(`CLAUDE_CONFIG_DIR`/`CODEX_HOME`)가 set이면 존재 무관 그 위치(`<dir>/skills`)
///    — 사용자가 명시적으로 가리킨 곳이므로 존재를 따지지 않는다(스캔은 graceful).
/// 2. `XDG_CONFIG_HOME/<name>/skills`가 **존재하면** 그 경로 — 미존재 XDG 후보는 폴백한다(Linux에서
///    XDG_CONFIG_HOME 상존이 dotfile을 가로채지 않도록 **존재 게이트**).
/// 3. 표준 dotfile `~/.<dotfile>/skills` 폴백(언제나 안정적 가드 루트).
///
/// HOME 미설정이면 빈 목록(전부 graceful — 스캔 0건, 가드는 모든 경로 거부).
///
/// **P1.5**: 도구 루트는 전부 `recursive=true`(중첩 카테고리 스킬 발견). Hermes 루트(`~/.hermes/skills`)
/// 추가. skm 자체 스토어(`~/.skills-manager/skills`)는 여기서 합성하지 않아 ROOTS에서 자동 제외된다
/// (대량 중복 방지 — 정본 Phase 1.5 #6).
pub(crate) fn resolve_skill_roots(env: &SkillRootEnv) -> Vec<SkillRoot> {
    let Some(home) = env.home.clone() else {
        return Vec::new();
    };
    let resolve = |override_dir: Option<&PathBuf>, xdg_name: &str, dotfile: &str| -> PathBuf {
        if let Some(dir) = override_dir {
            return dir.join("skills");
        }
        if let Some(xdg) = &env.xdg_config_home {
            let cand = xdg.join(xdg_name).join("skills");
            if cand.is_dir() {
                return cand;
            }
        }
        home.join(dotfile).join("skills")
    };
    vec![
        SkillRoot::recursive(
            SkillProvider::Claude,
            resolve(env.claude_config_dir.as_ref(), "claude", ".claude"),
            RECURSIVE_MAX_DEPTH,
        ),
        SkillRoot::recursive(
            SkillProvider::Codex,
            resolve(env.codex_home.as_ref(), "codex", ".codex"),
            RECURSIVE_MAX_DEPTH,
        ),
        // `.agents`는 도구 간 공유 발견 dir(Codex 태깅). 전용 override env 없음.
        SkillRoot::recursive(
            SkillProvider::Codex,
            resolve(None, "agents", ".agents"),
            RECURSIVE_MAX_DEPTH,
        ),
        SkillRoot::recursive(
            SkillProvider::Openclaw,
            resolve(None, "openclaw", ".openclaw"),
            RECURSIVE_MAX_DEPTH,
        ),
        // Hermes(P1.5): 대부분 카테고리 중첩(`<root>/<cat>/<skill>/SKILL.md`, 실측 depth 2~3). 전용
        // override env 없음 → dotfile만.
        SkillRoot::recursive(
            SkillProvider::Hermes,
            home.join(".hermes").join("skills"),
            RECURSIVE_MAX_DEPTH,
        ),
    ]
}

/// 환경(provider)별 감지 집계(C6 동일 ROOTS 소비). 동일 provider의 여러 루트(Codex=`.codex`+`.agents`)는
/// 하나로 집계: `present`=루트 중 하나라도 존재, `skill_count`=합, `root_path`=첫(주) 루트. provider
/// 출현 순서를 보존한다. 읽기 전용 — 외부 dir 무쓰기.
pub(crate) fn detect_skill_environments_core(roots: &[SkillRoot]) -> Vec<SkillEnvironment> {
    let scanned = scan_external_skills_core(roots);
    // provider 첫 출현 순서로 누적(주 루트=첫 루트). present는 루트별 OR 집계.
    let mut envs: Vec<SkillEnvironment> = Vec::new();
    for root in roots {
        let exists = std::fs::metadata(&root.path)
            .map(|m| m.is_dir())
            .unwrap_or(false);
        match envs.iter_mut().find(|e| e.provider == root.provider) {
            Some(e) => e.present = e.present || exists,
            None => envs.push(SkillEnvironment {
                provider: root.provider,
                present: exists,
                skill_count: 0,
                root_path: root.path.to_string_lossy().into_owned(),
            }),
        }
    }
    for s in &scanned {
        if let Some(e) = envs.iter_mut().find(|e| e.provider == s.provider) {
            e.skill_count += 1;
        }
    }
    // no-PII(C7): provider+present+count만 — root_path(절대경로)는 로그 금지.
    for e in &envs {
        tracing::debug!(target: "skills.detect", provider = ?e.provider, present = e.present, count = e.skill_count, "detected skill environment");
    }
    envs
}

/// 환경 감지: 설치된(존재하는) 스킬 환경 + provider별 스킬 수를 돌려준다(P1 사이드바 전용 소비자).
/// 동일 ROOTS(`skill_roots`) 소비 — 두 번째 루트 정의 없음(C6). 읽기 전용.
#[tauri::command]
#[specta::specta]
pub async fn detect_skill_environments(
    db: State<'_, Db>,
) -> Result<Vec<SkillEnvironment>, AppError> {
    Ok(detect_skill_environments_core(
        &skill_roots_db(db.inner()).await,
    ))
}

/// 사용자 설정 임의 스킬 루트 조회(P1.5 #3). `app_config`에서 JSON 배열을 읽는다 — 미설정/빈 값이면
/// 빈 vec. 읽기 전용(외부 dir 무쓰기). 로그는 count만(C7 — 절대 경로 금지).
#[tauri::command]
#[specta::specta]
pub async fn get_skill_user_roots(db: State<'_, Db>) -> Result<Vec<UserSkillRoot>, AppError> {
    read_user_skill_roots(db.inner()).await
}

/// 사용자 설정 임의 스킬 루트 저장(P1.5 #3). 각 경로는 **절대경로**여야 한다(상대경로 거부 — path-guard가
/// 의미 있으려면 필요). 존재하지 않는 dir은 허용(안전망: 곧 만들 dir). 동일 경로는 dedup. JSON 배열로
/// `app_config`에 영속한다(스키마 변경 없음). 외부 dir에 쓰지 않는다(설정만 저장 — 쓰기/설치는 Phase G).
#[tauri::command]
#[specta::specta]
pub async fn set_skill_user_roots(
    db: State<'_, Db>,
    roots: Vec<UserSkillRoot>,
) -> Result<(), AppError> {
    let cleaned = normalize_user_skill_roots(roots)?;
    let json = serde_json::to_string(&cleaned).map_err(|e| {
        AppError::terminal(
            "skills.user_roots_serialize",
            format!("사용자 스킬 루트를 직렬화하지 못했습니다: {e}"),
        )
    })?;
    set_config(db.inner(), KEY_USER_SKILL_ROOTS, &json)
        .await
        .map_err(AppError::from)?;
    // no-PII(C7): count만 — 사용자 절대 경로는 로그 금지.
    tracing::debug!(target: "skills.roots", count = cleaned.len(), "saved user skill roots");
    Ok(())
}

/// SKILL.md의 YAML frontmatter에서 name/description을 얕게 파싱한다(외부 의존 없이 라인 스캔).
/// frontmatter는 `---`로 감싼 첫 블록. 키는 `name:`/`description:`만 본다(따옴표 제거). 없으면 빈 값.
pub(crate) fn parse_frontmatter(content: &str) -> (Option<String>, Option<String>) {
    let mut lines = content.lines();
    // 첫 비공백 라인이 `---`여야 frontmatter.
    if lines.next().map(str::trim) != Some("---") {
        return (None, None);
    }
    let mut name = None;
    let mut description = None;
    for line in lines {
        let t = line.trim();
        if t == "---" {
            break; // frontmatter 끝.
        }
        if let Some(v) = t.strip_prefix("name:") {
            name = Some(unquote(v.trim()));
        } else if let Some(v) = t.strip_prefix("description:") {
            description = Some(unquote(v.trim()));
        }
    }
    (
        name.filter(|s| !s.is_empty()),
        description.filter(|s| !s.is_empty()),
    )
}

/// 양끝 따옴표(', ") 제거(YAML 스칼라 단순화).
fn unquote(s: &str) -> String {
    let s = s.trim();
    if (s.starts_with('"') && s.ends_with('"') && s.len() >= 2)
        || (s.starts_with('\'') && s.ends_with('\'') && s.len() >= 2)
    {
        s[1..s.len() - 1].to_string()
    } else {
        s.to_string()
    }
}

/// ROOTS의 `SKILL.md`를 스캔해 frontmatter(name/description) + provider + 경로를 모은다(읽기 전용).
/// roots **주입**(테스트는 tempdir roots → hermetic). 콘텐츠 해싱 없음(frontmatter-only). 파일은
/// 실행하지 않는다.
///
/// **P1.5 깊이**: `recursive=true` 루트는 바운디드 재귀로 중첩 카테고리 스킬(`<root>/<cat>/<skill>/`)까지
/// 발견한다 — 리프 규칙(SKILL.md를 가진 dir에서 하강 중단), `max_depth` 캡, `is_ignored_dir` 스킵,
/// 재귀 하강 중 심링크 미추적 + visited 사이클 가드(상세: `scan_root`).
///
/// 부분실패 정책(C6): per-root **skip-and-continue** — 부재/읽기불가 루트(또는 하위 dir)는 스킵하고
/// 나머지를 반환한다(전체 스캔 에러 없음).
pub(crate) fn scan_external_skills_core(roots: &[SkillRoot]) -> Vec<ExternalSkill> {
    let mut out: Vec<ExternalSkill> = Vec::new();
    for root in roots {
        let before = out.len();
        let mut visited: HashSet<PathBuf> = HashSet::new();
        scan_root(root.provider, &root.path, 1, root, &mut visited, &mut out);
        // no-PII(C7): provider+count만 기록 — 절대 경로/frontmatter 본문 금지.
        let root_count = out.len() - before;
        tracing::debug!(target: "skills.scan", provider = ?root.provider, count = root_count, "scanned skill root");
    }
    out.sort_by_key(|a| a.name.to_lowercase());
    out
}

/// `dir`의 직속 자식을 검사한다(`child_depth` = 그 자식들의 루트 기준 깊이). SKILL.md를 가진 자식 =
/// 스킬(**리프 규칙** — 기록 후 그 하위로 하강하지 않아 이중 카운트·무한 하강을 막는다). 그 외 자식은
/// `root.recursive`일 때만, 아래 가드 하에 재귀한다:
///  - **depth cap**: `child_depth >= max_depth`면 더 하강하지 않는다.
///  - **심링크 미추적**: 재귀 하강 중 심링크 dir은 따라가지 않는다(사이클 차단). 단 최상위/중간의 심링크
///    *스킬* dir는 위 리프 검사(`read_to_string`이 심링크를 따라감)에서 이미 수용된다(P0 동작 보존).
///  - **ignore**: `is_ignored_dir`(숨김 + node_modules/target/dist/vendor) — 레포 거대 트리 방어.
///  - **visited 사이클 가드**: 정규화 실경로 방문 셋(심링크 차단의 방어적 보강).
fn scan_root(
    provider: SkillProvider,
    dir: &Path,
    child_depth: usize,
    root: &SkillRoot,
    visited: &mut HashSet<PathBuf>,
    out: &mut Vec<ExternalSkill>,
) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return; // 부재/읽기불가 — graceful skip.
    };
    for entry in entries.flatten() {
        let child = entry.path();
        // is_dir()는 심링크를 따라가므로 심링크→dir도 통과하고, 깨진/비-dir 심링크는 SKILL.md 읽기에서
        // 자연 스킵된다. 명시적으로 is_symlink()도 수용해 의도를 드러낸다.
        if !(child.is_dir() || child.is_symlink()) {
            continue;
        }
        // 리프 규칙: SKILL.md를 가진 dir은 스킬 — 기록하고 하강하지 않는다.
        let skill_md = child.join("SKILL.md");
        if let Ok(content) = std::fs::read_to_string(&skill_md) {
            let (name, description) = parse_frontmatter(&content);
            let dir_name = child
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or("(unknown)")
                .to_string();
            out.push(ExternalSkill {
                name: name.unwrap_or(dir_name),
                description: description.unwrap_or_default(),
                path: skill_md.to_string_lossy().into_owned(),
                provider,
            });
            continue;
        }
        // 스킬 아님 — recursive 루트에서만 바운디드 하강.
        if !root.recursive || child_depth >= root.max_depth {
            continue;
        }
        // 재귀 하강 중 심링크는 따라가지 않는다(사이클 차단; 최상위 심링크 스킬 dir는 위 리프에서 수용).
        if child.is_symlink() {
            continue;
        }
        let name = child.file_name().and_then(|n| n.to_str()).unwrap_or("");
        if is_ignored_dir(name) {
            continue;
        }
        // visited 사이클 가드(실경로 정규화 실패 시 원본 경로로 폴백).
        let canon = std::fs::canonicalize(&child).unwrap_or_else(|_| child.clone());
        if !visited.insert(canon) {
            continue;
        }
        scan_root(provider, &child, child_depth + 1, root, visited, out);
    }
}

/// 외부 스킬 멀티루트 스캔(ROOTS의 `*/SKILL.md` frontmatter → name/description/path/provider).
/// 읽기 전용 브라우즈. 부재 루트는 스킵(graceful degrade) — 항상 가능분을 반환한다.
#[tauri::command]
#[specta::specta]
pub async fn scan_external_skills(db: State<'_, Db>) -> Result<Vec<ExternalSkill>, AppError> {
    Ok(scan_external_skills_core(&skill_roots_db(db.inner()).await))
}

/// 외부 스킬 파일 내용 읽기(~/.claude/skills 하위 SKILL.md만). 디렉터리 탈출 방지(가드). 토큰 무관.
#[tauri::command]
#[specta::specta]
pub async fn read_external_skill(db: State<'_, Db>, path: String) -> Result<String, AppError> {
    let roots = skill_roots_db(db.inner()).await;
    ensure_within_skills_dir_roots(&path, &roots)
        .map_err(|e| AppError::validation("skills.path_guard", e))?;
    std::fs::read_to_string(&path).map_err(|e| {
        AppError::terminal("skills.read_failed", format!("파일을 읽지 못했습니다: {e}"))
    })
}

/// 외부 스킬 파일 내용 쓰기(사용자 명시 액션 — 자기 파일 편집). ~/.claude/skills 하위만 허용(가드).
/// 실행하지 않는다(쓰기만). 외부 스킬을 work-radar가 자동 적용/실행하는 경로는 없다.
#[tauri::command]
#[specta::specta]
pub async fn write_external_skill(
    db: State<'_, Db>,
    path: String,
    content: String,
) -> Result<(), AppError> {
    let roots = skill_roots_db(db.inner()).await;
    ensure_within_skills_dir_roots(&path, &roots)
        .map_err(|e| AppError::validation("skills.path_guard", e))?;
    std::fs::write(&path, content).map_err(|e| {
        AppError::terminal(
            "skills.write_failed",
            format!("파일을 쓰지 못했습니다: {e}"),
        )
    })
}

/// 일반화된 path-guard(C1): `(.. 컴포넌트 없음) AND (basename==SKILL.md) AND (ROOTS 중 하나로 starts_with)`.
/// roots 주입으로 테스트 hermetic. roots가 비면(HOME 없음) 모든 경로 거부(안전).
pub(crate) fn ensure_within_skills_dir_roots(
    path: &str,
    roots: &[SkillRoot],
) -> Result<(), String> {
    let p = std::path::Path::new(path);
    // 디렉터리 탈출 방지: `..` 컴포넌트 거부. starts_with는 `..`를 해소하지 않아
    // `<root>/../../tmp/SKILL.md`처럼 root 접두를 공유하면서 탈출하는 경로가 통과하므로 별도 차단.
    if p.components().any(|c| c == std::path::Component::ParentDir) {
        return Err("경로에 '..'를 쓸 수 없습니다.".into());
    }
    if p.file_name().and_then(|n| n.to_str()) != Some("SKILL.md") {
        return Err("SKILL.md 파일만 읽고 쓸 수 있습니다.".into());
    }
    if !roots.iter().any(|r| p.starts_with(&r.path)) {
        return Err("스킬 루트 밖의 경로는 접근할 수 없습니다.".into());
    }
    Ok(())
}
