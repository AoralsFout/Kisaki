use std::fs;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

// ─── 数据目录 ─────────────────────────────────────────
// 双路径策略：
//   dev  模式 → characters: <项目>/characters/（git 可追踪）, logs: 项目根/logs/
//   生产模式 → characters: app_data_dir/characters/,         logs: app_data_dir/logs/
// 不内置预置角色：生产模式首次启动 characters 为空，由用户通过「导入角色包」填充。
// run() 阶段通过 init_dirs 初始化两个 OnceLock。

static CHARACTERS_DIR: OnceLock<PathBuf> = OnceLock::new();
static LOGS_DIR: OnceLock<PathBuf> = OnceLock::new();
static BACKUPS_DIR: OnceLock<PathBuf> = OnceLock::new();
static SESSIONS_DIR: OnceLock<PathBuf> = OnceLock::new();

/// 初始化数据目录（在 tauri setup 阶段调用）
pub(crate) fn init_dirs(
    chars: PathBuf,
    logs: PathBuf,
    backups: PathBuf,
    sessions: PathBuf,
) -> Result<(), &'static str> {
    fs::create_dir_all(&chars).map_err(|_| "创建 characters 目录失败")?;
    fs::create_dir_all(&logs).map_err(|_| "创建 logs 目录失败")?;
    fs::create_dir_all(&backups).map_err(|_| "创建 backups 目录失败")?;
    fs::create_dir_all(&sessions).map_err(|_| "创建 sessions 目录失败")?;
    CHARACTERS_DIR
        .set(chars)
        .map_err(|_| "CHARACTERS_DIR already set")?;
    LOGS_DIR
        .set(logs)
        .map_err(|_| "LOGS_DIR already set")?;
    BACKUPS_DIR
        .set(backups)
        .map_err(|_| "BACKUPS_DIR already set")?;
    SESSIONS_DIR
        .set(sessions)
        .map_err(|_| "SESSIONS_DIR already set")?;
    Ok(())
}

pub(crate) fn characters_dir() -> PathBuf {
    CHARACTERS_DIR
        .get()
        .expect("CHARACTERS_DIR 未初始化")
        .clone()
}

pub(crate) fn log_dir() -> PathBuf {
    let dir = LOGS_DIR
        .get()
        .expect("LOGS_DIR 未初始化")
        .clone();
    let _ = fs::create_dir_all(&dir);
    dir
}

/// AI 文件改动备份根目录（app_cache_dir/backups）。
pub(crate) fn backups_dir() -> PathBuf {
    let dir = BACKUPS_DIR
        .get()
        .expect("BACKUPS_DIR 未初始化")
        .clone();
    let _ = fs::create_dir_all(&dir);
    dir
}

/// 会话数据文件（聊天历史持久化，见 sessions.rs）
pub(crate) fn sessions_file() -> PathBuf {
    SESSIONS_DIR
        .get()
        .expect("SESSIONS_DIR 未初始化")
        .join("sessions.json")
}

/// 路径安全校验 — 防止 path traversal 攻击
///
/// 验证路径组件不包含 `..`、路径分隔符等危险字符。
pub(crate) fn sanitize_path_component(name: &str) -> Result<(), String> {
    if name.is_empty() {
        return Err("路径组件不能为空".to_string());
    }
    if name.contains("..") {
        return Err("路径组件不能包含 '..'".to_string());
    }
    if name.contains('/') || name.contains('\\') {
        return Err("路径组件不能包含分隔符".to_string());
    }
    Ok(())
}

/// 安全的路径拼接 — 确保最终路径在基目录下
///
/// 1. 校验每个路径组件不含 path traversal
/// 2. 规范化基目录
/// 3. 验证最终路径前缀在基目录内
pub(crate) fn safe_join(base: &Path, filename: &str) -> Result<PathBuf, String> {
    sanitize_path_component(filename)?;
    safe_join_rel(base, filename)
}

/// 安全拼接相对子路径 — 用于 AI 工作目录读写，支持多层子目录
///
/// 与 `safe_join` 不同，本函数允许 `a/b/c.txt` 形式的相对路径，
/// 但仍严格防护 path traversal：
/// 1. 拒绝绝对路径与含 `..` 的组件
/// 2. canonicalize 基目录
/// 3. 逐层向下解析：遇到已存在的符号链接（含 Windows junction / 悬空链接）
///    立即 canonicalize 并校验其真实目标仍在基目录内，否则拒绝。
///    这修复了旧实现的一个漏洞：当「目标文件不存在、但父级是符号链接」
///    时只做词法前缀校验，导致读写可经链接逃逸到基目录之外。
pub(crate) fn safe_join_rel(base: &Path, rel: &str) -> Result<PathBuf, String> {
    use std::path::Component;

    let rel_path = Path::new(rel);
    if rel_path.is_absolute() {
        return Err("不允许绝对路径".to_string());
    }
    for comp in rel_path.components() {
        match comp {
            Component::ParentDir => return Err("路径不能包含 '..'".to_string()),
            Component::RootDir | Component::Prefix(_) => {
                return Err("不允许绝对路径".to_string())
            }
            _ => {}
        }
    }

    let canonical_base = base
        .canonicalize()
        .map_err(|e| format!("无法解析工作目录 '{}': {}", base.display(), e))?;

    // 逐层向下校验：resolved 跟踪已解析的真实位置。
    //  - 组件是符号链接（含指向不存在目标的悬空链接）→ 必须能解析到基目录内；
    //  - 组件是普通已存在项 → 继续向下；
    //  - 组件不存在 → 之后的所有组件必然也是新建项，不可能再是符号链接，收尾。
    let mut resolved = canonical_base.clone();
    for comp in rel_path.components() {
        if let Component::Normal(name) = comp {
            let next = resolved.join(name);
            if next.is_symlink() {
                let real = next
                    .canonicalize()
                    .map_err(|e| format!("无法解析符号链接 '{}': {}", next.display(), e))?;
                if !real.starts_with(&canonical_base) {
                    return Err("路径越权访问被拒绝（符号链接指向工作目录之外）".to_string());
                }
                resolved = real;
            } else if next.exists() {
                resolved = next;
            } else {
                break;
            }
        }
    }

    // 逐层校验已保证所有已存在符号链接都指向基目录内，
    // 此处仍保留词法前缀兜底（防御未来逻辑改动）。
    let target = canonical_base.join(rel_path);
    if !target.starts_with(&canonical_base) {
        return Err("路径越权访问被拒绝".to_string());
    }
    Ok(target)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::PathBuf;

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "kisaki-path-test-{}-{}",
            name,
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn rejects_parent_dir_traversal() {
        let base = temp_dir("traversal");
        let err = safe_join_rel(&base, "../secret.txt").unwrap_err();
        assert!(err.contains(".."), "应拒绝 .. 路径，实际: {}", err);
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn rejects_absolute_paths() {
        let base = temp_dir("absolute");
        let abs = std::path::absolute(&base).unwrap();
        let abs_str = abs.to_string_lossy().into_owned();
        // 直接把绝对路径字符串传给 safe_join_rel，应该被拒绝
        let err = safe_join_rel(&base, &abs_str).unwrap_err();
        assert!(
            err.contains("绝对路径") || err.contains("不允许"),
            "应拒绝绝对路径，实际: {}",
            err
        );
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn nested_existing_and_new_paths_work() {
        let base = temp_dir("nested");
        fs::create_dir_all(base.join("a/b")).unwrap();

        // 已存在的目录
        let p = safe_join_rel(&base, "a/b").unwrap();
        assert!(p.starts_with(base.canonicalize().unwrap()));
        // 不存在的叶子文件（写入场景）
        let p = safe_join_rel(&base, "a/b/new.txt").unwrap();
        assert!(p.starts_with(base.canonicalize().unwrap()));
        // 多级不存在（创建父目录场景）
        let p = safe_join_rel(&base, "x/y/z.txt").unwrap();
        assert!(p.starts_with(base.canonicalize().unwrap()));

        let _ = fs::remove_dir_all(&base);
    }

    #[cfg(unix)]
    #[test]
    fn rejects_symlink_escape_when_leaf_does_not_exist() {
        use std::os::unix::fs::symlink;

        let base = temp_dir("escape");
        let outside = temp_dir("escape-outside");
        fs::create_dir_all(&outside).unwrap();
        symlink(&outside, base.join("link")).unwrap();

        // 旧实现漏洞场景：目标叶子不存在，但父级 link 指向 base 之外
        let err = safe_join_rel(&base, "link/evil.txt").unwrap_err();
        assert!(
            err.contains("越权") || err.contains("符号链接"),
            "父级符号链接指向外部应被拒绝，实际: {}",
            err
        );

        let _ = fs::remove_dir_all(&base);
        let _ = fs::remove_dir_all(&outside);
    }

    #[cfg(unix)]
    #[test]
    fn rejects_dangling_symlink() {
        use std::os::unix::fs::symlink;

        let base = temp_dir("dangling");
        symlink(base.join("not-exist-target"), base.join("dangling")).unwrap();

        let err = safe_join_rel(&base, "dangling").unwrap_err();
        assert!(
            err.contains("符号链接"),
            "悬空符号链接应被拒绝，实际: {}",
            err
        );
        let _ = fs::remove_dir_all(&base);
    }

    #[cfg(unix)]
    #[test]
    fn allows_symlink_inside_base() {
        use std::os::unix::fs::symlink;

        let base = temp_dir("inside");
        fs::create_dir_all(base.join("real")).unwrap();
        symlink(base.join("real"), base.join("link")).unwrap();

        let p = safe_join_rel(&base, "link/f.txt").unwrap();
        assert!(
            p.starts_with(base.canonicalize().unwrap()),
            "指向基目录内部的符号链接应放行"
        );
        let _ = fs::remove_dir_all(&base);
    }

    #[cfg(windows)]
    #[test]
    fn rejects_junction_escape_when_leaf_does_not_exist() {
        // Windows 目录联接（junction）无需管理员即可创建（mklink /J）
        let base = temp_dir("junction");
        let outside = temp_dir("junction-outside");
        fs::create_dir_all(&outside).unwrap();

        let status = std::process::Command::new("cmd")
            .args(["/C", "mklink", "/J"])
            .arg(base.join("link").to_string_lossy().as_ref())
            .arg(outside.to_string_lossy().as_ref())
            .status()
            .expect("mklink /J 执行失败");
        assert!(status.success(), "mklink /J 创建 junction 失败");

        let err = safe_join_rel(&base, "link/evil.txt").unwrap_err();
        assert!(
            err.contains("越权") || err.contains("符号链接"),
            "父级 junction 指向外部应被拒绝，实际: {}",
            err
        );

        let _ = fs::remove_dir_all(&base);
        let _ = fs::remove_dir_all(&outside);
    }
}
