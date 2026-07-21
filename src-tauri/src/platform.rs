use std::{
    collections::HashSet,
    path::{Path, PathBuf},
};

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum HostOs {
    Macos,
    Windows,
    #[allow(dead_code)]
    Other,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum OptionalIntegration {
    Cmux,
    Hermes,
    Boule,
}

pub(crate) const fn current_host() -> HostOs {
    #[cfg(target_os = "macos")]
    {
        HostOs::Macos
    }
    #[cfg(target_os = "windows")]
    {
        HostOs::Windows
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        HostOs::Other
    }
}

pub(crate) const fn supports_integration(host: HostOs, _integration: OptionalIntegration) -> bool {
    matches!(host, HostOs::Macos)
}

pub(crate) fn home_dir() -> Option<PathBuf> {
    dirs::home_dir()
}

pub(crate) fn expand_home(path: &Path, home: Option<&Path>) -> PathBuf {
    let raw = path.to_string_lossy();
    let relative = raw.strip_prefix("~/").or_else(|| raw.strip_prefix(r"~\"));

    match (relative, home) {
        (Some(relative), Some(home)) => home.join(relative),
        _ => path.to_path_buf(),
    }
}

pub(crate) fn executable_file_names(
    name: &str,
    host: HostOs,
    pathext: Option<&str>,
) -> Vec<String> {
    if host != HostOs::Windows {
        return vec![name.to_owned()];
    }

    let mut names = Vec::new();
    let mut seen = HashSet::new();
    for extension in pathext.unwrap_or(".EXE;.CMD;.BAT;.COM").split(';') {
        let extension = extension
            .trim()
            .trim_start_matches('.')
            .to_ascii_lowercase();
        if extension.is_empty() {
            continue;
        }
        let candidate = format!("{name}.{extension}");
        if seen.insert(candidate.clone()) {
            names.push(candidate);
        }
    }
    if seen.insert(name.to_owned()) {
        names.push(name.to_owned());
    }
    names
}

pub(crate) fn executable_candidates(
    name: &str,
    known_paths: &[PathBuf],
    path_env: Option<&str>,
    appdata: Option<&Path>,
    host: HostOs,
    pathext: Option<&str>,
) -> Vec<PathBuf> {
    let file_names = executable_file_names(name, host, pathext);
    let mut candidates = Vec::new();
    let mut seen = HashSet::new();

    for path in known_paths {
        push_unique(&mut candidates, &mut seen, path.clone());
    }

    if host == HostOs::Windows {
        if let Some(appdata) = appdata {
            let npm_dir = appdata.join("npm");
            for file_name in &file_names {
                push_unique(&mut candidates, &mut seen, npm_dir.join(file_name));
            }
        }
    }

    if let Some(path_env) = path_env {
        let path_entries: Vec<PathBuf> = if host == HostOs::Windows {
            path_env
                .split(';')
                .filter(|entry| !entry.is_empty())
                .map(PathBuf::from)
                .collect()
        } else {
            std::env::split_paths(path_env).collect()
        };
        for directory in path_entries {
            for file_name in &file_names {
                push_unique(&mut candidates, &mut seen, directory.join(file_name));
            }
        }
    }

    let bare = PathBuf::from(name);
    if seen.remove(&bare) {
        candidates.retain(|candidate| candidate != &bare);
    }
    candidates.push(bare);
    candidates
}

pub(crate) fn process_executable_candidates(name: &str, known_paths: &[PathBuf]) -> Vec<PathBuf> {
    let path_env = std::env::var("PATH").ok();
    let appdata = std::env::var_os("APPDATA").map(PathBuf::from);
    let pathext = std::env::var("PATHEXT").ok();
    executable_candidates(
        name,
        known_paths,
        path_env.as_deref(),
        appdata.as_deref(),
        current_host(),
        pathext.as_deref(),
    )
}

fn push_unique(candidates: &mut Vec<PathBuf>, seen: &mut HashSet<PathBuf>, candidate: PathBuf) {
    if seen.insert(candidate.clone()) {
        candidates.push(candidate);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::{Path, PathBuf};

    #[test]
    fn windows_executable_names_follow_pathext_and_keep_bare_fallback() {
        assert_eq!(
            executable_file_names("codex", HostOs::Windows, Some(".EXE;.CMD;.BAT")),
            vec!["codex.exe", "codex.cmd", "codex.bat", "codex"]
        );
    }

    #[test]
    fn windows_candidates_include_npm_global_bin_and_path_entries() {
        let candidates = executable_candidates(
            "codex",
            &[],
            Some(r"C:\Tools;D:\Bin"),
            Some(Path::new(r"C:\Users\me\AppData\Roaming")),
            HostOs::Windows,
            Some(".EXE;.CMD;.BAT"),
        );

        assert!(candidates.contains(
            &Path::new(r"C:\Users\me\AppData\Roaming")
                .join("npm")
                .join("codex.cmd")
        ));
        assert!(candidates.contains(&Path::new(r"C:\Tools").join("codex.exe")));
        assert_eq!(candidates.last(), Some(&PathBuf::from("codex")));
    }

    #[test]
    fn unix_candidates_preserve_known_paths_and_bare_fallback() {
        let candidates = executable_candidates(
            "gh",
            &[PathBuf::from("/opt/homebrew/bin/gh")],
            Some("/usr/bin:/usr/local/bin"),
            None,
            HostOs::Macos,
            None,
        );

        assert_eq!(
            candidates.first(),
            Some(&PathBuf::from("/opt/homebrew/bin/gh"))
        );
        assert!(candidates.contains(&PathBuf::from("/usr/bin/gh")));
        assert_eq!(candidates.last(), Some(&PathBuf::from("gh")));
    }

    #[test]
    fn home_expansion_accepts_unix_and_windows_separators() {
        let home = Path::new(r"C:\Users\me");
        assert_eq!(
            expand_home(Path::new("~/.local/bin/ntn"), Some(home)),
            home.join(".local/bin/ntn")
        );
        assert_eq!(
            expand_home(Path::new(r"~\.codex\skills"), Some(home)),
            home.join(r".codex\skills")
        );
    }

    #[test]
    fn owner_only_integrations_are_unavailable_on_windows() {
        for integration in [
            OptionalIntegration::Cmux,
            OptionalIntegration::Hermes,
            OptionalIntegration::Boule,
        ] {
            assert!(!supports_integration(HostOs::Windows, integration));
            assert!(supports_integration(HostOs::Macos, integration));
        }
    }
}
