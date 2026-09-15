//! AI 文件改动的「检查点」备份 / 回档
//!
//! 模型：
//!   - 一个**检查点**对应一次用户消息触发的回合，checkpoint_id = 该用户消息的 id。
//!   - 改文件的工具执行前，把「原始文件」按需快照进缓存目录（**写时复制**：同一检查点对
//!     同一文件只保留最早的版本；同回合多次修改互不覆盖快照）。
//!   - 回档到某检查点 = 把它及其后所有检查点的备份**从新到旧**回放，使最旧（目标点）的
//!     「之前」状态最终生效。已消费的检查点目录随后删除。
//!
//! 目录结构（backups_dir = app_cache_dir/backups）：
//!   <backups>/<session_id>/<checkpoint_id>/
//!       manifest.json            { root, entries: [{ rel, existed, blob }] }
//!       blobs/<n>.bak            原始文件字节（existed=true 才有）
//!
//! 安全：rel 仍经 `safe_join_rel(manifest.root, rel)` 校验，blob 在我方缓存目录内、
//! 路径由本模块生成，非 LLM 提供。session_id / checkpoint_id 来自前端生成的 id，
//! 仍做一次分隔符 / `..` 防护。

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use serde::{Deserialize, Serialize};

use crate::app_paths::AppPaths;
use crate::path::safe_join_rel;
use crate::workspace_grants::WorkspaceGrants;

/// 单个检查点的清单。
#[derive(Serialize, Deserialize, Default)]
struct Manifest {
    /// 备份时的工作根（绝对路径）。回档按它还原，避免中途切换工作目录导致错位。
    root: String,
    entries: Vec<Entry>,
}

/// 清单中的一条文件记录。
#[derive(Serialize, Deserialize)]
struct Entry {
    /// 相对工作根的路径。
    rel: String,
    /// 备份时该文件是否已存在（false = 本回合新建，回档时应删除）。
    existed: bool,
    /// blob 文件名（existed=true 才有）。
    blob: Option<String>,
}

/// 校验 id 段不含分隔符 / `..`，防目录逃逸。
fn safe_seg(s: &str) -> Result<(), String> {
    if s.is_empty() || s == "." || s.contains('/') || s.contains('\\') || s.contains("..") {
        return Err("非法的会话 / 检查点 id".to_string());
    }
    Ok(())
}

fn backup_path(paths: &AppPaths, relative: &str) -> Result<PathBuf, String> {
    fs::create_dir_all(paths.backups_dir()).map_err(|e| format!("创建备份目录失败: {}", e))?;
    safe_join_rel(paths.backups_dir(), relative)
}

fn session_dir(paths: &AppPaths, session_id: &str) -> Result<PathBuf, String> {
    safe_seg(session_id)?;
    backup_path(paths, session_id)
}

fn checkpoint_dir(
    paths: &AppPaths,
    session_id: &str,
    checkpoint_id: &str,
) -> Result<PathBuf, String> {
    safe_seg(session_id)?;
    safe_seg(checkpoint_id)?;
    backup_path(paths, &format!("{session_id}/{checkpoint_id}"))
}

/// 递归删除前重新核对实际绝对位置，只允许清理注入备份根内的子目录。
fn remove_backup_dir(paths: &AppPaths, directory: &Path) -> Result<(), String> {
    let root = paths
        .backups_dir()
        .canonicalize()
        .map_err(|e| format!("解析备份目录失败: {}", e))?;
    let target = directory
        .canonicalize()
        .map_err(|e| format!("解析待清理目录失败: {}", e))?;
    if target == root || !target.starts_with(&root) {
        return Err("拒绝清理备份根之外的目录或备份根本身".to_string());
    }
    fs::remove_dir_all(&target).map_err(|e| format!("清理备份失败: {}", e))
}

fn load_manifest(cp: &Path) -> Manifest {
    let p = cp.join("manifest.json");
    match fs::read_to_string(&p) {
        Ok(s) => serde_json::from_str(&s).unwrap_or_default(),
        Err(_) => Manifest::default(),
    }
}

fn save_manifest(cp: &Path, mani: &Manifest) -> Result<(), String> {
    let p = cp.join("manifest.json");
    let s = serde_json::to_string(mani).map_err(|e| format!("序列化清单失败: {}", e))?;
    fs::write(&p, s).map_err(|e| format!("写入清单失败: {}", e))
}

/// 备份一个即将被修改的文件（写时复制，幂等）。
///
/// 由前端在「改文件」工具执行前调用。同一检查点内对同一 rel 第二次调用为 no-op，
/// 以保留该回合开始前的最早版本。
#[tauri::command]
pub(crate) fn agent_checkpoint_backup(
    paths: tauri::State<'_, Arc<AppPaths>>,
    grants: tauri::State<'_, Arc<WorkspaceGrants>>,
    session_id: String,
    checkpoint_id: String,
    workspace_id: String,
    rel_path: String,
) -> Result<(), String> {
    checkpoint_backup(
        &paths,
        &grants,
        &session_id,
        &checkpoint_id,
        &workspace_id,
        &rel_path,
    )
}

pub(crate) fn checkpoint_backup(
    paths: &AppPaths,
    grants: &WorkspaceGrants,
    session_id: &str,
    checkpoint_id: &str,
    workspace_id: &str,
    rel_path: &str,
) -> Result<(), String> {
    // 能力解析在后端完成，WebView 不能传任意绝对路径读取到缓存。
    let root = grants.resolve(workspace_id)?;

    let cp = checkpoint_dir(paths, session_id, checkpoint_id)?;
    fs::create_dir_all(cp.join("blobs")).map_err(|e| format!("创建备份目录失败: {}", e))?;

    let mut mani = load_manifest(&cp);
    if mani.root.is_empty() {
        mani.root = root.to_string_lossy().into_owned();
    }
    // 写时复制：已记录过则跳过，保留最早版本。
    if mani.entries.iter().any(|e| e.rel == rel_path) {
        return Ok(());
    }

    // 用清单记录的 root 解析源路径（首次即等于传入 root）。
    let src = safe_join_rel(Path::new(&mani.root), rel_path)?;
    let (existed, blob) = if src.is_file() {
        let name = format!("{}.bak", mani.entries.len());
        fs::copy(&src, cp.join("blobs").join(&name)).map_err(|e| format!("备份失败: {}", e))?;
        (true, Some(name))
    } else {
        (false, None)
    };

    mani.entries.push(Entry {
        rel: rel_path.to_string(),
        existed,
        blob,
    });
    save_manifest(&cp, &mani)?;
    // 顺手清理本会话过期的旧检查点，防止缓存无限膨胀
    prune_old_checkpoints(paths, &cp);
    Ok(())
}

/// 回档：把给定检查点（**从新到旧**传入）的备份依次回放。
///
/// 从新到旧应用 ⇒ 最旧（目标点）最后写入并生效 ⇒ 文件回到「目标回合之前」的状态。
/// 回放后删除这些检查点目录（已消费）。
#[tauri::command]
pub(crate) fn agent_checkpoint_rollback(
    paths: tauri::State<'_, Arc<AppPaths>>,
    session_id: String,
    checkpoint_ids: Vec<String>,
) -> Result<(), String> {
    checkpoint_rollback(&paths, &session_id, &checkpoint_ids)
}

pub(crate) fn checkpoint_rollback(
    paths: &AppPaths,
    session_id: &str,
    checkpoint_ids: &[String],
) -> Result<(), String> {
    for cid in checkpoint_ids {
        let cp = checkpoint_dir(paths, session_id, cid)?;
        if !cp.exists() {
            continue;
        }
        let mani = load_manifest(&cp);
        let base = PathBuf::from(&mani.root);
        // 工作根已不存在则无法还原，跳过该检查点（不阻断其它）。
        if !base.is_dir() {
            continue;
        }
        for e in &mani.entries {
            let target = match safe_join_rel(&base, &e.rel) {
                Ok(t) => t,
                Err(_) => continue,
            };
            if e.existed {
                if let Some(blob) = &e.blob {
                    if let Some(parent) = target.parent() {
                        let _ = fs::create_dir_all(parent);
                    }
                    fs::copy(cp.join("blobs").join(blob), &target)
                        .map_err(|err| format!("还原 {} 失败: {}", e.rel, err))?;
                }
            } else if target.is_file() {
                // 本回合新建的文件 → 回档删除。
                let _ = fs::remove_file(&target);
            }
        }
    }

    // 删除已消费的检查点目录。
    for cid in checkpoint_ids {
        if let Ok(cp) = checkpoint_dir(paths, session_id, cid) {
            let _ = remove_backup_dir(paths, &cp);
        }
    }
    Ok(())
}

/// 检查点保留策略：超过该天数的旧检查点会被自动清理。
/// 被清理的检查点无法再做文件回档（rollbackTo 对缺失目录会安全跳过），
/// 但 30 天前的文件回档诉求本就基本无效，换取 app_cache 不无限膨胀。
const CHECKPOINT_MAX_AGE_DAYS: u64 = 30;

/// 从检查点目录名解析年龄（秒）。目录名 = 前端消息 id（`<Date.now()>-<rand>`）。
fn checkpoint_age_seconds(dir_name: &str) -> Option<u64> {
    let ts_str = dir_name.split('-').next()?;
    let ts: u64 = ts_str.parse().ok()?;
    let now_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .ok()?
        .as_millis() as u64;
    Some(now_ms.saturating_sub(ts) / 1000)
}

/// 清理指定会话目录下超过年龄阈值的旧检查点（防止备份缓存无限膨胀）。
/// 在每次新增备份后调用。
fn prune_old_checkpoints(paths: &AppPaths, cp: &Path) {
    let Some(session_dir) = cp.parent() else {
        return;
    };
    let max_age = CHECKPOINT_MAX_AGE_DAYS * 24 * 3600;
    let Ok(entries) = fs::read_dir(session_dir) else {
        return;
    };
    for e in entries.flatten() {
        let p = e.path();
        if !p.is_dir() {
            continue;
        }
        let Some(name) = p.file_name().and_then(|n| n.to_str()) else {
            continue;
        };
        if let Some(age) = checkpoint_age_seconds(name) {
            if age > max_age {
                let _ = crate::log::write_native_log(
                    paths,
                    "info",
                    "Backup",
                    format!("清理过期检查点（{} 天前）: {}", age / 86400, p.display()),
                );
                let _ = remove_backup_dir(paths, &p);
            }
        }
    }
}

/// 清空某会话的全部备份（会话删除 / 清空对话时调用）。
#[tauri::command]
pub(crate) fn agent_checkpoint_clear_session(
    paths: tauri::State<'_, Arc<AppPaths>>,
    session_id: String,
) -> Result<(), String> {
    checkpoint_clear_session(&paths, &session_id)
}

pub(crate) fn checkpoint_clear_session(paths: &AppPaths, session_id: &str) -> Result<(), String> {
    let dir = session_dir(paths, session_id)?;
    if dir.exists() {
        remove_backup_dir(paths, &dir)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::fileio;
    use crate::test_support::{TempAppPaths, TempDir};

    fn now_millis() -> u64 {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_millis() as u64
    }

    #[test]
    fn checkpoints_restore_oldest_snapshot_and_remove_new_files_in_reverse_order() {
        let fixture = TempAppPaths::new();
        let root = TempDir::new();
        let grants = WorkspaceGrants::new(fixture.shared_paths());
        let grant = grants.grant_from_selection(root.path()).unwrap();
        let paths = fixture.paths();
        fileio::write_file(&grants, &grant.id, "nested/note.txt", "回合前").unwrap();
        checkpoint_backup(
            paths,
            &grants,
            "session",
            "older",
            &grant.id,
            "nested/note.txt",
        )
        .unwrap();
        fileio::write_file(&grants, &grant.id, "nested/note.txt", "第一次修改").unwrap();
        checkpoint_backup(
            paths,
            &grants,
            "session",
            "older",
            &grant.id,
            "nested/note.txt",
        )
        .unwrap();
        let older = paths.backups_dir().join("session/older");
        let manifest: serde_json::Value =
            serde_json::from_slice(&fs::read(older.join("manifest.json")).unwrap()).unwrap();
        assert_eq!(
            manifest,
            serde_json::json!({
                "root": root.path(),
                "entries": [{ "rel": "nested/note.txt", "existed": true, "blob": "0.bak" }],
            })
        );
        assert_eq!(
            fs::read_to_string(older.join("blobs/0.bak")).unwrap(),
            "回合前"
        );

        checkpoint_backup(
            paths,
            &grants,
            "session",
            "newer",
            &grant.id,
            "nested/note.txt",
        )
        .unwrap();
        checkpoint_backup(paths, &grants, "session", "newer", &grant.id, "created.txt").unwrap();
        fileio::write_file(&grants, &grant.id, "nested/note.txt", "第二次修改").unwrap();
        fileio::write_file(&grants, &grant.id, "created.txt", "本回合新建").unwrap();
        checkpoint_rollback(
            paths,
            "session",
            &["missing".into(), "newer".into(), "older".into()],
        )
        .unwrap();
        assert_eq!(
            fileio::read_file(&grants, &grant.id, "nested/note.txt").unwrap(),
            "回合前"
        );
        assert!(!root.path().join("created.txt").exists());
        assert!(!older.exists());
        assert!(!paths.backups_dir().join("session/newer").exists());
        checkpoint_rollback(paths, "session", &["older".into()]).unwrap();
    }

    #[test]
    fn rollback_preserves_manifest_root_and_stays_available_after_revocation() {
        let fixture = TempAppPaths::new();
        let root = TempDir::new();
        let other = TempDir::new();
        let grant_id;
        {
            let grants = WorkspaceGrants::new(fixture.shared_paths());
            let grant = grants.grant_from_selection(root.path()).unwrap();
            let other_grant = grants.grant_from_selection(other.path()).unwrap();
            fs::write(root.path().join("first.txt"), "原根第一份").unwrap();
            fs::write(root.path().join("second.txt"), "原根第二份").unwrap();
            fs::write(other.path().join("second.txt"), "新根不能被错位回档").unwrap();
            checkpoint_backup(
                fixture.paths(),
                &grants,
                "session",
                "checkpoint",
                &grant.id,
                "first.txt",
            )
            .unwrap();
            // 沿用既有模型：同一检查点继续使用首次清单中的工作根，不随本次选择切换。
            checkpoint_backup(
                fixture.paths(),
                &grants,
                "session",
                "checkpoint",
                &other_grant.id,
                "second.txt",
            )
            .unwrap();
            fs::write(root.path().join("first.txt"), "已改动").unwrap();
            fs::write(root.path().join("second.txt"), "已改动").unwrap();
            grant_id = grant.id;
            grants.revoke(&grant_id).unwrap();
            assert!(checkpoint_backup(
                fixture.paths(),
                &grants,
                "session",
                "checkpoint",
                &grant_id,
                "first.txt"
            )
            .is_err());
        }
        let restarted = WorkspaceGrants::new(fixture.shared_paths());
        assert!(restarted.resolve(&grant_id).is_err());
        // 回档的既有契约只有会话 / 检查点 id；它按真实清单恢复，不新增授权模型。
        checkpoint_rollback(fixture.paths(), "session", &["checkpoint".into()]).unwrap();
        assert_eq!(
            fs::read_to_string(root.path().join("first.txt")).unwrap(),
            "原根第一份"
        );
        assert_eq!(
            fs::read_to_string(root.path().join("second.txt")).unwrap(),
            "原根第二份"
        );
        assert_eq!(
            fs::read_to_string(other.path().join("second.txt")).unwrap(),
            "新根不能被错位回档"
        );
    }

    #[test]
    fn backup_rollback_and_session_cleanup_use_only_the_supplied_paths() {
        let first = TempAppPaths::new();
        let second = TempAppPaths::new();
        let first_root = TempDir::new();
        let second_root = TempDir::new();
        let first_grants = WorkspaceGrants::new(first.shared_paths());
        let second_grants = WorkspaceGrants::new(second.shared_paths());
        let first_id = first_grants
            .grant_from_selection(first_root.path())
            .unwrap()
            .id;
        let second_id = second_grants
            .grant_from_selection(second_root.path())
            .unwrap()
            .id;
        fs::write(first_root.path().join("note.txt"), "第一份").unwrap();
        fs::write(second_root.path().join("note.txt"), "第二份").unwrap();
        checkpoint_backup(
            first.paths(),
            &first_grants,
            "same-session",
            "same-checkpoint",
            &first_id,
            "note.txt",
        )
        .unwrap();
        checkpoint_backup(
            second.paths(),
            &second_grants,
            "same-session",
            "same-checkpoint",
            &second_id,
            "note.txt",
        )
        .unwrap();
        checkpoint_backup(
            first.paths(),
            &first_grants,
            "other-session",
            "checkpoint",
            &first_id,
            "note.txt",
        )
        .unwrap();
        fs::write(first_root.path().join("note.txt"), "第一份已改动").unwrap();
        fs::write(second_root.path().join("note.txt"), "第二份已改动").unwrap();
        checkpoint_rollback(first.paths(), "same-session", &["same-checkpoint".into()]).unwrap();
        assert_eq!(
            fs::read_to_string(first_root.path().join("note.txt")).unwrap(),
            "第一份"
        );
        assert_eq!(
            fs::read_to_string(second_root.path().join("note.txt")).unwrap(),
            "第二份已改动"
        );
        checkpoint_clear_session(first.paths(), "same-session").unwrap();
        checkpoint_clear_session(first.paths(), "same-session").unwrap();
        assert!(first
            .paths()
            .backups_dir()
            .join("other-session/checkpoint")
            .is_dir());
        assert!(second
            .paths()
            .backups_dir()
            .join("same-session/same-checkpoint")
            .is_dir());
        checkpoint_rollback(second.paths(), "same-session", &["same-checkpoint".into()]).unwrap();
        assert_eq!(
            fs::read_to_string(second_root.path().join("note.txt")).unwrap(),
            "第二份"
        );
        checkpoint_clear_session(first.paths(), "other-session").unwrap();
        assert!(!first.paths().backups_dir().join("other-session").exists());
    }

    #[test]
    fn backup_rejects_unavailable_storage_unsafe_paths_and_unknown_capabilities() {
        let fixture = TempAppPaths::new();
        let root = TempDir::new();
        let grants = WorkspaceGrants::new(fixture.shared_paths());
        let grant = grants.grant_from_selection(root.path()).unwrap();
        let paths = fixture.paths();
        assert!(checkpoint_backup(
            paths,
            &grants,
            "session",
            "checkpoint",
            "unknown",
            "note.txt"
        )
        .is_err());
        assert!(checkpoint_backup(
            paths,
            &grants,
            "session",
            "checkpoint",
            &grant.id,
            "../outside.txt"
        )
        .is_err());
        assert!(checkpoint_backup(
            paths,
            &grants,
            "session",
            "checkpoint",
            &grant.id,
            &root.path().to_string_lossy()
        )
        .is_err());
        for invalid in ["../outside", "a/b", "a\\b", ".", ""] {
            assert!(checkpoint_backup(
                paths,
                &grants,
                invalid,
                "checkpoint",
                &grant.id,
                "note.txt"
            )
            .is_err());
            assert!(
                checkpoint_backup(paths, &grants, "session", invalid, &grant.id, "note.txt")
                    .is_err()
            );
            assert!(checkpoint_rollback(paths, "session", &[invalid.into()]).is_err());
            assert!(checkpoint_clear_session(paths, invalid).is_err());
        }
        checkpoint_clear_session(paths, "session").unwrap();
        fs::remove_dir(paths.backups_dir()).unwrap();
        fs::write(paths.backups_dir(), "阻止创建备份目录").unwrap();
        assert!(checkpoint_backup(
            paths,
            &grants,
            "session",
            "checkpoint",
            &grant.id,
            "note.txt"
        )
        .unwrap_err()
        .contains("创建备份目录失败"));
        assert!(checkpoint_clear_session(paths, "session").is_err());
        assert_eq!(
            fs::read_to_string(paths.backups_dir()).unwrap(),
            "阻止创建备份目录"
        );
    }

    #[test]
    fn adding_a_backup_prunes_only_expired_checkpoints_in_its_own_session() {
        let fixture = TempAppPaths::new();
        let root = TempDir::new();
        let grants = WorkspaceGrants::new(fixture.shared_paths());
        let grant = grants.grant_from_selection(root.path()).unwrap();
        let paths = fixture.paths();
        let now = now_millis();
        let old_id = format!("{}-old", now - 40 * 86400 * 1000);
        let fresh_id = format!("{now}-fresh");
        let old = paths.backups_dir().join("session").join(&old_id);
        let other_session = paths.backups_dir().join("other-session").join(&old_id);
        let unparseable = paths.backups_dir().join("session/not-a-timestamp");
        fs::create_dir_all(&old).unwrap();
        fs::create_dir_all(&other_session).unwrap();
        fs::create_dir_all(&unparseable).unwrap();
        fs::write(old.join("old.txt"), "过期内容").unwrap();
        checkpoint_backup(paths, &grants, "session", &fresh_id, &grant.id, "new.txt").unwrap();
        assert!(!old.exists());
        assert!(paths.backups_dir().join("session").join(fresh_id).is_dir());
        assert!(other_session.is_dir());
        assert!(unparseable.is_dir());
        let files = crate::log::list_files(paths).unwrap();
        assert_eq!(files.len(), 1);
        let logs = serde_json::to_value(crate::log::read_file(paths, &files[0]).unwrap()).unwrap();
        assert_eq!(logs.as_array().unwrap().len(), 1);
        assert_eq!(logs[0]["schemaVersion"], 2);
        assert_eq!(logs[0]["level"], "info");
        assert_eq!(logs[0]["namespace"], "Backup");
        assert_eq!(logs[0]["source"], "Rust");
        assert_eq!(logs[0]["event"], "native.runtime_log");
        assert!(logs[0]["message"]
            .as_str()
            .unwrap()
            .starts_with("清理过期检查点（"));
        assert!(logs[0]["message"]
            .as_str()
            .unwrap()
            .contains(&old.display().to_string()));
        let other = TempAppPaths::new();
        assert!(crate::log::list_files(other.paths()).unwrap().is_empty());
    }

    #[cfg(any(unix, windows))]
    #[test]
    fn backup_rejects_external_links_and_rollback_skips_replaced_directory_links() {
        use crate::path::tests::DirectoryLink;

        let fixture = TempAppPaths::new();
        let root = TempDir::new();
        let outside = TempDir::new();
        let grants = WorkspaceGrants::new(fixture.shared_paths());
        let grant = grants.grant_from_selection(root.path()).unwrap();
        let nested = root.path().join("nested");
        fs::create_dir(&nested).unwrap();
        fs::write(nested.join("note.txt"), "原始内容").unwrap();
        fs::write(outside.path().join("note.txt"), "外部不可覆盖").unwrap();
        checkpoint_backup(
            fixture.paths(),
            &grants,
            "session",
            "checkpoint",
            &grant.id,
            "nested/note.txt",
        )
        .unwrap();
        fs::remove_file(nested.join("note.txt")).unwrap();
        fs::remove_dir(&nested).unwrap();
        let _link = DirectoryLink::new(outside.path(), &nested);
        assert!(checkpoint_backup(
            fixture.paths(),
            &grants,
            "session",
            "another",
            &grant.id,
            "nested/note.txt"
        )
        .unwrap_err()
        .contains("越权"));
        assert!(checkpoint_backup(
            fixture.paths(),
            &grants,
            "session",
            "another",
            &grant.id,
            "nested/new.txt"
        )
        .is_err());
        checkpoint_rollback(fixture.paths(), "session", &["checkpoint".into()]).unwrap();
        assert_eq!(
            fs::read_to_string(outside.path().join("note.txt")).unwrap(),
            "外部不可覆盖"
        );
        assert!(!outside.path().join("new.txt").exists());
    }

    #[cfg(any(unix, windows))]
    #[test]
    fn backup_and_recursive_cleanup_never_escape_the_injected_cache_through_links() {
        use crate::path::tests::DirectoryLink;

        let fixture = TempAppPaths::new();
        let root = TempDir::new();
        let outside = TempDir::new();
        let grants = WorkspaceGrants::new(fixture.shared_paths());
        let grant = grants.grant_from_selection(root.path()).unwrap();
        fs::write(outside.path().join("keep.txt"), "不能被递归清理").unwrap();
        let paths = fixture.paths();
        let _session_link =
            DirectoryLink::new(outside.path(), &paths.backups_dir().join("linked-session"));
        assert!(checkpoint_backup(
            paths,
            &grants,
            "linked-session",
            "checkpoint",
            &grant.id,
            "note.txt"
        )
        .is_err());
        assert!(checkpoint_rollback(paths, "linked-session", &["checkpoint".into()]).is_err());
        assert!(checkpoint_clear_session(paths, "linked-session").is_err());
        fs::create_dir(paths.backups_dir().join("session")).unwrap();
        let now = now_millis();
        let expired = paths
            .backups_dir()
            .join("session")
            .join(format!("{}-old", now - 40 * 86400 * 1000));
        let _expired_link = DirectoryLink::new(outside.path(), &expired);
        checkpoint_backup(
            paths,
            &grants,
            "session",
            &format!("{now}-fresh"),
            &grant.id,
            "note.txt",
        )
        .unwrap();
        assert_eq!(
            fs::read_to_string(outside.path().join("keep.txt")).unwrap(),
            "不能被递归清理"
        );
    }
}
