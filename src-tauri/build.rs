fn main() {
    // Windows MSVC: cargo test 실행 파일에는 tauri-build 매니페스트가 임베드되지 않아
    // Common Controls v6 선언 부재로 STATUS_ENTRYPOINT_NOT_FOUND(0xc0000139) 기동 실패.
    // 테스트 타깃에만(`-tests`) 매니페스트를 링크해 해결 — 메인 바이너리는 tauri-build 담당.
    // 참조: https://github.com/orgs/tauri-apps/discussions/11179
    let target_os = std::env::var("CARGO_CFG_TARGET_OS").unwrap_or_default();
    let target_env = std::env::var("CARGO_CFG_TARGET_ENV").unwrap_or_default();
    if target_os == "windows" && target_env == "msvc" {
        let manifest = std::env::current_dir()
            .expect("build.rs cwd")
            .join("windows-app-manifest.xml");
        println!("cargo:rerun-if-changed={}", manifest.display());
        println!("cargo:rustc-link-arg-tests=/MANIFEST:EMBED");
        println!(
            "cargo:rustc-link-arg-tests=/MANIFESTINPUT:{}",
            manifest.display()
        );
    }
    tauri_build::build()
}
