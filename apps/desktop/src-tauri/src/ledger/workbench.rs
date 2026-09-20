//! 工作台开着哪几格的存与取：文档内容不透明，只有渲染层读得懂，这里只保证它活过一次重启。

use tauri::State;

use crate::ledger::LocalIndex;
use poietica_ledger::execution::{read_index, write_index};
use poietica_problem::Problem;

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
