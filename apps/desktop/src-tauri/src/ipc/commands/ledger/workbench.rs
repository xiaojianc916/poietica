//! 工作台开着哪几格 —— 存一份，取一份。
//!
//! 这一侧不解释那份文档。标签指向的表面有哪些是渲染层的领域知识
//! （packages/workspace 的 surface-registry 是它唯一的注册处），原生这边
//! 没有判断它对不对的依据，所以它在这里是一份不透明的文档而不是一个结构。
//!
//! 换句话说：这两条命令保证它活过一次重启，不保证它有意义 —— 后者由写下
//! 它的那一侧保证，那也是唯一读得懂它的一侧。

use tauri::State;

use crate::ipc::commands::ledger::local_index::{LocalIndex, persistence, read_index, write_index};
use poietica_problem::Problem;

/// 上一次关掉时工作台开着什么。第一次启动是 None。
///
/// # Errors
///
/// 库读不出时返回错误。
#[tauri::command]
#[specta::specta]
pub async fn workbench_session_load(
    index: State<'_, LocalIndex>,
) -> Result<Option<String>, Problem> {
    read_index(&index, |store| {
        store.workbench_session().map_err(persistence)
    })
    .await
    .map_err(Problem::from)
}

/// 记下工作台此刻开着什么。整份覆盖，不是增量。
///
/// # Errors
///
/// 库写不进时返回错误。
#[tauri::command]
#[specta::specta]
pub async fn workbench_session_save(
    index: State<'_, LocalIndex>,
    document: String,
) -> Result<(), Problem> {
    write_index(&index, move |store| {
        store.set_workbench_session(&document).map_err(persistence)
    })
    .await
    .map_err(Problem::from)
}
