pub mod environment;
pub(crate) mod reconcile;
pub mod storage;
pub mod table;

use crate::error::{Error, Result};
use crate::paths::create_projectless_workspace;
use poietica_problem::Problem;

/// 选目录是宿主能力：Electron 主进程有 dialog.showOpenDialog，原生侧没有窗口可挂对话框。
#[specta::specta]
pub async fn workspace_pick_root() -> std::result::Result<Option<String>, Problem> {
    // ponytail: 选目录/导出对话框是宿主能力，由 Electron 主进程的 dialog.showOpenDialog 提供（见 apps/desktop/electron/main.ts 的 pickRoot port）；这里不再自己弹。
    Err(Error::Internal("the folder chooser is the host's job".to_owned()).into())
}

#[specta::specta]
pub async fn workspace_create_projectless_root() -> std::result::Result<String, Problem> {
    (|| -> Result<String> {
        Ok(create_projectless_workspace()?
            .to_string_lossy()
            .into_owned())
    })()
    .map_err(Problem::from)
}
