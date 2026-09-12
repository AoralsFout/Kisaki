//! 检查 Rust 生产模块的状态归属；只断言 AST 边界，不固定源码文本或行数。

#[path = "support/architecture.rs"]
mod architecture;

use std::fs;
use std::path::Path;

use architecture::{check_sources, Sources, Violation};

fn collect_sources(root: &Path, directory: &Path, sources: &mut Sources) {
    for entry in fs::read_dir(directory).expect("应能读取 Rust 源码目录") {
        let path = entry.expect("应能读取源码目录项").path();
        if path.is_dir() {
            collect_sources(root, &path, sources);
        } else if path.extension().is_some_and(|extension| extension == "rs") {
            sources.insert(
                path.strip_prefix(root).unwrap().to_path_buf(),
                fs::read_to_string(&path).expect("Rust 源码应为 UTF-8"),
            );
        }
    }
}

fn diagnostics(violations: &[Violation]) -> String {
    violations
        .iter()
        .map(ToString::to_string)
        .collect::<Vec<_>>()
        .join("\n")
}

#[test]
fn production_state_is_assembled_only_at_composition_root() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR"));
    let mut sources = Sources::new();
    collect_sources(root, &root.join("src"), &mut sources);
    sources.insert(
        "build.rs".into(),
        fs::read_to_string(root.join("build.rs")).expect("应能读取构建入口"),
    );
    let violations = check_sources(&sources, &["src/lib.rs", "src/main.rs", "build.rs"]);
    assert!(violations.is_empty(), "{}", diagnostics(&violations));
}
fn fixture(files: &[(&str, &str)]) -> Vec<Violation> {
    let sources = files
        .iter()
        .map(|(path, source)| ((*path).into(), (*source).to_owned()))
        .collect();
    check_sources(&sources, &["src/lib.rs"])
}

fn assert_rejected(source: &str, rule: architecture::Rule) {
    let violations = fixture(&[("src/lib.rs", source)]);
    assert!(
        violations.iter().any(|violation| violation.rule == rule),
        "应拒绝 {rule:?}，实际诊断：\n{}\n输入：\n{source}",
        diagnostics(&violations)
    );
}

#[test]
fn rejects_module_and_function_local_global_state_including_aliases() {
    for source in [
        "static PATHS: std::sync::OnceLock<std::path::PathBuf> = std::sync::OnceLock::new();",
        "fn command() { static JOBS: std::sync::Mutex<Vec<String>> = std::sync::Mutex::new(Vec::new()); }",
        "static mut CANCELLED: bool = false;",
        "const CANCELLED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);",
        "use std::sync::{OnceLock as Once, Mutex as Lock}; type Registry = Once<Lock<Vec<String>>>; static JOBS: Registry = Once::new();",
        "fn command() { use std::sync::Mutex as Gate; type Registry = Gate<Vec<String>>; static JOBS: Registry = Gate::new(Vec::new()); }",
        "struct Hidden { paths: std::path::PathBuf } static STATE: Hidden = todo!();",
        "extern \"C\" { static mut JOBS: usize; }",
    ] {
        assert_rejected(source, architecture::Rule::GlobalState);
    }
}

#[test]
fn accepts_readonly_constants_and_the_single_log_write_lock() {
    let violations = fixture(&[
        (
            "src/lib.rs",
            r#"
            mod log;
            type Limit = u64;
            const TTL: std::time::Duration = std::time::Duration::from_secs(60);
            static LIMITS: [Limit; 2] = [1, 2];
            const LABELS: &[&str] = &["one", "two"];
            struct Limits { count: usize }
            static CONFIG: Limits = Limits { count: 3 };
            fn work() { let _local = std::sync::Mutex::new(Vec::<String>::new()); }
        "#,
        ),
        (
            "src/log.rs",
            r#"
            use std::sync::{Mutex as Gate, OnceLock as Once};
            type WriteLock = Once<Gate<()>>;
            fn log_write_lock() -> &'static Gate<()> {
                static LOCK: WriteLock = Once::new();
                LOCK.get_or_init(|| Gate::new(()))
            }
        "#,
        ),
    ]);
    assert!(violations.is_empty(), "{}", diagnostics(&violations));
}

#[test]
fn log_lock_exception_cannot_hide_business_state_or_extra_locks() {
    for source in [
        "fn log_write_lock() { static LOCK: std::sync::Mutex<Vec<String>> = std::sync::Mutex::new(Vec::new()); }",
        "fn another_function() { static LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(()); }",
        "fn log_write_lock() { static FIRST: std::sync::Mutex<()> = std::sync::Mutex::new(()); static SECOND: std::sync::Mutex<()> = std::sync::Mutex::new(()); }",
    ] {
        let violations = fixture(&[("src/lib.rs", "mod log;"), ("src/log.rs", source)]);
        assert!(
            violations.iter().any(|violation| violation.rule == architecture::Rule::GlobalState),
            "{}\n{source}", diagnostics(&violations)
        );
    }
    assert_rejected(
        "fn log_write_lock() { static LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(()); }",
        architecture::Rule::GlobalState,
    );
}

#[test]
fn rejects_common_global_macros_even_when_renamed_or_nested() {
    for source in [
        "std::thread_local! { static JOBS: std::cell::RefCell<Vec<String>> = Default::default(); }",
        "lazy_static::lazy_static! { static ref PATHS: std::path::PathBuf = Default::default(); }",
        "use std::thread_local as local; fn command() { local! { static JOBS: usize = 0; } }",
        "use lazy_static::lazy_static as cached; cached! { static ref JOBS: Vec<String> = Vec::new(); }",
    ] {
        assert_rejected(source, architecture::Rule::StateMacro);
    }
}
#[test]
fn rejects_state_construction_through_import_type_and_factory_aliases() {
    for source in [
        "fn command() { let _ = crate::command::ExecutionRegistry::new(paths, clock); }",
        "use crate::command::ExecutionRegistry as Registry; type State = Registry; fn command() { let _ = State::new(paths, clock); }",
        "use crate::app_paths::AppPaths as Paths; fn command() { let _ = Paths { logs_dir: logs }; }",
        "use crate::workspace_grants::WorkspaceGrants as Grants; fn command() { let _ = <Grants as Default>::default(); }",
        "use crate::command::ExecutionRegistry as Registry; fn command() { let _: Registry = Default::default(); }",
        "use crate::tts::TtsConnectionPool as Pool; fn command() { let constructor = Pool::new; }",
        "fn assemble() -> crate::app_paths::AppPaths { todo!() } use self::assemble as renamed; fn command() { let _ = renamed(); }",
        "fn command(app: App) { app.manage(state); }",
    ] {
        assert_rejected(source, architecture::Rule::ManagedAssembly);
    }
}

#[test]
fn allows_own_constructors_injection_and_the_bootstrap_entry() {
    let violations = fixture(&[
        (
            "src/lib.rs",
            r#"
            mod app_paths;
            mod composition_root;
            use crate::app_paths::AppPaths;
            fn run() { composition_root::setup(app); }
            fn command(paths: &AppPaths) -> &std::path::Path { AppPaths::logs_dir(paths) }
        "#,
        ),
        (
            "src/app_paths.rs",
            r#"
            pub struct AppPaths { logs: std::path::PathBuf }
            impl AppPaths {
                pub fn new(logs: std::path::PathBuf) -> Result<Self, Error> { Ok(Self { logs }) }
                pub fn logs_dir(&self) -> &std::path::Path { &self.logs }
            }
        "#,
        ),
        (
            "src/composition_root.rs",
            r#"
            use crate::app_paths::AppPaths;
            fn setup(app: &App) -> Result<AppPaths, Error> {
                let paths = AppPaths::new(app.path().app_data_dir()?)?;
                app.manage(paths);
                todo!()
            }
        "#,
        ),
    ]);
    assert!(violations.is_empty(), "{}", diagnostics(&violations));
}

#[test]
fn only_run_may_call_the_bootstrap_and_submodules_are_not_the_root() {
    for (root, source) in [
        ("mod composition_root; fn command() { composition_root::setup(app); }", "fn setup(app: &App) -> crate::app_paths::AppPaths { todo!() }"),
        ("mod composition_root;", "mod command { fn command() { crate::command::ExecutionRegistry::new(paths, clock); } }"),
    ] {
        let violations = fixture(&[("src/lib.rs", root), ("src/composition_root.rs", source)]);
        assert!(
            violations.iter().any(|violation| violation.rule == architecture::Rule::ManagedAssembly),
            "{}", diagnostics(&violations)
        );
    }
}

#[test]
fn rejects_production_test_branches_in_attributes_expressions_and_statements() {
    for source in [
        "#[cfg(not(test))] fn persist() {}",
        "#[cfg_attr(test, allow(dead_code))] fn persist() {}",
        "fn persist() { if cfg!(test) { return; } write(); }",
        "fn persist() { #[cfg(test)] return; write(); }",
        "#[cfg(any(test, windows))] fn persist() {}",
        "fn persist() { #[cfg(test)] fn shortcut() {} }",
    ] {
        assert_rejected(source, architecture::Rule::TestBranch);
    }
}

#[test]
fn excludes_test_declarations_and_unreachable_fixture_files() {
    let violations = fixture(&[
        (
            "src/lib.rs",
            r#"
            #[cfg(all(test, windows))] mod unavailable_test_file;
            #[cfg(test)] mod inline_tests { use super::*; static mut COUNTER: usize = 0; }
            #[test] fn isolated_test() { std::env::temp_dir(); }
            #[cfg(test)] fn helper() { std::env::temp_dir(); }
            mod file_tests;
            #[cfg(feature = "enabled")] fn production_feature() {}
        "#,
        ),
        (
            "src/file_tests.rs",
            "#![cfg(test)]\nstatic mut COUNTER: usize = 0;",
        ),
        (
            "src/fixture.rs",
            "这不是 Rust 源码，未被生产模块引用，不应扫描。",
        ),
        ("tests/fixture.rs", "static mut COUNTER: usize = 0;"),
    ]);
    assert!(violations.is_empty(), "{}", diagnostics(&violations));
}
#[test]
fn rejects_ambient_directory_apis_accessors_and_aliases() {
    for source in [
        "fn renamed_directory() -> std::path::PathBuf { todo!() }",
        "use std::path::Path as Location; fn paths() -> &'static Location { todo!() }",
        "use std::env as environment; use environment::temp_dir as fallback; fn command() { fallback(); }",
        "fn command() { let directory = std::env::current_dir; }",
        "use dirs as folders; fn command() { folders::data_dir(); }",
        "fn command(app: &App) { app.path().app_data_dir(); }",
        "use std::env::var_os as environment; fn command() { environment(\"APPDATA\"); }",
        "fn command() { let _ = env!(\"CARGO_MANIFEST_DIR\"); }",
    ] {
        assert_rejected(source, architecture::Rule::AmbientDirectory);
    }
}

#[test]
fn rejects_directory_fallbacks_even_inside_composition_root() {
    for expression in [
        "std::env::temp_dir()",
        "std::env::var_os(\"TEMP\")",
        "std::path::Path::new(\".\")",
        "app.path().app_data_dir().unwrap_or_else(|_| std::path::PathBuf::from(\"backup\"))",
        "app.path().app_data_dir().unwrap_or(std::path::PathBuf::new())",
        "app.path().app_data_dir().unwrap_or_default()",
    ] {
        let source = format!("fn setup(app: &App) {{ let _ = {expression}; }}");
        let violations = fixture(&[
            ("src/lib.rs", "mod composition_root;"),
            ("src/composition_root.rs", &source),
        ]);
        assert!(
            violations
                .iter()
                .any(|violation| violation.rule == architecture::Rule::AmbientDirectory),
            "应拒绝目录兜底：{expression}\n{}",
            diagnostics(&violations)
        );
    }
}

#[test]
fn checks_rust_expressions_inside_common_macros() {
    for source in [
        "fn command() { format!(\"{:?}\", { static STATE: std::sync::Mutex<()> = std::sync::Mutex::new(()); STATE }); }",
        "fn command() { serde_json::json!({\"nested\": [{\"paths\": std::env::temp_dir()}]}); }",
        "fn command() { matches!(value, _ if { std::env::temp_dir(); true }); }",
        "fn command() { vec![std::env::temp_dir(); 2]; }",
    ] {
        let violations = fixture(&[("src/lib.rs", source)]);
        assert!(
            violations.iter().any(|violation| matches!(violation.rule, architecture::Rule::GlobalState | architecture::Rule::AmbientDirectory)),
            "不应跳过宏内 Rust 表达式：\n{}\n{source}", diagnostics(&violations)
        );
    }
    for source in [
        "macro_rules! hidden { () => { static mut STATE: usize = 0; }; }",
        "fn command() { include!(\"hidden.rs\"); }",
        "unknown_item_macro!();",
    ] {
        assert_rejected(source, architecture::Rule::UninspectedMacro);
    }
}

#[test]
fn follows_nested_and_explicit_modules_for_every_platform() {
    let violations = fixture(&[
        (
            "src/lib.rs",
            "mod commands; #[cfg(unix)] #[path = \"platform/check.rs\"] mod platform;",
        ),
        ("src/commands/mod.rs", "mod jobs;"),
        ("src/commands/jobs.rs", "static mut JOBS: usize = 0;"),
        (
            "src/platform/check.rs",
            "fn command() { std::env::temp_dir(); }",
        ),
    ]);
    for (file, rule) in [
        ("src/commands/jobs.rs", architecture::Rule::GlobalState),
        (
            "src/platform/check.rs",
            architecture::Rule::AmbientDirectory,
        ),
    ] {
        assert!(
            violations
                .iter()
                .any(|violation| violation.file == Path::new(file)
                    && violation.rule == rule
                    && violation.line > 0
                    && violation.column > 0),
            "应检查 {file} 并报告位置：\n{}",
            diagnostics(&violations)
        );
    }
}

#[test]
fn missing_or_invalid_production_source_is_not_silently_ignored() {
    for source in ["mod missing;", "fn invalid("] {
        assert_rejected(source, architecture::Rule::Source);
    }
}
#[test]
fn unresolved_glob_imports_cannot_bypass_sensitive_alias_checks() {
    for source in [
        "use crate::app_paths::*; fn command() { AppPaths::new(paths); }",
        "mod aliases { pub use std::env::temp_dir as renamed; } use aliases::*; fn command() { renamed(); }",
    ] {
        assert_rejected(source, architecture::Rule::Source);
    }
}
#[test]
fn rejects_ufcs_management_and_tuple_constructor_paths_outside_root() {
    for source in [
        "fn command(app: &App) { tauri::Manager::manage(app, state); }",
        "use tauri::Manager as Owner; fn command(app: &App) { <App as Owner>::manage(app, state); }",
        "fn command() { let _ = crate::command::ExecutionRegistry(tasks); }",
    ] {
        assert_rejected(source, architecture::Rule::ManagedAssembly);
    }
}
#[test]
fn fallback_checks_do_not_reject_a_successful_directory_expression() {
    let violations = fixture(&[
        ("src/lib.rs", "mod composition_root;"),
        (
            "src/composition_root.rs",
            r#"
            fn setup(injected: &std::path::Path) {
                let _ = Some(std::path::PathBuf::from("resource"))
                    .unwrap_or_else(|| injected.to_path_buf());
                let _ = optional.map_or(injected.to_path_buf(), |_| std::path::PathBuf::from("resource"));
                let _ = optional_text.unwrap_or_default();
            }
        "#,
        ),
    ]);
    assert!(violations.is_empty(), "{}", diagnostics(&violations));
}
