//! 数据目录值对象：只公开只读路径，构造成功后才能交给调用方。

use std::error::Error;
use std::fmt;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};

#[derive(Debug)]
pub(crate) struct AppPaths {
    characters_dir: PathBuf,
    logs_dir: PathBuf,
    backups_dir: PathBuf,
    sessions_dir: PathBuf,
    workspace_grants_file: PathBuf,
    execution_output_dir: PathBuf,
}

impl AppPaths {
    /// 显式提供全部位置；准备失败时不返回可被托管的目录状态。
    pub(crate) fn new(
        characters_dir: PathBuf,
        logs_dir: PathBuf,
        backups_dir: PathBuf,
        sessions_dir: PathBuf,
        workspace_grants_file: PathBuf,
        execution_output_dir: PathBuf,
    ) -> Result<Self, AppPathsError> {
        let grants_parent = workspace_grants_file
            .parent()
            .filter(|parent| !parent.as_os_str().is_empty())
            .ok_or_else(|| AppPathsError {
                path: workspace_grants_file.clone(),
                source: io::Error::new(io::ErrorKind::InvalidInput, "授权表文件必须有父目录"),
            })?;
        for directory in [
            characters_dir.as_path(),
            logs_dir.as_path(),
            backups_dir.as_path(),
            sessions_dir.as_path(),
            grants_parent,
            execution_output_dir.as_path(),
        ] {
            fs::create_dir_all(directory).map_err(|source| AppPathsError {
                path: directory.to_path_buf(),
                source,
            })?;
        }
        Ok(Self {
            characters_dir,
            logs_dir,
            backups_dir,
            sessions_dir,
            workspace_grants_file,
            execution_output_dir,
        })
    }

    pub(crate) fn characters_dir(&self) -> &Path {
        &self.characters_dir
    }

    pub(crate) fn logs_dir(&self) -> &Path {
        &self.logs_dir
    }

    pub(crate) fn backups_dir(&self) -> &Path {
        &self.backups_dir
    }

    pub(crate) fn sessions_dir(&self) -> &Path {
        &self.sessions_dir
    }

    pub(crate) fn workspace_grants_file(&self) -> &Path {
        &self.workspace_grants_file
    }

    pub(crate) fn execution_output_dir(&self) -> &Path {
        &self.execution_output_dir
    }

    pub(crate) fn sessions_v2_file(&self) -> PathBuf {
        self.sessions_dir().join("sessions-v2.json")
    }

    pub(crate) fn legacy_sessions_file(&self) -> PathBuf {
        self.sessions_dir().join("sessions.json")
    }
}

#[derive(Debug)]
pub(crate) struct AppPathsError {
    path: PathBuf,
    source: io::Error,
}

impl fmt::Display for AppPathsError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            f,
            "准备数据目录 {} 失败: {}",
            self.path.display(),
            self.source
        )
    }
}

impl Error for AppPathsError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        Some(&self.source)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::{TempAppPaths, TempDir};

    #[test]
    fn construction_prepares_all_directories_without_creating_user_data() {
        let fixture = TempAppPaths::new();
        let paths = fixture.paths();
        for directory in [
            paths.characters_dir(),
            paths.logs_dir(),
            paths.backups_dir(),
            paths.sessions_dir(),
            paths.workspace_grants_file().parent().unwrap(),
            paths.execution_output_dir(),
        ] {
            assert!(directory.is_dir(), "目录应已就绪: {}", directory.display());
        }
        assert!(!paths.workspace_grants_file().exists());
        assert!(!paths.sessions_v2_file().exists());
        assert!(!paths.legacy_sessions_file().exists());
    }

    #[test]
    fn every_unavailable_directory_reports_its_path_and_os_cause() {
        for blocked_index in 0..6 {
            let root = TempDir::new();
            let locations = [
                root.path().join("characters"),
                root.path().join("logs"),
                root.path().join("backups"),
                root.path().join("sessions"),
                root.path().join("grants/workspace-grants.json"),
                root.path().join("execution-output"),
            ];
            let blocked = if blocked_index == 4 {
                locations[blocked_index].parent().unwrap().to_path_buf()
            } else {
                locations[blocked_index].clone()
            };
            fs::write(&blocked, "原有文件").unwrap();
            let [characters, logs, backups, sessions, grants, outputs] = locations;
            let error =
                AppPaths::new(characters, logs, backups, sessions, grants, outputs).unwrap_err();
            let cause = error.source().unwrap();
            assert!(cause
                .downcast_ref::<io::Error>()
                .unwrap()
                .raw_os_error()
                .is_some());
            let message = error.to_string();
            assert!(
                message.contains(&blocked.display().to_string()),
                "{message}"
            );
            assert!(message.contains(&cause.to_string()), "{message}");
            assert_eq!(fs::read_to_string(&blocked).unwrap(), "原有文件");
        }
    }

    #[test]
    fn preparing_existing_directories_preserves_user_data() {
        let fixture = TempAppPaths::new();
        let paths = fixture.paths();
        fs::write(paths.characters_dir().join("character.json"), "角色数据").unwrap();
        fs::write(paths.workspace_grants_file(), "授权记录").unwrap();
        fs::write(paths.sessions_v2_file(), "会话数据").unwrap();

        let reopened = AppPaths::new(
            paths.characters_dir().to_path_buf(),
            paths.logs_dir().to_path_buf(),
            paths.backups_dir().to_path_buf(),
            paths.sessions_dir().to_path_buf(),
            paths.workspace_grants_file().to_path_buf(),
            paths.execution_output_dir().to_path_buf(),
        )
        .unwrap();
        assert_eq!(
            fs::read_to_string(reopened.characters_dir().join("character.json")).unwrap(),
            "角色数据"
        );
        assert_eq!(
            fs::read_to_string(reopened.workspace_grants_file()).unwrap(),
            "授权记录"
        );
        assert_eq!(
            fs::read_to_string(reopened.sessions_v2_file()).unwrap(),
            "会话数据"
        );
    }

    #[test]
    fn workspace_grants_file_requires_an_explicit_parent_directory() {
        let root = TempDir::new();
        let error = AppPaths::new(
            root.path().join("characters"),
            root.path().join("logs"),
            root.path().join("backups"),
            root.path().join("sessions"),
            PathBuf::from("workspace-grants.json"),
            root.path().join("execution-output"),
        )
        .unwrap_err();
        assert!(error.to_string().contains("workspace-grants.json"));
        assert_eq!(
            error
                .source()
                .unwrap()
                .downcast_ref::<io::Error>()
                .unwrap()
                .kind(),
            io::ErrorKind::InvalidInput
        );
    }
}
