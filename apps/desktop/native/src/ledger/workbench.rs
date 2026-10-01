//! 工作台开着哪几格的存与取：文档内容不透明，只有渲染层读得懂，这里只保证它活过一次重启。

use poietica_ledger::execution::{read_index, write_index};
use poietica_problem::Problem;

#[specta::specta]
pub async fn workbench_session_load() -> Result<Option<String>, Problem> {
    let index = crate::ledger::index()?;
    read_index(&index, |store| {
        store.workbench_session().map_err(crate::error::Error::from)
    })
    .await
    .map_err(Problem::from)
}

#[specta::specta]
pub async fn workbench_session_save(document: String) -> Result<(), Problem> {
    let index = crate::ledger::index()?;
    write_index(&index, move |store| {
        store
            .set_workbench_session(&document)
            .map_err(crate::error::Error::from)
    })
    .await
    .map_err(Problem::from)
}
