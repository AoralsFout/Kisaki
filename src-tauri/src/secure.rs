//! 系统密钥链（OS Keychain）存取命令
//!
//! 用于存放 API Key 等敏感凭据，避免密钥与「加密主密钥」一起落在
//! localStorage / 数据文件里被本地攻击者一并取走。
//!
//! 后端由 `keyring` crate 提供：
//!   - Windows：Credential Manager（wincred）
//!   - macOS：Keychain
//!   - Linux：Secret Service（GNOME Keyring / KWallet，走 DBus）
//!
//! 任一平台不可用（如 Linux 无桌面密钥服务）时命令返回 Err，
//! 前端据此回退到本地加密存储。

use keyring::Entry;

/// 密钥链条目所属服务名（按 app identifier 命名，避免与其它应用冲突）
const KEYRING_SERVICE: &str = "com.kisaki.app";

fn entry(key: &str) -> Result<Entry, String> {
    Entry::new(KEYRING_SERVICE, key).map_err(|e| format!("访问系统密钥链失败: {}", e))
}

/// 写入一条凭据（不存在则创建，存在则覆盖）
#[tauri::command]
pub(crate) fn secure_store_set(key: String, value: String) -> Result<(), String> {
    entry(&key)?
        .set_password(&value)
        .map_err(|e| format!("写入系统密钥链失败: {}", e))
}

/// 读取一条凭据；条目不存在返回 null
#[tauri::command]
pub(crate) fn secure_store_get(key: String) -> Result<Option<String>, String> {
    match entry(&key)?.get_password() {
        Ok(v) => Ok(Some(v)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(format!("读取系统密钥链失败: {}", e)),
    }
}

/// 删除一条凭据；条目不存在视为成功
#[tauri::command]
pub(crate) fn secure_store_delete(key: String) -> Result<(), String> {
    match entry(&key)?.delete_password() {
        Ok(()) => Ok(()),
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(format!("删除系统密钥链条目失败: {}", e)),
    }
}
