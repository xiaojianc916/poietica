//! 插件命令的 Tauri 组合边界。
//!
//! installed.json 的解释与写入由 plugin-host 独占；这里仅解析 IPC、组合路径、
//! 推进暂存目录并把宿主类型映射成 IPC 类型。

pub mod catalog_server;

use std::fs;
use std::path::{Path, PathBuf};

use poietica_extension_native as extension;
use serde::{Deserialize, Serialize};
use specta::Type;
use tauri::{AppHandle, command};

use crate::error::{Error, Result};
use crate::ipc::commands::cli::profile::{agent_home_directory, own_home_directory};
use crate::paths::marketplace_catalog;
use poietica_problem::Problem;

type PluginsCommandResult<T> = std::result::Result<T, Problem>;

/// 一次下载最多接受这么多字节。没有上限，一个坏掉的直链就能把内存吃光；逐块累加
/// 意味着服务器谎报 Content-Length 也没有用。
const MAX_DOWNLOAD_BYTES: usize = 32 * 1024 * 1024;

/// 这几个名字都出自官方 data-locations 的目录图，不是我们起的。
const PLUGINS_DIRECTORY: &str = "plugins";
const MANAGED_DIRECTORY: &str = "managed";
const RECORD_FILE: &str = "installed.json";

/// 点开头：`is_safe_segment` 不接受它，所以暂存区不会被当成一个插件标识符。
const STAGING_DIRECTORY: &str = ".staging";

/// 一次取用从哪里拿字节。
///
/// GitHub 不在这里出现：把仓库地址变成归档 URL 是领域侧的判断，由 packages/extension
/// 的 planFetch 做，判不出来的（默认分支）当场就说判不出来。
#[derive(Debug, Deserialize, Type)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum PluginFetch {
    #[serde(rename_all = "camelCase")]
    Directory { path: String },
    #[serde(rename_all = "camelCase")]
    Archive {
        url: String,
        /// 归档解开之后，插件根在里面的哪一层。目录型市场一个仓库装着多个插件，
        /// 不指名就只能猜。
        subdirectory: Option<String>,
    },
}

/// 已经解到暂存区、还没被认领的一份插件。
#[derive(Debug, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct PluginStaged {
    pub staging_id: String,
    /// 清单原文。这一层不解析它。
    pub manifest_json: String,
}

#[derive(Debug, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct PluginCommitRequest {
    pub staging_id: String,
    /// 渲染层解码清单之后判定的标识符，也就是官方记录里的 id。
    pub plugin_id: String,
    /// 取用时用的那一段子目录。认领的是清单所在的那一层，与取用时是同一层。
    pub subdirectory: Option<String>,
    /// 官方 InstalledRecord.source 的三个取值之一：local-path / zip-url / github。
    pub source: String,
    /// 人当初给的那一串地址。官方拿它显示来源，我们拿它回查目录里的背书。
    pub original_source: Option<String>,
    /// ISO-8601。时钟在领域层，不在这里 —— 原生侧没有理由持有第二个时间源。
    pub installed_at: String,
}

/// 账本里的一条，加上那条记录指向的清单原文。
///
/// 清单读不出来时 manifest_json 是空串，而这一条仍然交出去：一个装着却坏了的插件必须
/// 在界面上占一行，好让人看见原因。把它滤掉，人只会看到「我明明装了它却不见了」。
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

/// 用户在命令行上装的一个插件，按他自己那个家里的账本读出来。
///
/// 这不是「已安装」。我们开出去的会话把 home 变量指向受控 home，CLI 因此只装载受控
/// home 那本账里的插件；这一份里的东西一个都不参与会话。把两份合成一个列表，屏幕上
/// 就会有一半的行是假的。
#[derive(Debug, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ForeignPluginRecord {
    pub plugin_id: String,
    /// 人当初给命令行的那一串地址。缺席表示那条记录没记，导入因此没有起点。
    pub original_source: Option<String>,
}

/// 另一本账的现状：它在哪，以及里面有哪些插件。
///
/// 形状与 `EnvironmentFile` 同源 —— 界面要说得出自己读的是哪个文件，否则「别处已装」
/// 这句话没有落点。
#[derive(Debug, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ForeignPluginInventory {
    pub location: String,
    pub plugins: Vec<ForeignPluginRecord>,
}

/// 折成 IPC 上那条插件错误，并把真正的原因留在日志里。
///
/// 公共文案是脱敏的固定串（见 error.rs 的 public_message），原因不写进日志就等于
/// 丢了 —— 而排查插件装不上，靠的正是这句原因。
fn plugin_failure(cause: impl std::fmt::Display) -> Error {
    log::warn!("plugin operation failed: {cause}");

    Error::Plugin(cause.to_string())
}

/// agent 家里的插件仓库根。
fn store_root(app: &AppHandle) -> Result<PathBuf> {
    let directory = agent_home_directory(app)?.join(PLUGINS_DIRECTORY);

    fs::create_dir_all(&directory)?;

    Ok(directory)
}

fn record_file(app: &AppHandle) -> Result<PathBuf> {
    Ok(store_root(app)?.join(RECORD_FILE))
}

/// 安装中途的暂存区。
///
/// 放在 plugins/ 里面而不是系统临时目录：认领那一步是一次 rename，跨卷会失败，而
/// 系统临时目录经常在另一个卷上。
pub(crate) fn staging_root(app: &AppHandle) -> Result<PathBuf> {
    let directory = store_root(app)?.join(STAGING_DIRECTORY);

    fs::create_dir_all(&directory)?;

    Ok(directory)
}

/// 某一个插件的托管副本。
///
/// 标识符来自渲染层解码出来的清单，在拼路径的这一处验，而不是指望每个调用点自己
/// 记得验 —— 这是唯一一个把它变成路径的地方。
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

/// 丢弃一份失败的暂存。丢弃本身再失败也不能盖掉真正的原因，所以只进日志。
///
/// `discard` 拿走所有权：丢掉的那一份不该再被碰。
pub(crate) fn discard_failed(staging: extension::Staging) {
    if let Err(cleanup) = staging.discard() {
        log::warn!("could not discard a failed staging directory: {cleanup}");
    }
}

/// 取件管线，装插件与装技能共用：归档先取回字节，目录原样拷贝，都填进一个新建的
/// 暂存区。填充或 locate 失败就当场丢掉暂存 —— 留着一个永远不会被认领的目录，
/// 下次列举时它就是垃圾。差异点只有 locate：插件认清单，技能认 SKILL.md。
///
/// 归档拿不到字节是显式错误，不是不可达状态：下载那一步已经把成败说清了。
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

/// 暂存目录填好了，读出清单原文交回去。读不出来就报错，丢弃由 staged_fetch 统一负责。
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

/// 装了什么，agent 的账本说了算。
///
/// 不扫目录。官方卸载「only deletes the installation record; the managed copy and
/// original source files remain on disk」，所以盘上有一个目录不代表它装着 —— 扫目录会
/// 把刚卸载的插件重新显示成装着的，而 agent 那边不会装载它。
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

/// 用户在命令行上装的那些插件 —— 只读，一个字节都不写。
///
/// 不 create_dir_all：那个目录不归我们所有，探测一份不存在的账本不该在用户的 home 里
/// 留下一个空目录（`store_root` 会建目录，正因为那一个是我们自己的家）。
///
/// 返回 None 表示这台机器上没有第二本账：受控 home 没有生效时，CLI 与我们读的是同一个
/// 文件，而同一个文件没有「另一份」。
///
/// # Errors
///
/// 家目录算不出来、账本读不动、不是合法 JSON，或里面没有 plugins 数组时返回错误。
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

/// 认领：副本进 managed/<id>/，然后往账本里记一条。
///
/// 顺序不能反。副本在了但记录没写成，最坏是这个插件这一次没装上，重来一次即可；反过来
/// 先写记录再搬副本，中间失败就留下一条指向空气的记录，而 agent 会照着它去装载。
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

/// 卸载：账本里那一条去掉，托管副本一并删掉。
///
/// 官方只删记录、留副本。副本没有第二个读者 —— agent 只按记录装载 —— 留着它，换一个
/// 来源重装同一个 id 时，旧文件会混进新目录。删掉不改变 agent 观察到的任何行为。
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

/// 拨动整个插件。写的是 agent 会读的那一格，所以拨完在新会话里就是真的。
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

/// 拨动某个插件带来的一台 MCP 服务器。
///
/// 落点是官方的 `capabilities.mcpServers.<name>.enabled`，也就是 `/plugins mcp
/// disable` 写的同一格。
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

/// 拉一次市场目录，覆盖本地那一份，并把它交回去。
///
/// 这条命令不判断该不该拉 —— 那个判断是 packages/extension 的 shouldFetchOnOpen，
/// 属于状态机。这里只负责「拉了就覆盖」。
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
