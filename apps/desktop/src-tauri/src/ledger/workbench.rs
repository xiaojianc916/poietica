//! 工作台开着哪几格——存一份，取一份。
//!
//! 这一侧不解释那份文档：标签指向的表面有哪些是渲染层的领域知识
//! （packages/workspace 的 surface-registry 是唯一注册处），原生没有判断依据，
//! 所以它在这里是一份不透明文档。这两条命令只保证它活过一次重启，不保证有意义——
//! 那由写下它的一侧保证，那也是唯一读得懂它的一侧。

use tauri::State;

use crate::ledger::LocalIndex;
use poietica_ledger::execution::{read_index, write_index};
use poietica_problem::Problem;

/// 上一次关掉时工作台开着什么。第一次启动是 None。
#[tauri::command]
#[specta::specta]
pub async fn workbench_session_load(
    index: State<'_, LocalIndex>,
) -> Result<Option<String>, Problem> {
    read_index(&index, |store| {
        store.workbench_session().map_err(crate::error::Error::from)
    })
    .await
    .map_err(Problem::from)
}

/// 记下工作台此刻开着什么。整份覆盖，不是增量。
#[tauri::command]
#[specta::specta]
pub async fn workbench_session_save(
    index: State<'_, LocalIndex>,
    document: String,
) -> Result<(), Problem> {
    write_index(&index, move |store| {
        store
            .set_workbench_session(&document)
            .map_err(crate::error::Error::from)
    })
    .await
    .map_err(Problem::from)
}
