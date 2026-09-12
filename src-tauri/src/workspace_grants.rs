//! 工作目录授权表：独立持有能力与真实持久化位置，不依赖 Tauri 或进程级授权状态。

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};

use crate::app_paths::AppPaths;

#[derive(Clone, Debug, Serialize, Deserialize)]
pub(crate) struct WorkspaceGrant {
    pub id: String,
    pub path: String,
}

pub(crate) struct WorkspaceGrants {
    paths: Arc<AppPaths>,
    grants: Mutex<HashMap<String, PathBuf>>,
}

impl WorkspaceGrants {
    /// 沿用既有加载规则：文件不可读或格式错误时为空表，只恢复仍为目录的记录。
    /// 加载不改写文件；签发与撤销必须真实提交成功后才修改本实例的授权。
    pub(crate) fn new(paths: Arc<AppPaths>) -> Self {
        let saved: HashMap<String, PathBuf> = fs::read_to_string(paths.workspace_grants_file())
            .ok()
            .and_then(|text| serde_json::from_str(&text).ok())
            .unwrap_or_default();
        Self {
            paths,
            grants: Mutex::new(
                saved
                    .into_iter()
                    .filter(|(_, path)| path.is_dir())
                    .collect(),
            ),
        }
    }

    /// 仅由原生目录选择器的生产适配器调用；不得把 WebView 提交的绝对根接到此入口。
    /// 同一路径每次选择都签发独立能力；持久化失败不返回能力，也不残留内存授权。
    pub(crate) fn grant_from_selection(&self, root: &Path) -> Result<WorkspaceGrant, String> {
        let canon = canonical_directory(root)?;
        let id = format!("ws_{}", uuid::Uuid::new_v4().simple());
        self.update(|grants| {
            grants.insert(id.clone(), canon.clone());
        })?;
        Ok(WorkspaceGrant {
            id,
            path: canon.to_string_lossy().into_owned(),
        })
    }

    /// 每次使用都重新解析目录，不把启动时的目录存在性当作永久事实。
    pub(crate) fn resolve(&self, id: &str) -> Result<PathBuf, String> {
        if id.trim().is_empty() {
            return Err("工作目录能力不能为空".to_string());
        }
        let path = self
            .grants
            .lock()
            .map_err(|_| "工作目录授权锁失败".to_string())?
            .get(id)
            .cloned()
            .ok_or_else(|| "工作目录授权不存在或已撤销，请重新选择工作区".to_string())?;
        canonical_directory(&path)
    }

    /// 只撤销指定能力，不按路径撤销其它能力；执行任务联动由调用方编排。
    pub(crate) fn revoke(&self, id: &str) -> Result<(), String> {
        self.update(|grants| {
            grants.remove(id);
        })
    }

    fn update(&self, change: impl FnOnce(&mut HashMap<String, PathBuf>)) -> Result<(), String> {
        let mut current = self
            .grants
            .lock()
            .map_err(|_| "工作目录授权锁失败".to_string())?;
        let mut next = current.clone();
        change(&mut next);
        self.persist(&next)?;
        *current = next;
        Ok(())
    }

    fn persist(&self, grants: &HashMap<String, PathBuf>) -> Result<(), String> {
        let file = self.paths.workspace_grants_file();
        if let Some(parent) = file.parent() {
            fs::create_dir_all(parent).map_err(|e| format!("创建授权目录失败: {}", e))?;
        }
        let text =
            serde_json::to_string(grants).map_err(|e| format!("序列化工作目录授权失败: {}", e))?;
        let tmp = file.with_extension("tmp");
        fs::write(&tmp, text).map_err(|e| format!("写入工作目录授权失败: {}", e))?;
        // 与会话持久化相同：直接原子替换，不能先删除旧文件而留下提交失败的丢数据窗口。
        fs::rename(&tmp, file).map_err(|e| format!("提交工作目录授权失败: {}", e))
    }
}

fn canonical_directory(root: &Path) -> Result<PathBuf, String> {
    let canon = root
        .canonicalize()
        .map_err(|e| format!("无法解析工作目录: {}", e))?;
    if !canon.is_dir() {
        return Err("工作目录无效或已不存在".to_string());
    }
    Ok(canon)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::fileio;
    use crate::test_support::{TempAppPaths, TempDir};

    fn saved_grants(fixture: &TempAppPaths) -> HashMap<String, PathBuf> {
        serde_json::from_slice(&fs::read(fixture.paths().workspace_grants_file()).unwrap()).unwrap()
    }

    #[test]
    fn capability_lifecycle_uses_real_files_and_preserves_response_shape() {
        let fixture = TempAppPaths::new();
        let root = TempDir::new();
        let grants = WorkspaceGrants::new(fixture.shared_paths());
        let grant = grants.grant_from_selection(root.path()).unwrap();
        assert!(grant.id.starts_with("ws_"));
        assert_eq!(grants.resolve(&grant.id).unwrap(), root.path());
        assert_eq!(
            serde_json::to_value(&grant).unwrap(),
            serde_json::json!({ "id": grant.id, "path": root.path().to_string_lossy() })
        );
        assert_eq!(saved_grants(&fixture).get(&grant.id).unwrap(), root.path());

        fileio::write_file(&grants, &grant.id, "notes/test.txt", "真实文件").unwrap();
        assert_eq!(
            fileio::read_file(&grants, &grant.id, "notes/test.txt").unwrap(),
            "真实文件"
        );
        fileio::revoke_workspace(&grants, &grant.id).unwrap();
        assert!(grants.resolve(&grant.id).unwrap_err().contains("已撤销"));
        assert!(fileio::read_file(&grants, &grant.id, "notes/test.txt").is_err());
        assert!(saved_grants(&fixture).is_empty());
        let restarted = WorkspaceGrants::new(fixture.shared_paths());
        assert!(restarted.resolve(&grant.id).is_err());
        assert_eq!(
            fs::read_to_string(root.path().join("notes/test.txt")).unwrap(),
            "真实文件"
        );
    }

    #[test]
    fn restart_restores_independent_capabilities_for_the_same_directory() {
        let fixture = TempAppPaths::new();
        let root = TempDir::new();
        let first;
        let second;
        {
            let grants = WorkspaceGrants::new(fixture.shared_paths());
            first = grants.grant_from_selection(root.path()).unwrap();
            second = grants.grant_from_selection(root.path()).unwrap();
            assert_ne!(first.id, second.id);
        }
        let restarted = WorkspaceGrants::new(fixture.shared_paths());
        assert_eq!(restarted.resolve(&first.id).unwrap(), root.path());
        assert_eq!(restarted.resolve(&second.id).unwrap(), root.path());
        restarted.revoke(&first.id).unwrap();
        assert!(restarted.resolve(&first.id).is_err());
        fileio::write_file(&restarted, &second.id, "survivor.txt", "独立授权").unwrap();

        let restarted_again = WorkspaceGrants::new(fixture.shared_paths());
        assert!(restarted_again.resolve(&first.id).is_err());
        assert_eq!(
            fileio::read_file(&restarted_again, &second.id, "survivor.txt").unwrap(),
            "独立授权"
        );
        restarted_again.revoke(&first.id).unwrap();
        assert_eq!(
            saved_grants(&fixture).len(),
            1,
            "重复撤销不能影响同路径其它能力"
        );
    }

    #[test]
    fn independently_constructed_states_do_not_share_mutable_grants() {
        let fixture = TempAppPaths::new();
        let other_fixture = TempAppPaths::new();
        let root = TempDir::new();
        let first = WorkspaceGrants::new(fixture.shared_paths());
        let same_file_snapshot = WorkspaceGrants::new(fixture.shared_paths());
        let other = WorkspaceGrants::new(other_fixture.shared_paths());
        let grant = first.grant_from_selection(root.path()).unwrap();
        assert!(same_file_snapshot.resolve(&grant.id).is_err());
        assert!(other.resolve(&grant.id).is_err());
        let other_grant = other.grant_from_selection(root.path()).unwrap();
        assert!(first.resolve(&other_grant.id).is_err());

        let reloaded = WorkspaceGrants::new(fixture.shared_paths());
        reloaded.revoke(&grant.id).unwrap();
        assert!(reloaded.resolve(&grant.id).is_err());
        assert_eq!(first.resolve(&grant.id).unwrap(), root.path());
        assert_eq!(other.resolve(&other_grant.id).unwrap(), root.path());
        assert_eq!(saved_grants(&other_fixture).len(), 1);
    }

    #[test]
    fn loading_preserves_legacy_format_and_filters_only_missing_directories() {
        let fixture = TempAppPaths::new();
        let root = TempDir::new();
        let regular_file = root.path().join("file.txt");
        fs::write(&regular_file, "不是目录").unwrap();
        let original = serde_json::json!({
            "legacy-id": root.path(),
            "non-directory": regular_file,
            "missing": root.path().join("missing"),
        });
        let text = serde_json::to_string(&original).unwrap();
        fs::write(fixture.paths().workspace_grants_file(), &text).unwrap();
        let grants = WorkspaceGrants::new(fixture.shared_paths());
        assert_eq!(grants.resolve("legacy-id").unwrap(), root.path());
        assert!(grants.resolve("non-directory").is_err());
        assert!(grants.resolve("missing").is_err());
        assert_eq!(
            fs::read_to_string(fixture.paths().workspace_grants_file()).unwrap(),
            text
        );
        grants.grant_from_selection(root.path()).unwrap();
        assert_eq!(saved_grants(&fixture).len(), 2);
    }

    #[test]
    fn loading_missing_unreadable_or_invalid_file_keeps_the_existing_empty_table_rule() {
        let fixture = TempAppPaths::new();
        let file = fixture.paths().workspace_grants_file();
        let missing = WorkspaceGrants::new(fixture.shared_paths());
        assert!(missing.resolve("unknown").is_err());
        assert!(!file.exists(), "加载不能悄悄写文件");
        fs::create_dir(file).unwrap();
        let unreadable = WorkspaceGrants::new(fixture.shared_paths());
        assert!(unreadable.resolve("unknown").is_err());
        fs::remove_dir(file).unwrap();
        for invalid in ["invalid json", "[]", "{\"id\":123}"] {
            fs::write(file, invalid).unwrap();
            let grants = WorkspaceGrants::new(fixture.shared_paths());
            assert!(grants.resolve("id").is_err());
            assert_eq!(fs::read_to_string(file).unwrap(), invalid);
        }
    }

    #[test]
    fn every_resolution_revalidates_the_directory() {
        let fixture = TempAppPaths::new();
        let root = fixture.root().join("workspace");
        fs::create_dir(&root).unwrap();
        let grants = WorkspaceGrants::new(fixture.shared_paths());
        let grant = grants.grant_from_selection(&root).unwrap();
        fs::remove_dir(&root).unwrap();
        assert!(grants.resolve(&grant.id).is_err());
        fs::write(&root, "替换成普通文件").unwrap();
        assert!(grants
            .resolve(&grant.id)
            .unwrap_err()
            .contains("工作目录无效"));
        assert!(grants.grant_from_selection(&root).is_err());
        assert!(grants.grant_from_selection(&root.join("missing")).is_err());
        assert!(grants.resolve(" \t").unwrap_err().contains("不能为空"));
        fs::remove_file(&root).unwrap();
        fs::create_dir(&root).unwrap();
        assert_eq!(grants.resolve(&grant.id).unwrap(), root);
    }

    #[test]
    fn failed_parent_creation_returns_error_without_leaking_a_grant() {
        let fixture = TempAppPaths::new();
        let root = TempDir::new();
        let grants = WorkspaceGrants::new(fixture.shared_paths());
        let parent = fixture.paths().workspace_grants_file().parent().unwrap();
        fs::remove_dir(parent).unwrap();
        fs::write(parent, "阻止创建授权目录").unwrap();
        let error = grants.grant_from_selection(root.path()).unwrap_err();
        assert!(error.contains("创建授权目录失败"));
        assert_eq!(fs::read_to_string(parent).unwrap(), "阻止创建授权目录");
        fs::remove_file(parent).unwrap();
        let successful = grants.grant_from_selection(root.path()).unwrap();
        let saved = saved_grants(&fixture);
        assert_eq!(saved.len(), 1, "失败的签发不能被下一次提交带入持久化文件");
        assert!(saved.contains_key(&successful.id));
    }

    #[test]
    fn failed_write_does_not_issue_or_revoke_capabilities() {
        let fixture = TempAppPaths::new();
        let root = TempDir::new();
        let grants = WorkspaceGrants::new(fixture.shared_paths());
        let original = grants.grant_from_selection(root.path()).unwrap();
        let before = fs::read(fixture.paths().workspace_grants_file()).unwrap();
        let tmp = fixture
            .paths()
            .workspace_grants_file()
            .with_extension("tmp");
        fs::create_dir(&tmp).unwrap();
        assert!(grants
            .grant_from_selection(root.path())
            .unwrap_err()
            .contains("写入工作目录授权失败"));
        assert!(grants
            .revoke(&original.id)
            .unwrap_err()
            .contains("写入工作目录授权失败"));
        assert_eq!(grants.resolve(&original.id).unwrap(), root.path());
        assert_eq!(
            fs::read(fixture.paths().workspace_grants_file()).unwrap(),
            before
        );
        assert!(WorkspaceGrants::new(fixture.shared_paths())
            .resolve(&original.id)
            .is_ok());
        fs::remove_dir(&tmp).unwrap();
        grants.grant_from_selection(root.path()).unwrap();
        assert_eq!(saved_grants(&fixture).len(), 2);
    }

    #[test]
    fn failed_commit_returns_error_and_preserves_the_destination() {
        let fixture = TempAppPaths::new();
        let root = TempDir::new();
        let grants = WorkspaceGrants::new(fixture.shared_paths());
        let file = fixture.paths().workspace_grants_file();
        fs::create_dir(file).unwrap();
        fs::write(file.join("keep.txt"), "不能被提交覆盖").unwrap();
        assert!(grants
            .grant_from_selection(root.path())
            .unwrap_err()
            .contains("提交工作目录授权失败"));
        assert!(grants
            .revoke("unknown")
            .unwrap_err()
            .contains("提交工作目录授权失败"));
        assert_eq!(
            fs::read_to_string(file.join("keep.txt")).unwrap(),
            "不能被提交覆盖"
        );
        fs::remove_file(file.join("keep.txt")).unwrap();
        fs::remove_dir(file).unwrap();
        let successful = grants.grant_from_selection(root.path()).unwrap();
        let saved = saved_grants(&fixture);
        assert_eq!(saved.len(), 1);
        assert!(saved.contains_key(&successful.id));
        assert!(!file.with_extension("tmp").exists());
    }

    #[cfg(windows)]
    #[test]
    fn locked_destination_keeps_old_authorization_file_on_failed_commit() {
        use std::os::windows::fs::OpenOptionsExt;

        let fixture = TempAppPaths::new();
        let root = TempDir::new();
        let grants = WorkspaceGrants::new(fixture.shared_paths());
        let original = grants.grant_from_selection(root.path()).unwrap();
        let file = fixture.paths().workspace_grants_file();
        let before = fs::read(file).unwrap();
        let locked = fs::OpenOptions::new()
            .read(true)
            .share_mode(0)
            .open(file)
            .unwrap();
        assert!(grants
            .grant_from_selection(root.path())
            .unwrap_err()
            .contains("提交工作目录授权失败"));
        assert!(grants
            .revoke(&original.id)
            .unwrap_err()
            .contains("提交工作目录授权失败"));
        assert_eq!(grants.resolve(&original.id).unwrap(), root.path());
        drop(locked);
        assert_eq!(fs::read(file).unwrap(), before);
        grants.grant_from_selection(root.path()).unwrap();
        assert_eq!(saved_grants(&fixture).len(), 2);
    }
}
