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

use serde::{Deserialize, Serialize};

use crate::path::{backups_dir, safe_join_rel};

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
    if s.is_empty() || s.contains('/') || s.contains('\\') || s.contains("..") {
        return Err("非法的会话 / 检查点 id".to_string());
    }
    Ok(())
}

fn session_dir(session_id: &str) -> Result<PathBuf, String> {
    safe_seg(session_id)?;
    Ok(backups_dir().join(session_id))
}

fn checkpoint_dir(session_id: &str, checkpoint_id: &str) -> Result<PathBuf, String> {
    safe_seg(session_id)?;
    safe_seg(checkpoint_id)?;
    Ok(backups_dir().join(session_id).join(checkpoint_id))
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
    session_id: String,
    checkpoint_id: String,
    root: String,
    rel_path: String,
) -> Result<(), String> {
    // 校验 root 已授权（与 fileio 一致），防止绕过授权直接读取任意文件到缓存
    crate::fileio::check_root(&root)?;

    let cp = checkpoint_dir(&session_id, &checkpoint_id)?;
    fs::create_dir_all(cp.join("blobs")).map_err(|e| format!("创建备份目录失败: {}", e))?;

    let mut mani = load_manifest(&cp);
    if mani.root.is_empty() {
        mani.root = root;
    }
    // 写时复制：已记录过则跳过，保留最早版本。
    if mani.entries.iter().any(|e| e.rel == rel_path) {
        return Ok(());
    }

    // 用清单记录的 root 解析源路径（首次即等于传入 root）。
    let src = safe_join_rel(Path::new(&mani.root), &rel_path)?;
    let (existed, blob) = if src.is_file() {
        let name = format!("{}.bak", mani.entries.len());
        fs::copy(&src, cp.join("blobs").join(&name)).map_err(|e| format!("备份失败: {}", e))?;
        (true, Some(name))
    } else {
        (false, None)
    };

    mani.entries.push(Entry {
        rel: rel_path,
        existed,
        blob,
    });
    save_manifest(&cp, &mani)?;
    // 顺手清理本会话过期的旧检查点，防止缓存无限膨胀
    prune_old_checkpoints(&cp);
    Ok(())
}

/// 回档：把给定检查点（**从新到旧**传入）的备份依次回放。
///
/// 从新到旧应用 ⇒ 最旧（目标点）最后写入并生效 ⇒ 文件回到「目标回合之前」的状态。
/// 回放后删除这些检查点目录（已消费）。
#[tauri::command]
pub(crate) fn agent_checkpoint_rollback(
    session_id: String,
    checkpoint_ids: Vec<String>,
) -> Result<(), String> {
    for cid in &checkpoint_ids {
        let cp = checkpoint_dir(&session_id, cid)?;
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
    for cid in &checkpoint_ids {
        if let Ok(cp) = checkpoint_dir(&session_id, cid) {
            let _ = fs::remove_dir_all(&cp);
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
fn prune_old_checkpoints(cp: &Path) {
    let Some(session_dir) = cp.parent() else { return };
    let max_age = CHECKPOINT_MAX_AGE_DAYS * 24 * 3600;
    let Ok(entries) = fs::read_dir(session_dir) else { return };
    for e in entries.flatten() {
        let p = e.path();
        if !p.is_dir() {
            continue;
        }
        let Some(name) = p.file_name().and_then(|n| n.to_str()) else { continue };
        if let Some(age) = checkpoint_age_seconds(name) {
            if age > max_age {
                eprintln!(
                    "[kisaki] 清理过期检查点（{} 天前）: {}",
                    age / 86400,
                    p.display()
                );
                let _ = fs::remove_dir_all(&p);
            }
        }
    }
}

/// 清空某会话的全部备份（会话删除 / 清空对话时调用）。
#[tauri::command]
pub(crate) fn agent_checkpoint_clear_session(session_id: String) -> Result<(), String> {
    let dir = session_dir(&session_id)?;
    if dir.exists() {
        fs::remove_dir_all(&dir).map_err(|e| format!("清理备份失败: {}", e))?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn checkpoint_age_seconds_parses_frontend_ids() {
        let now_ms = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_millis() as u64;
        // 刚创建
        let fresh = checkpoint_age_seconds(&format!("{}-abc123", now_ms));
        assert!(fresh.is_some() && fresh.unwrap() < 60);
        // 三天前
        let old = checkpoint_age_seconds(&format!("{}-xyz", now_ms - 3 * 86400 * 1000));
        assert!(old.is_some() && old.unwrap() > 2 * 86400);
        // 非法名 → 无法解析（跳过清理）
        assert!(checkpoint_age_seconds("not-a-timestamp").is_none());
    }

    #[test]
    fn prune_removes_only_old_checkpoints() {
        let session_dir = std::env::temp_dir().join(format!(
            "kisaki-backup-test-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&session_dir);
        fs::create_dir_all(&session_dir).unwrap();

        let now_ms = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_millis() as u64;
        // 一个 40 天前的旧检查点 + 一个刚创建的检查点
        let old_dir = session_dir.join(format!("{}-old", now_ms - 40 * 86400 * 1000));
        let fresh_dir = session_dir.join(format!("{}-fresh", now_ms));
        fs::create_dir_all(&old_dir).unwrap();
        fs::create_dir_all(&fresh_dir).unwrap();

        // 以 fresh 检查点路径触发清理
        prune_old_checkpoints(&fresh_dir);

        assert!(!old_dir.exists(), "过期检查点应被清理");
        assert!(fresh_dir.exists(), "新检查点不应被清理");

        let _ = fs::remove_dir_all(&session_dir);
    }
}
