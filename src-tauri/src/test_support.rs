//! 真实文件系统测试的独立目录与 AppPaths fixture，不安装任何进程级状态。

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use crate::app_paths::AppPaths;

pub(crate) struct TempDir {
    path: PathBuf,
    parent: PathBuf,
}

impl TempDir {
    pub(crate) fn new() -> Self {
        let parent = std::env::temp_dir()
            .canonicalize()
            .expect("解析测试临时目录失败");
        let path = parent.join(format!(
            "kisaki-test-{}-{}",
            std::process::id(),
            uuid::Uuid::new_v4().simple()
        ));
        // 原子占用全新目录，绝不预先删除可能属于其他测试的路径。
        fs::create_dir(&path).expect("创建独立测试目录失败");
        Self { path, parent }
    }

    pub(crate) fn path(&self) -> &Path {
        &self.path
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let Ok(resolved) = self.path.canonicalize() else {
            return;
        };
        // 递归清理前核对绝对路径，拒绝被替换为指向别处的符号链接或 junction。
        if resolved != self.path || resolved.parent() != Some(self.parent.as_path()) {
            return;
        }
        if let Err(error) = fs::remove_dir_all(&resolved) {
            eprintln!("清理测试目录 {} 失败: {error}", resolved.display());
        }
    }
}

/// 使用共享路径的状态存活期间需保留 fixture；释放 fixture 才会清理其目录。
pub(crate) struct TempAppPaths {
    root: TempDir,
    paths: Arc<AppPaths>,
}

impl TempAppPaths {
    pub(crate) fn new() -> Self {
        let root = TempDir::new();
        let paths = AppPaths::new(
            root.path().join("characters"),
            root.path().join("logs"),
            root.path().join("backups"),
            root.path().join("sessions"),
            root.path().join("grants/workspace-grants.json"),
            root.path().join("execution-output"),
        )
        .expect("装配测试 AppPaths 失败");
        Self {
            root,
            paths: Arc::new(paths),
        }
    }

    pub(crate) fn root(&self) -> &Path {
        self.root.path()
    }

    pub(crate) fn paths(&self) -> &AppPaths {
        &self.paths
    }

    pub(crate) fn shared_paths(&self) -> Arc<AppPaths> {
        Arc::clone(&self.paths)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dropping_fixture_removes_only_its_own_directory() {
        let neighbor = TempDir::new();
        fs::write(neighbor.path().join("keep.txt"), "保留").unwrap();
        let owned;
        {
            let fixture = TempAppPaths::new();
            owned = fixture.root().to_path_buf();
            fs::write(fixture.paths().sessions_v2_file(), "会话数据").unwrap();
            assert!(owned.is_dir());
        }
        assert!(!owned.exists());
        assert_eq!(
            fs::read_to_string(neighbor.path().join("keep.txt")).unwrap(),
            "保留"
        );
    }
}
