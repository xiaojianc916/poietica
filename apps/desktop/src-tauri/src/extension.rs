//! 插件命令的 Tauri 组合边界：installed.json 的解释与写入归 plugin-host，这里只管 IPC、路径与暂存。

use std::fs;
use std::path::{Path, PathBuf};

use poietica_extension_native as extension;
use serde::{Deserialize, Serialize};
use specta::Type;
use tauri::{AppHandle, command};

use crate::agent::profile::{agent_home_directory, own_home_directory};
use crate::error::{Error, Result};
use crate::paths::marketplace_catalog;
use poietica_problem::Problem;

type PluginsCommandResult<T> = std::result::Result<T, Problem>;

const MAX_DOWNLOAD_BYTES: usize = 32 * 1024 * 1024;

/// 这几个名字都出自官方 data-locations 的目录图，不是我们起的。
const PLUGINS_DIRECTORY: &str = "plugins";
const MANAGED_DIRECTORY: &str = "managed";
const RECORD_FILE: &str = "installed.json";

/// 点开头：`is_safe_segment` 不接受它，所以暂存区不会被当成一个插件标识符。
const STAGING_DIRECTORY: &str = ".staging";

#[derive(Debug, Deserialize, Type)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum PluginFetch {
    #[serde(rename_all = "camelCase")]
    Directory { path: String },
    #[serde(rename_all = "camelCase")]
    Archive {
        url: String,
        subdirectory: Option<String>,
    },
}

#[derive(Debug, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct PluginStaged {
    pub staging_id: String,
    pub manifest_json: String,
}

#[derive(Debug, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct PluginCommitRequest {
    pub staging_id: String,
    pub plugin_id: String,
    pub subdirectory: Option<String>,
    pub source: String,
    pub original_source: Option<String>,
    pub installed_at: String,
}

/// 清单读不出时 manifest_json 是空串，这一条仍要交出：坏插件也必须在界面占一行。
#[derive(Debug, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct PluginPayload {
    pub plugin_id: String,
    pub manifest_json: String,
    pub enabled: bool,
    pub installed_at: Option<String>,
    pub source: String,
    pub original_source: Option<String>,
    pub disabled_mcp_servers: Vec<String>,
}

/// 用户在命令行装的插件，读自用户自家 home 的账；它们不参与受控会话，不得并进已安装列表。
#[derive(Debug, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ForeignPluginRecord {
    pub plugin_id: String,
    pub original_source: Option<String>,
}

#[derive(Debug, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ForeignPluginInventory {
    pub location: String,
    pub plugins: Vec<ForeignPluginRecord>,
}

pub(crate) fn plugin_failure(cause: impl std::fmt::Display) -> Error {
    log::warn!("extension operation failed: {cause}");

    Error::Plugin(cause.to_string())
}

fn store_root(app: &AppHandle) -> Result<PathBuf> {
    let directory = agent_home_directory(app)?.join(PLUGINS_DIRECTORY);

    fs::create_dir_all(&directory)?;

    Ok(directory)
}

fn record_file(app: &AppHandle) -> Result<PathBuf> {
    Ok(store_root(app)?.join(RECORD_FILE))
}

/// 认领那步是一次 rename，暂存区必须与 managed/ 同卷，故不放系统临时目录。
pub(crate) fn staging_root(app: &AppHandle) -> Result<PathBuf> {
    let directory = store_root(app)?.join(STAGING_DIRECTORY);

    fs::create_dir_all(&directory)?;

    Ok(directory)
}

/// plugin_id 在此验证 is_safe_segment——这是它唯一变成路径的地方。
fn managed_directory(app: &AppHandle, plugin_id: &str) -> Result<PathBuf> {
    if !extension::is_safe_segment(plugin_id) {
        return Err(Error::Validation(format!(
            "不是合法的插件标识符：{plugin_id}"
        )));
    }

    Ok(store_root(app)?.join(MANAGED_DIRECTORY).join(plugin_id))
}

fn ledger(app: &AppHandle) -> Result<extension::PluginInventory> {
    Ok(extension::PluginInventory::new(record_file(app)?))
}

pub(crate) async fn download(url: &str) -> Result<Vec<u8>> {
    let mut response = reqwest::get(url).await.map_err(plugin_failure)?;

    if !response.status().is_success() {
        return Err(plugin_failure(format!(
            "server answered {}",
            response.status()
        )));
    }

    let mut bytes = Vec::new();

    while let Some(chunk) = response.chunk().await.map_err(plugin_failure)? {
        if bytes.len() + chunk.len() > MAX_DOWNLOAD_BYTES {
            return Err(plugin_failure("payload exceeds the size limit"));
        }

        bytes.extend_from_slice(&chunk);
    }

    Ok(bytes)
}

pub(crate) fn discard_failed(staging: extension::Staging) {
    if let Err(cleanup) = staging.discard() {
        log::warn!("could not discard a failed staging directory: {cleanup}");
    }
}

pub(crate) async fn staged_fetch<T>(
    app: &AppHandle,
    fetch: PluginFetch,
    failure: impl Fn(String) -> Error,
    locate: impl FnOnce(&extension::Staging, Option<&str>) -> Result<T>,
) -> Result<T> {
    let bytes = match &fetch {
        PluginFetch::Archive { url, .. } => Some(download(url).await?),
        PluginFetch::Directory { .. } => None,
    };

    let staging = extension::Staging::create(&staging_root(app)?)
        .map_err(|cause| failure(cause.to_string()))?;

    let filled = match (&fetch, bytes.as_deref()) {
        (PluginFetch::Directory { path }, _) => {
            extension::copy_tree(Path::new(path), staging.path())
        }
        (PluginFetch::Archive { .. }, Some(payload)) => {
            extension::extract_zip(payload, staging.path())
        }
        (PluginFetch::Archive { url, .. }, None) => {
            return Err(failure(format!("no bytes for {url}")));
        }
    };

    if let Err(cause) = filled {
        discard_failed(staging);
        return Err(failure(cause.to_string()));
    }

    let subdirectory = match &fetch {
        PluginFetch::Archive { subdirectory, .. } => subdirectory.as_deref(),
        PluginFetch::Directory { .. } => None,
    };

    match locate(&staging, subdirectory) {
        Ok(value) => Ok(value),
        Err(cause) => {
            discard_failed(staging);
            Err(cause)
        }
    }
}

fn finish_staging(
    staging: &extension::Staging,
    subdirectory: Option<&str>,
) -> Result<PluginStaged> {
    let staging_id = staging.identifier().to_owned();

    extension::locate_root(staging.path(), subdirectory)
        .and_then(|root| {
            extension::manifest_in(&root).ok_or(extension::ExtensionError::ManifestMissing)
        })
        .map_err(plugin_failure)
        .and_then(|manifest| fs::read_to_string(manifest).map_err(Error::from))
        .map(|manifest_json| PluginStaged {
            staging_id,
            manifest_json,
        })
}

/// 装没装以账本为准，不扫目录：官方卸载只删记录、盘上留副本，扫目录会把刚卸载的显示成装着。
#[command]
#[specta::specta]
pub async fn plugins_list(app: AppHandle) -> PluginsCommandResult<Vec<PluginPayload>> {
    (|| -> Result<Vec<PluginPayload>> {
        let mut found = Vec::new();
        for entry in ledger(&app)?.installed().map_err(plugin_failure)? {
            let manifest_json = extension::manifest_in(&entry.root)
                .and_then(|path| fs::read_to_string(path).ok())
                .unwrap_or_default();
            found.push(PluginPayload {
                plugin_id: entry.plugin_id,
                manifest_json,
                enabled: entry.enabled,
                installed_at: entry.installed_at,
                source: entry.source,
                original_source: entry.original_source,
                disabled_mcp_servers: entry.disabled_mcp_servers,
            });
        }
        found.sort_by(|left, right| left.plugin_id.cmp(&right.plugin_id));
        Ok(found)
    })()
    .map_err(Problem::from)
}

/// 只读探测，不 create_dir_all——目录不归我们所有；返回 None 即受控 home 未生效，没有第二本账。
#[command]
#[specta::specta]
pub async fn plugins_foreign_list(
    app: AppHandle,
) -> PluginsCommandResult<Option<ForeignPluginInventory>> {
    (|| -> Result<Option<ForeignPluginInventory>> {
        let Some(home) = own_home_directory(&app)? else {
            return Ok(None);
        };
        let path = home.join(PLUGINS_DIRECTORY).join(RECORD_FILE);
        let location = path.to_string_lossy().into_owned();
        let plugins = extension::PluginInventory::new(path)
            .references()
            .map_err(plugin_failure)?
            .into_iter()
            .map(|entry| ForeignPluginRecord {
                plugin_id: entry.plugin_id,
                original_source: entry.original_source,
            })
            .collect();
        Ok(Some(ForeignPluginInventory { location, plugins }))
    })()
    .map_err(Problem::from)
}

#[command]
#[specta::specta]
pub async fn plugins_stage(
    app: AppHandle,
    fetch: PluginFetch,
) -> PluginsCommandResult<PluginStaged> {
    staged_fetch(&app, fetch, plugin_failure, finish_staging)
        .await
        .map_err(Problem::from)
}

/// 顺序不能反：先搬副本、后写账。反了会留下指向空气的记录，而 agent 会照着它装载。
#[command]
#[specta::specta]
pub async fn plugins_commit(
    app: AppHandle,
    request: PluginCommitRequest,
) -> PluginsCommandResult<()> {
    (|| -> Result<()> {
        let staging = extension::Staging::open(&staging_root(&app)?, &request.staging_id)
            .map_err(plugin_failure)?;
        let root = extension::locate_root(staging.path(), request.subdirectory.as_deref())
            .map_err(plugin_failure)?;
        let destination = managed_directory(&app, &request.plugin_id)?;
        staging
            .promote(&root, &destination)
            .map_err(plugin_failure)?;
        ledger(&app)?
            .upsert(extension::PluginInstall {
                plugin_id: request.plugin_id,
                root: destination,
                source: request.source,
                original_source: request.original_source,
                installed_at: request.installed_at,
            })
            .map_err(plugin_failure)
    })()
    .map_err(Problem::from)
}

#[command]
#[specta::specta]
pub async fn plugins_discard(app: AppHandle, staging_id: String) -> PluginsCommandResult<()> {
    (|| -> Result<()> {
        extension::Staging::open(&staging_root(&app)?, &staging_id)
            .and_then(extension::Staging::discard)
            .map_err(plugin_failure)
    })()
    .map_err(Problem::from)
}

#[command]
#[specta::specta]
pub async fn plugins_remove(app: AppHandle, plugin_id: String) -> PluginsCommandResult<()> {
    (|| -> Result<()> {
        ledger(&app)?.remove(&plugin_id).map_err(plugin_failure)?;
        let managed = managed_directory(&app, &plugin_id)?;
        if managed.exists() {
            fs::remove_dir_all(&managed)?;
        }
        Ok(())
    })()
    .map_err(Problem::from)
}

#[command]
#[specta::specta]
pub async fn plugins_set_enabled(
    app: AppHandle,
    plugin_id: String,
    enabled: bool,
) -> PluginsCommandResult<()> {
    ledger(&app)?
        .set_enabled(&plugin_id, enabled)
        .map_err(plugin_failure)
        .map_err(Problem::from)
}

/// 落点是官方的 `capabilities.mcpServers.<name>.enabled`，即 `/plugins mcp disable` 写的同一格。
#[command]
#[specta::specta]
pub async fn plugins_set_mcp_enabled(
    app: AppHandle,
    plugin_id: String,
    server: String,
    enabled: bool,
) -> PluginsCommandResult<()> {
    ledger(&app)?
        .set_mcp_enabled(&plugin_id, &server, enabled)
        .map_err(plugin_failure)
        .map_err(Problem::from)
}

#[command]
#[specta::specta]
pub async fn plugins_catalog_read(app: AppHandle) -> PluginsCommandResult<Option<String>> {
    (|| -> Result<Option<String>> {
        extension::read_optional(&marketplace_catalog(&app)?).map_err(plugin_failure)
    })()
    .map_err(Problem::from)
}

#[command]
#[specta::specta]
pub async fn plugins_catalog_refresh(app: AppHandle, url: String) -> PluginsCommandResult<String> {
    let fetched = download(&url).await.and_then(|bytes| {
        String::from_utf8(bytes)
            .map_err(|cause| plugin_failure(format!("catalog is not utf-8: {cause}")))
    });

    fetched
        .and_then(|contents| {
            extension::write_atomic(&marketplace_catalog(&app)?, &contents)
                .map_err(plugin_failure)
                .map(|()| contents)
        })
        .map_err(Problem::from)
}
