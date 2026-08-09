//! 插件的取用、落盘与账目。
//!
//! 账本不是我们的。agent 自己的 CLI 按 `$KIMI_CODE_HOME/plugins/installed.json` 记着
//! 装了哪些插件、开没开、哪台 MCP 服务器被单独关掉（官方
//! packages/agent-core/src/plugin/store.ts 的 InstalledFile），托管副本在
//! `plugins/managed/<id>/`，官方文档逐字「the CLI always runs from this managed copy」。
//!
//! 此前我们在应用数据根下另建了一套同名的目录与账本。那份账没有第二个读者：界面照着
//! 它说「装好了」，会话里一个都不生效；反过来用户从对话里装的插件进了 agent 的家，
//! 界面一个都看不见。同一件事有两个真相，两个都是假的。
//!
//! 这个模块一个字节都不解释插件清单。唯一解析器是 packages/plugins 的
//! decodePluginManifest。账本这边只做两件事：按官方形状增删改那几格，以及原子写回。
//!
//! 改写走 serde_json::Value，不走一份对齐的 struct。官方记录里有 github.installedSha、
//! updatedAt 这类我们既不产出也不理解的字段，反序列化再写回等于每拨一次开关就把它们
//! 抹掉一次 —— 与 config.toml 那边用 toml_edit 而不是重新序列化是同一条理由。

use std::fs;
use std::path::{Path, PathBuf};

use poietica_plugin_host_native as host;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use specta::Type;
use tauri::{AppHandle, command};

use crate::commands::agent_setup::profile::agent_home_directory;
use crate::error::{Error, IpcError, Result};
use crate::paths::marketplace_catalog;

type PluginsCommandResult<T> = std::result::Result<T, IpcError>;

/// 一次下载最多接受这么多字节。没有上限，一个坏掉的直链就能把内存吃光；逐块累加
/// 意味着服务器谎报 Content-Length 也没有用。
const MAX_DOWNLOAD_BYTES: usize = 32 * 1024 * 1024;

/// 一次子树读取的上限。插件是外来内容：一个铺了几千份 Markdown 的目录会把渲染层的
/// 一次刷新变成几十兆字符串，而技能与命令的真实数量是几十条。超了报错，不截断 ——
/// 截断意味着界面上少了几条技能，却没有任何人知道少了。
const MAX_TREE_FILES: usize = 512;

const MAX_TREE_BYTES: usize = 8 * 1024 * 1024;

/// 这几个名字都出自官方 data-locations 的目录图，不是我们起的。
const PLUGINS_DIRECTORY: &str = "plugins";
const MANAGED_DIRECTORY: &str = "managed";
const RECORD_FILE: &str = "installed.json";

/// 点开头：`is_safe_segment` 不接受它，所以暂存区不会被当成一个插件标识符。
const STAGING_DIRECTORY: &str = ".staging";

/// 一次取用从哪里拿字节。
///
/// GitHub 不在这里出现：把仓库地址变成归档 URL 是领域侧的判断，由 packages/plugins
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

#[derive(Debug, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct PluginFileRequest {
    pub plugin_id: String,
    /// 相对插件根的路径，例如 systemPromptPath 指到的那份提示词。
    pub relative_path: String,
}

/// 一次子树取用要什么。
#[derive(Debug, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct PluginTreeRequest {
    pub plugin_id: String,
    /// 清单里声明的那条 ./ 路径。它可以指到目录，也可以直接指到一份文件。
    pub relative_path: String,
    /// 只要文件名以这个结尾的。技能与命令都是 .md，但「哪个后缀算数」是清单的语义，
    /// 由渲染层给 —— 这一层不认识技能，也不认识命令。
    pub suffix: String,
}

/// 插件根底下的一份文本文件。
#[derive(Debug, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct PluginFileText {
    /// 相对插件根，不是相对 relative_path —— 回头要重读它，还得从根算起。
    pub relative_path: String,
    pub contents: String,
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
fn staging_root(app: &AppHandle) -> Result<PathBuf> {
    let directory = store_root(app)?.join(STAGING_DIRECTORY);

    fs::create_dir_all(&directory)?;

    Ok(directory)
}

/// 某一个插件的托管副本。
///
/// 标识符来自渲染层解码出来的清单，在拼路径的这一处验，而不是指望每个调用点自己
/// 记得验 —— 这是唯一一个把它变成路径的地方。
fn managed_directory(app: &AppHandle, plugin_id: &str) -> Result<PathBuf> {
    if !host::is_safe_segment(plugin_id) {
        return Err(Error::Validation(format!(
            "不是合法的插件标识符：{plugin_id}"
        )));
    }

    Ok(store_root(app)?.join(MANAGED_DIRECTORY).join(plugin_id))
}

/// 读账本。文件不在就是「一个都没装」，那是常态不是错误（官方 readInstalled 对
/// ENOENT 同样交回空表）。
fn read_record(app: &AppHandle) -> Result<Value> {
    let path = record_file(app)?;

    let Some(text) = host::read_optional(&path).map_err(plugin_failure)? else {
        return Ok(json!({ "version": 1, "plugins": [] }));
    };

    let parsed: Value = serde_json::from_str(&text)?;

    if parsed.get("plugins").and_then(Value::as_array).is_none() {
        return Err(plugin_failure("installed.json 里没有 plugins 数组"));
    }

    Ok(parsed)
}

/// 写账本。缩进两格、不带尾换行 —— 与官方 writeInstalled 的
/// `JSON.stringify(data, null, 2)` 逐字节一致，免得两边轮流写同一个文件时每次都产生
/// 一份纯格式的差异。
fn write_record(app: &AppHandle, document: &Value) -> Result<()> {
    let text = serde_json::to_string_pretty(document)?;

    host::write_atomic(&record_file(app)?, &text).map_err(plugin_failure)
}

fn entries_mut(document: &mut Value) -> Result<&mut Vec<Value>> {
    document
        .get_mut("plugins")
        .and_then(Value::as_array_mut)
        .ok_or_else(|| plugin_failure("installed.json 里没有 plugins 数组"))
}

fn index_of(entries: &[Value], plugin_id: &str) -> Option<usize> {
    entries
        .iter()
        .position(|entry| entry.get("id").and_then(Value::as_str) == Some(plugin_id))
}

/// `at` 一律来自同一张表上的 index_of，所以越界与「不是对象」在这里是同一件事：
/// 账本不是它该有的形状。
fn entry_at(entries: &mut [Value], at: usize) -> Result<&mut Map<String, Value>> {
    entries
        .get_mut(at)
        .and_then(Value::as_object_mut)
        .ok_or_else(|| plugin_failure("installed.json 里的记录不是对象"))
}

/// 这条记录里被单独关掉的那几台服务器。
///
/// 官方存的是「每台一个 enabled」，缺席即开着；领域层要的是「关掉的有哪几台」。
/// 转换只在这一处发生。
fn disabled_servers(entry: &Map<String, Value>) -> Vec<String> {
    let mut names: Vec<String> = entry
        .get("capabilities")
        .and_then(Value::as_object)
        .and_then(|capabilities| capabilities.get("mcpServers"))
        .and_then(Value::as_object)
        .map(|servers| {
            servers
                .iter()
                .filter(|(_, state)| state.get("enabled").and_then(Value::as_bool) == Some(false))
                .map(|(name, _)| name.clone())
                .collect()
        })
        .unwrap_or_default();

    names.sort();

    names
}

/// 这个插件的根在哪 —— 由账本说了算，不由目录名推。
///
/// 官方允许 local-path 安装之外的记录指向别处，所以「装在 managed/<id> 下」是常态而
/// 不是不变量。按目录名硬拼，一条指向别处的记录就会读到一个不存在的路径。
fn plugin_root(app: &AppHandle, plugin_id: &str) -> Result<PathBuf> {
    read_record(app)?
        .get("plugins")
        .and_then(Value::as_array)
        .and_then(|entries| {
            entries
                .iter()
                .find(|entry| entry.get("id").and_then(Value::as_str) == Some(plugin_id))
        })
        .and_then(|entry| entry.get("root"))
        .and_then(Value::as_str)
        .map(PathBuf::from)
        .ok_or_else(|| plugin_failure(format!("installed.json 里没有 {plugin_id}")))
}

async fn download(url: &str) -> Result<Vec<u8>> {
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

/// 暂存目录填好了，读出清单原文交出去。
///
/// 读不出来就当场丢掉暂存：留着一个永远不会被认领的目录，下次列举时它就是垃圾。
/// 丢弃本身再失败也不能盖掉真正的原因，所以那一步只进日志。
fn finish_staging(staging: host::Staging, subdirectory: Option<&str>) -> Result<PluginStaged> {
    let staging_id = staging.identifier().to_owned();

    let read = host::locate_root(staging.path(), subdirectory)
        .and_then(|root| host::manifest_in(&root).ok_or(host::HostError::ManifestMissing))
        .map_err(plugin_failure)
        .and_then(|manifest| fs::read_to_string(manifest).map_err(Error::from));

    match read {
        Ok(manifest_json) => Ok(PluginStaged {
            staging_id,
            manifest_json,
        }),
        Err(cause) => {
            if let Err(cleanup) = staging.discard() {
                log::warn!("could not discard a failed staging directory: {cleanup}");
            }

            Err(cause)
        }
    }
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
        let document = read_record(&app)?;

        let entries = document
            .get("plugins")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();

        let mut found = Vec::new();

        for entry in &entries {
            let Some(object) = entry.as_object() else {
                continue;
            };

            let Some(plugin_id) = object.get("id").and_then(Value::as_str) else {
                continue;
            };

            let Some(root) = object.get("root").and_then(Value::as_str) else {
                log::warn!("installed.json 里 {plugin_id} 没有 root");
                continue;
            };

            let manifest_json = host::manifest_in(Path::new(root))
                .and_then(|path| fs::read_to_string(path).ok())
                .unwrap_or_default();

            found.push(PluginPayload {
                plugin_id: plugin_id.to_owned(),
                manifest_json,
                enabled: object
                    .get("enabled")
                    .and_then(Value::as_bool)
                    .unwrap_or(true),
                installed_at: object
                    .get("installedAt")
                    .and_then(Value::as_str)
                    .map(str::to_owned),
                source: object
                    .get("source")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_owned(),
                original_source: object
                    .get("originalSource")
                    .and_then(Value::as_str)
                    .map(str::to_owned),
                disabled_mcp_servers: disabled_servers(object),
            });
        }

        found.sort_by(|left, right| left.plugin_id.cmp(&right.plugin_id));

        Ok(found)
    })()
    .map_err(IpcError::from)
}

#[command]
#[specta::specta]
pub async fn plugins_read_text(
    app: AppHandle,
    request: PluginFileRequest,
) -> PluginsCommandResult<String> {
    (|| -> Result<String> {
        let root = plugin_root(&app, &request.plugin_id)?;
        let target = host::resolve_inside(&root, &request.relative_path).map_err(plugin_failure)?;

        Ok(fs::read_to_string(target)?)
    })()
    .map_err(IpcError::from)
}

/// 相对插件根的那条路径，一律用 '/' 分隔。
///
/// Path 在 Windows 上给出的是 '\\'，而这串字符要回到渲染层、再原样传回
/// resolve_inside；Linux 不把它当分隔符，于是同一份插件在两个平台上会得到两种读不
/// 通的路径。
fn join_relative(declared: &str, tail: &Path) -> String {
    let segments: Vec<&str> = tail
        .components()
        .filter_map(|component| component.as_os_str().to_str())
        .collect();

    if segments.is_empty() {
        return declared.to_owned();
    }

    format!("{}/{}", declared.trim_end_matches('/'), segments.join("/"))
}

/// 一条声明路径底下的文本文件，一次读齐。
///
/// 返回 None 表示这条路径不在盘上 —— 清单声明了 ./commands 而目录没跟着发布是常事，
/// 那是一条诊断，不是一次失败。空数组表示路径在，里面没有匹配后缀的文件。两者要分得
/// 开，界面上一个说「没装全」，一个说「这里是空的」。
#[command]
#[specta::specta]
pub async fn plugins_read_tree(
    app: AppHandle,
    request: PluginTreeRequest,
) -> PluginsCommandResult<Option<Vec<PluginFileText>>> {
    (|| -> Result<Option<Vec<PluginFileText>>> {
        let root = plugin_root(&app, &request.plugin_id)?;
        let declared =
            host::resolve_inside(&root, &request.relative_path).map_err(plugin_failure)?;

        let Ok(metadata) = fs::metadata(&declared) else {
            return Ok(None);
        };

        // 声明直接指到一份文件时，那份文件自己就是整棵树。
        let tails = if metadata.is_file() {
            vec![PathBuf::new()]
        } else {
            host::list_files(&declared)?
        };

        let mut found = Vec::new();
        let mut bytes = 0usize;

        for tail in tails {
            let absolute = declared.join(&tail);

            let matched = absolute
                .file_name()
                .and_then(|name| name.to_str())
                .is_some_and(|name| name.ends_with(&request.suffix));

            if !matched {
                continue;
            }

            if found.len() == MAX_TREE_FILES {
                return Err(plugin_failure(format!(
                    "{} holds more than {MAX_TREE_FILES} files",
                    request.relative_path
                )));
            }

            let contents = fs::read_to_string(&absolute)?;

            bytes += contents.len();

            if bytes > MAX_TREE_BYTES {
                return Err(plugin_failure(format!(
                    "{} exceeds {MAX_TREE_BYTES} bytes",
                    request.relative_path
                )));
            }

            found.push(PluginFileText {
                relative_path: join_relative(&request.relative_path, &tail),
                contents,
            });
        }

        Ok(Some(found))
    })()
    .map_err(IpcError::from)
}

#[command]
#[specta::specta]
pub async fn plugins_stage(
    app: AppHandle,
    fetch: PluginFetch,
) -> PluginsCommandResult<PluginStaged> {
    let bytes = match &fetch {
        PluginFetch::Archive { url, .. } => match download(url).await {
            Ok(payload) => Some(payload),
            Err(cause) => return Err(cause.into()),
        },
        PluginFetch::Directory { .. } => None,
    };

    let subdirectory = match &fetch {
        PluginFetch::Archive { subdirectory, .. } => subdirectory.as_deref(),
        PluginFetch::Directory { .. } => None,
    };

    (|| -> Result<PluginStaged> {
        let staging = host::Staging::create(&staging_root(&app)?).map_err(plugin_failure)?;

        let filled = match (&fetch, bytes.as_deref()) {
            (PluginFetch::Directory { path }, _) => {
                host::copy_tree(Path::new(path), staging.path())
            }
            (PluginFetch::Archive { .. }, Some(payload)) => {
                host::extract_zip(payload, staging.path())
            }
            (PluginFetch::Archive { url, .. }, None) => {
                return Err(plugin_failure(format!("no bytes for {url}")));
            }
        };

        if let Err(cause) = filled {
            if let Err(cleanup) = staging.discard() {
                log::warn!("could not discard a failed staging directory: {cleanup}");
            }

            return Err(plugin_failure(cause));
        }

        finish_staging(staging, subdirectory)
    })()
    .map_err(IpcError::from)
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
        let staging = host::Staging::open(&staging_root(&app)?, &request.staging_id)
            .map_err(plugin_failure)?;

        // 解出来的东西可能套在 <repo>-<ref>/ 一层里，认领的是清单所在的那一层。
        let root = host::locate_root(staging.path(), request.subdirectory.as_deref())
            .map_err(plugin_failure)?;
        let destination = managed_directory(&app, &request.plugin_id)?;

        staging
            .promote(&root, &destination)
            .map_err(plugin_failure)?;

        let mut document = read_record(&app)?;
        let entries = entries_mut(&mut document)?;

        let mut fresh = Map::new();

        let _id = fresh.insert("id".to_owned(), json!(request.plugin_id));
        let _root = fresh.insert(
            "root".to_owned(),
            json!(destination.to_string_lossy().into_owned()),
        );
        let _source = fresh.insert("source".to_owned(), json!(request.source));
        let _enabled = fresh.insert("enabled".to_owned(), json!(true));
        let _at = fresh.insert("installedAt".to_owned(), json!(request.installed_at));

        if let Some(original) = request.original_source {
            let _original = fresh.insert("originalSource".to_owned(), json!(original));
        }

        match index_of(entries, &request.plugin_id) {
            Some(at) => {
                // 重装保留原来的安装时刻与拨过的开关：解析顺序按 installedAt 排，升级一次
                // 就把一个老插件甩到队尾，会悄悄改变它注入提示词的先后。
                let existing = entry_at(entries, at)?;

                if let Some(installed_at) = existing.get("installedAt").cloned() {
                    let _kept = fresh.insert("installedAt".to_owned(), installed_at);
                }

                if let Some(capabilities) = existing.get("capabilities").cloned() {
                    let _kept = fresh.insert("capabilities".to_owned(), capabilities);
                }

                let _updated = fresh.insert("updatedAt".to_owned(), json!(request.installed_at));

                *existing = fresh;
            }
            None => entries.push(Value::Object(fresh)),
        }

        write_record(&app, &document)
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

/// 卸载：账本里那一条去掉，托管副本一并删掉。
///
/// 官方只删记录、留副本。副本没有第二个读者 —— agent 只按记录装载 —— 留着它，换一个
/// 来源重装同一个 id 时，旧文件会混进新目录。删掉不改变 agent 观察到的任何行为。
#[command]
#[specta::specta]
pub async fn plugins_remove(app: AppHandle, plugin_id: String) -> PluginsCommandResult<()> {
    (|| -> Result<()> {
        let mut document = read_record(&app)?;
        let entries = entries_mut(&mut document)?;

        if let Some(at) = index_of(entries, &plugin_id) {
            let _removed = entries.remove(at);
        }

        write_record(&app, &document)?;

        let managed = managed_directory(&app, &plugin_id)?;

        if managed.exists() {
            fs::remove_dir_all(&managed)?;
        }

        Ok(())
    })()
    .map_err(IpcError::from)
}

/// 拨动整个插件。写的是 agent 会读的那一格，所以拨完在新会话里就是真的。
#[command]
#[specta::specta]
pub async fn plugins_set_enabled(
    app: AppHandle,
    plugin_id: String,
    enabled: bool,
) -> PluginsCommandResult<()> {
    (|| -> Result<()> {
        let mut document = read_record(&app)?;
        let entries = entries_mut(&mut document)?;

        let at = index_of(entries, &plugin_id)
            .ok_or_else(|| plugin_failure(format!("installed.json 里没有 {plugin_id}")))?;

        let entry = entry_at(entries, at)?;
        let _previous = entry.insert("enabled".to_owned(), json!(enabled));

        write_record(&app, &document)
    })()
    .map_err(IpcError::from)
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
    (|| -> Result<()> {
        let mut document = read_record(&app)?;
        let entries = entries_mut(&mut document)?;

        let at = index_of(entries, &plugin_id)
            .ok_or_else(|| plugin_failure(format!("installed.json 里没有 {plugin_id}")))?;

        let entry = entry_at(entries, at)?;

        let capabilities = entry
            .entry("capabilities")
            .or_insert_with(|| json!({}))
            .as_object_mut()
            .ok_or_else(|| plugin_failure("capabilities 不是对象"))?;

        let servers = capabilities
            .entry("mcpServers")
            .or_insert_with(|| json!({}))
            .as_object_mut()
            .ok_or_else(|| plugin_failure("mcpServers 不是对象"))?;

        let state = servers
            .entry(server)
            .or_insert_with(|| json!({}))
            .as_object_mut()
            .ok_or_else(|| plugin_failure("mcpServers 里的记录不是对象"))?;

        let _previous = state.insert("enabled".to_owned(), json!(enabled));

        write_record(&app, &document)
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

/// 拉一次市场目录，覆盖本地那一份，并把它交回去。
///
/// 这条命令不判断该不该拉 —— 那个判断是 packages/plugins 的 shouldFetchOnOpen，
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
            host::write_atomic(&marketplace_catalog(&app)?, &contents)
                .map_err(plugin_failure)
                .map(|()| contents)
        })
        .map_err(IpcError::from)
}
