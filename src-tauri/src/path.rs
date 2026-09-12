//! 路径解析与安全校验；本模块不持有目录配置或可变授权状态。

use std::fs;
use std::path::{Path, PathBuf};

// 未迁移票的目录调用暂时保留再导出；兼容状态仅由组合根装配。
pub(crate) use crate::composition_root::{initialized_log_dir, log_dir};
// 保留既有 Tauri 命令的 Rust 返回类型路径，能力实现与状态归 WorkspaceGrants。
pub(crate) use crate::workspace_grants::WorkspaceGrant;

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
            Component::RootDir | Component::Prefix(_) => return Err("不允许绝对路径".to_string()),
            Component::Normal(name) if cfg!(windows) && name.to_string_lossy().contains(':') => {
                // Windows 加固：拒绝组件名中的 ':'（NTFS Alternate Data Stream 分隔符），
                // 避免把内容写进隐藏数据流 / 触发意外的 NTFS 语义。Unix 下 ':' 是合法字符，放行。
                return Err("路径组件不能包含 ':'（Windows 数据流）".to_string());
            }
            Component::Normal(_) => {}
            _ => {}
        }
    }

    let canonical_base = base
        .canonicalize()
        .map_err(|e| format!("无法解析工作目录 '{}': {}", base.display(), e))?;

    if !canonical_base.is_dir() {
        return Err("工作目录无效或已不存在".to_string());
    }

    // 逐层向下校验并解析符号链接，最终返回「已解析的已存在前缀 + 词法拼接的新建后缀」。
    //  - 组件是符号链接（含指向不存在目标的悬空链接）→ 必须能解析到基目录内；
    //  - 组件是普通已存在项 → 继续向下；
    //  - 组件不存在 → 之后的所有组件必然也是新建项，不可能再是符号链接，收尾。
    // 返回已解析路径（而非含符号链接的词法路径）能缩小 TOCTOU 窗口：返回后到真正
    // 读写前，即使中间某层链接被并发替换为指向外部的链接，也不会影响本次读写目标。
    let mut resolved = canonical_base.clone();
    let mut comps = rel_path.components();
    while let Some(comp) = comps.next() {
        if let Component::Normal(name) = comp {
            let next = resolved.join(name);
            match fs::symlink_metadata(&next) {
                Ok(_) => {
                    // 所有已存在的组件都解析真实路径，不依赖平台如何标记 junction。
                    // 悬空链接也会走到这里，并因无法 canonicalize 而明确拒绝。
                    let real = next.canonicalize().map_err(|e| {
                        format!("无法解析路径或符号链接 '{}': {}", next.display(), e)
                    })?;
                    if !real.starts_with(&canonical_base) {
                        return Err("路径越权访问被拒绝（符号链接指向工作目录之外）".to_string());
                    }
                    resolved = real;
                }
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                    // 首个不存在的组件之后只能是新建项，词法拼接已校验过的后缀。
                    resolved = next;
                    for rest in comps {
                        if let Component::Normal(name) = rest {
                            resolved = resolved.join(name);
                        }
                    }
                    break;
                }
                Err(error) => {
                    return Err(format!("无法检查路径 '{}': {}", next.display(), error));
                }
            }
        }
    }

    if !resolved.starts_with(&canonical_base) {
        return Err("路径越权访问被拒绝".to_string());
    }
    Ok(resolved)
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crate::test_support::TempDir;

    /// 跨平台真实目录链接 fixture，析构只删除链接本身，绝不递归访问目标。
    #[cfg(any(unix, windows))]
    pub(crate) struct DirectoryLink(PathBuf);

    #[cfg(any(unix, windows))]
    impl DirectoryLink {
        pub(crate) fn new(target: &Path, link: &Path) -> Self {
            #[cfg(unix)]
            std::os::unix::fs::symlink(target, link).unwrap();
            #[cfg(windows)]
            {
                // mklink /J 无需管理员权限；cmd 使用普通绝对路径而非 verbatim 前缀。
                let link_arg = link
                    .to_string_lossy()
                    .trim_start_matches(r"\\?\")
                    .to_string();
                let target_arg = target
                    .to_string_lossy()
                    .trim_start_matches(r"\\?\")
                    .to_string();
                let output = std::process::Command::new("cmd")
                    .args(["/C", "mklink", "/J"])
                    .arg(link_arg)
                    .arg(target_arg)
                    .current_dir(link.parent().unwrap())
                    .output()
                    .expect("mklink /J 执行失败");
                assert!(output.status.success(), "创建 junction 失败: {:?}", output);
            }
            Self(link.to_path_buf())
        }
    }

    #[cfg(any(unix, windows))]
    impl Drop for DirectoryLink {
        fn drop(&mut self) {
            #[cfg(unix)]
            let result = fs::remove_file(&self.0);
            #[cfg(windows)]
            let result = fs::remove_dir(&self.0);
            if let Err(error) = result {
                eprintln!("清理测试链接 {} 失败: {error}", self.0.display());
            }
        }
    }

    #[test]
    fn rejects_parent_dir_traversal() {
        let base = TempDir::new();
        for relative in ["../secret.txt", "a/../../secret.txt", ".."] {
            let error = safe_join_rel(base.path(), relative).unwrap_err();
            assert!(error.contains(".."), "应拒绝父目录路径: {relative}");
        }
    }

    #[test]
    fn rejects_absolute_paths() {
        let base = TempDir::new();
        let error = safe_join_rel(base.path(), &base.path().to_string_lossy()).unwrap_err();
        assert!(error.contains("绝对路径"));
        #[cfg(windows)]
        for absolute in [r"C:\outside.txt", r"\outside.txt", r"C:outside.txt"] {
            assert!(safe_join_rel(base.path(), absolute)
                .unwrap_err()
                .contains("绝对路径"));
        }
    }

    #[cfg(windows)]
    #[test]
    fn rejects_windows_alternate_data_streams() {
        let base = TempDir::new();
        assert!(safe_join_rel(base.path(), "file.txt:hidden")
            .unwrap_err()
            .contains("数据流"));
    }

    #[test]
    fn rejects_non_directory_base() {
        let base = TempDir::new();
        let regular_file = base.path().join("file.txt");
        fs::write(&regular_file, "不是目录").unwrap();
        assert!(safe_join_rel(&regular_file, "child.txt")
            .unwrap_err()
            .contains("工作目录无效"));
    }

    #[test]
    fn nested_existing_and_new_paths_work() {
        let base = TempDir::new();
        fs::create_dir_all(base.path().join("a/b")).unwrap();
        for relative in ["a/b", "a/b/new.txt", "x/y/z.txt"] {
            assert_eq!(
                safe_join_rel(base.path(), relative).unwrap(),
                base.path().join(relative)
            );
        }
        assert_eq!(safe_join_rel(base.path(), ".").unwrap(), base.path());
        assert_eq!(safe_join_rel(base.path(), "").unwrap(), base.path());
    }

    #[cfg(any(unix, windows))]
    #[test]
    fn rejects_symlink_or_junction_escape_for_existing_and_new_leaves() {
        let base = TempDir::new();
        let outside = TempDir::new();
        fs::write(outside.path().join("secret.txt"), "保留外部文件").unwrap();
        let _link = DirectoryLink::new(outside.path(), &base.path().join("link"));
        for relative in ["link/evil.txt", "link/secret.txt", "link"] {
            assert!(safe_join_rel(base.path(), relative)
                .unwrap_err()
                .contains("越权"));
        }
        assert_eq!(
            fs::read_to_string(outside.path().join("secret.txt")).unwrap(),
            "保留外部文件"
        );
    }

    #[cfg(any(unix, windows))]
    #[test]
    fn rejects_dangling_directory_links() {
        let base = TempDir::new();
        let target = base.path().join("target");
        fs::create_dir(&target).unwrap();
        let _link = DirectoryLink::new(&target, &base.path().join("dangling"));
        fs::remove_dir(&target).unwrap();
        assert!(safe_join_rel(base.path(), "dangling/leaf.txt")
            .unwrap_err()
            .contains("符号链接"));
    }

    #[cfg(any(unix, windows))]
    #[test]
    fn resolves_internal_directory_links_to_real_paths() {
        let base = TempDir::new();
        let real = base.path().join("real");
        fs::create_dir(&real).unwrap();
        let _link = DirectoryLink::new(&real, &base.path().join("link"));
        assert_eq!(
            safe_join_rel(base.path(), "link/f.txt").unwrap(),
            real.join("f.txt")
        );
    }

    #[cfg(unix)]
    #[test]
    fn rejects_external_and_dangling_file_symlinks() {
        let base = TempDir::new();
        let outside = TempDir::new();
        let target = outside.path().join("secret.txt");
        fs::write(&target, "外部文件").unwrap();
        std::os::unix::fs::symlink(&target, base.path().join("file-link")).unwrap();
        assert!(safe_join_rel(base.path(), "file-link")
            .unwrap_err()
            .contains("越权"));
        fs::remove_file(&target).unwrap();
        assert!(safe_join_rel(base.path(), "file-link")
            .unwrap_err()
            .contains("符号链接"));
    }
}
