pub mod environment;
pub(crate) mod reconcile;
pub mod storage;

use crate::error::Result;
use crate::paths::create_projectless_workspace;
use poietica_problem::Problem;

#[specta::specta]
pub async fn workspace_create_projectless_root() -> std::result::Result<String, Problem> {
    (|| -> Result<String> {
        Ok(create_projectless_workspace()?
            .to_string_lossy()
            .into_owned())
    })()
    .map_err(Problem::from)
}
