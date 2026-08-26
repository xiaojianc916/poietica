//! 插件取用的 Tauri 组合层。
//!
//! agent 官方 `installed.json` 的形状、合并和开关语义由 `plugin-host` 持有；这里仅解参、
//! 调 host、读清单原文并映射 IPC DTO。插件清单的领域语义仍只在 `packages/plugins`。

use std::fs;
use std::path::{Path, PathBuf};

use poietica_plugin_host_native as host;
use serde::{Deserialize, Serialize};
use specta::Type;
use tauri::{AppHandle, command};

use crate::commands::agent_setup::profile::{agent_home_directory, own_home_directory};
use crate::error::{Error, IpcError, Result};
use crate::paths::marketplace_catalog;

type PluginsCommandResult<T> = std::result::Result<T, IpcError>;

const MAX_DOWNLOAD_BYTES: usize = 32 * 1024 * 1024;
const PLUGINS_DIRECTORY: &str = "plugins";
const MANAGED_DIRECTORY: &str = "managed";
const RECORD_FILE: &str = "installed.json";
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

#[derive(Debug, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ForeignPluginRecord {
    pub plugin_id: String,
    pub original_source: Option<String>,
}

#[derive(Debug, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ForeignPluginLedger {
    pub location: String,
    pub plugins: Vec<ForeignPluginRecord>,
}

fn plugin_failure(cause: impl std::fmt::Display) -> Error {
    log::warn!("plugin operation failed: {cause}");
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

/// 暂存与目标同卷，认领才能用一次原子 rename 完成。
pub(crate) fn staging_root(app: &AppHandle) -> Result<PathBuf> {
    let directory = store_root(app)?.join(STAGING_DIRECTORY);
    fs::create_dir_all(&directory)?;
    Ok(directory)
}

/// 不可信标识符只在变成路径的这一点验证。
fn managed_directory(app: &AppHandle, plugin_id: &str) -> Result<PathBuf> {
    if !host::is_safe_segment(plugin_id) {
        return Err(Error::Validation(format!(
            "不是合法的插件标识符：{plugin_id}"
        )));
    }

    Ok(store_root(app)?.join(MANAGED_DIRECTORY).join(plugin_id))
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

pub(crate) fn discard_failed(staging: host::Staging) {
    if let Err(cleanup) = staging.discard() {
        log::warn!("could not discard a failed staging directory: {cleanup}");
    }
}

/// 插件与技能共用的「来源 → 暂存」管线；差异只在 locate 回调。
pub(crate) async fn staged_fetch<T>(
    app: &AppHandle,
    fetch: PluginFetch,
    failure: impl Fn(String) -> Error,
    locate: impl FnOnce(&host::Staging, Option<&str>) -> Result<T>,
) -> Result<T> {
    let bytes = match &fetch {
        PluginFetch::Archive { url, .. } => Some(download(url).await?),
        PluginFetch::Directory { .. } => None,
    };
    let staging =
        host::Staging::create(&staging_root(app)?).map_err(|cause| failure(cause.to_string()))?;
    let filled = match (&fetch, bytes.as_deref()) {
        (PluginFetch::Directory { path }, _) => host::copy_tree(Path::new(path), staging.path()),
        (PluginFetch::Archive { .. }, Some(payload)) => host::extract_zip(payload, staging.path()),
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

fn finish_staging(staging: &host::Staging, subdirectory: Option<&str>) -> Result<PluginStaged> {
    let staging_id = staging.identifier().to_owned();

    host::locate_root(staging.path(), subdirectory)
        .and_then(|root| host::manifest_in(&root).ok_or(host::HostError::ManifestMissing))
        .map_err(plugin_failure)
        .and_then(|manifest| fs::read_to_string(manifest).map_err(Error::from))
        .map(|manifest_json| PluginStaged {
            staging_id,
            manifest_json,
        })
}

#[command]
#[specta::specta]
pub async fn plugins_list(app: AppHandle) -> PluginsCommandResult<Vec<PluginPayload>> {
    (|| -> Result<Vec<PluginPayload>> {
        let ledger = host::PluginLedger::read(&record_file(&app)?).map_err(plugin_failure)?;
        let mut found = Vec::new();

        for record in ledger.records().map_err(plugin_failure)? {
            let Some(root) = record.root else {
                log::warn!("installed.json 里 {} 没有 root", record.id);
                continue;
            };
            let manifest_json = host::manifest_in(&root)
                .and_then(|path| fs::read_to_string(path).ok())
                .unwrap_or_default();

            found.push(PluginPayload {
                plugin_id: record.id,
                manifest_json,
                enabled: record.enabled,
                installed_at: record.installed_at,
                source: record.source,
                original_source: record.original_source,
                disabled_mcp_servers: record.disabled_mcp_servers,
            });
        }

        found.sort_by(|left, right| left.plugin_id.cmp(&right.plugin_id));
        Ok(found)
    })()
    .map_err(IpcError::from)
}

#[command]
#[specta::specta]
pub async fn plugins_foreign_list(
    app: AppHandle,
) -> PluginsCommandResult<Option<ForeignPluginLedger>> {
    (|| -> Result<Option<ForeignPluginLedger>> {
        let Some(home) = own_home_directory(&app)? else {
            return Ok(None);
        };
        let path = home.join(PLUGINS_DIRECTORY).join(RECORD_FILE);
        let location = path.to_string_lossy().into_owned();
        let ledger = host::PluginLedger::read(&path).map_err(plugin_failure)?;
        let plugins = ledger
            .records()
            .map_err(plugin_failure)?
            .into_iter()
            .map(|record| ForeignPluginRecord {
                plugin_id: record.id,
                original_source: record.original_source,
            })
            .collect();

        Ok(Some(ForeignPluginLedger { location, plugins }))
    })()
    .map_err(IpcError::from)
}

#[command]
#[specta::specta]
pub async fn plugins_stage(
    app: AppHandle,
    fetch: PluginFetch,
) -> PluginsCommandResult<PluginStaged> {
    staged_fetch(&app, fetch, plugin_failure, finish_staging)
        .await
        .map_err(IpcError::from)
}

/// 副本先原子认领，账本后写；唯一中间态是不被 agent 装载的孤立副本。
#[command]
#[specta::specta]
pub async fn plugins_commit(
    app: AppHandle,
    request: PluginCommitRequest,
) -> PluginsCommandResult<()> {
    (|| -> Result<()> {
        let PluginCommitRequest {
            staging_id,
            plugin_id,
            subdirectory,
            source,
            original_source,
            installed_at,
        } = request;
        let staging =
            host::Staging::open(&staging_root(&app)?, &staging_id).map_err(plugin_failure)?;
        let root = host::locate_root(staging.path(), subdirectory.as_deref())
            .map_err(plugin_failure)?;
        let destination = managed_directory(&app, &plugin_id)?;

        staging
            .promote(&root, &destination)
            .map_err(plugin_failure)?;

        let path = record_file(&app)?;
        let mut ledger = host::PluginLedger::read(&path).map_err(plugin_failure)?;
        ledger
            .install(host::PluginInstallation {
                id: plugin_id,
                root: destination,
                source,
                original_source,
                installed_at,
            })
            .map_err(plugin_failure)?;
        ledger.write(&path).map_err(plugin_failure)
    })()
    .map_err(IpcError::from)
}

#[command]
#[specta::specta]
pub async fn plugins_discard(app: AppHandle, staging_id: String) -> PluginsCommandResult<()> {
    (|| -> Result<()> {
        host::Staging::open(&staging_root(&app)?, &staging_id)
            .and_then(host::Staging::discard)
            .map_err(plugin_failure)
    })()
    .map_err(IpcError::from)
}

/// 先销账再删托管副本；失败时 agent 最多看见不再引用的孤立字节。
#[command]
#[specta::specta]
pub async fn plugins_remove(app: AppHandle, plugin_id: String) -> PluginsCommandResult<()> {
    (|| -> Result<()> {
        let path = record_file(&app)?;
        let mut ledger = host::PluginLedger::read(&path).map_err(plugin_failure)?;
        let _removed = ledger.remove(&plugin_id).map_err(plugin_failure)?;
        ledger.write(&path).map_err(plugin_failure)?;

        let managed = managed_directory(&app, &plugin_id)?;
        if managed.exists() {
            fs::remove_dir_all(&managed)?;
        }
        Ok(())
    })()
    .map_err(IpcError::from)
}

#[command]
#[specta::specta]
pub async fn plugins_set_enabled(
    app: AppHandle,
    plugin_id: String,
    enabled: bool,
) -> PluginsCommandResult<()> {
    (|| -> Result<()> {
        let path = record_file(&app)?;
        let mut ledger = host::PluginLedger::read(&path).map_err(plugin_failure)?;
        ledger
            .set_enabled(&plugin_id, enabled)
            .map_err(plugin_failure)?;
        ledger.write(&path).map_err(plugin_failure)
    })()
    .map_err(IpcError::from)
}

#[command]
#[specta::specta]
pub async fn plugins_set_mcp_enabled(
    app: AppHandle,
    plugin_id: String,
    server: String,
    enabled: bool,
) -> PluginsCommandResult<()> {
    (|| -> Result<()> {
        let path = record_file(&app)?;
        let mut ledger = host::PluginLedger::read(&path).map_err(plugin_failure)?;
        ledger
            .set_mcp_enabled(&plugin_id, server, enabled)
            .map_err(plugin_failure)?;
        ledger.write(&path).map_err(plugin_failure)
    })()
    .map_err(IpcError::from)
}

#[command]
#[specta::specta]
pub async fn plugins_catalog_read(app: AppHandle) -> PluginsCommandResult<Option<String>> {
    (|| -> Result<Option<String>> {
        host::read_optional(&marketplace_catalog(&app)?).map_err(plugin_failure)
    })()
    .map_err(IpcError::from)
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
            host::write_atomic(&marketplace_catalog(&app)?, &contents)
                .map_err(plugin_failure)
                .map(|()| contents)
        })
        .map_err(IpcError::from)
}
