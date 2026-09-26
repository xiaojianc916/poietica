//! 模型与 provider 目录：产品侧词汇，线上形状翻译在 bridge.rs。

use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct ProviderModelInput {
    pub model: String,
    pub max_context_size: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub display_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub capabilities: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_output_size: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub support_efforts: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub adaptive_thinking: Option<bool>,
}

/// 整份换掉一个 provider 时给的输入。
///
/// **手写 Debug**：`api_key` 不进 Debug 输出（同 `ProviderInput`）。
#[derive(Clone, Deserialize, Serialize)]
pub struct ProviderReplacement {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub new_id: Option<String>,
    #[serde(rename = "type")]
    pub provider_type: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub api_key: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub base_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub default_model: Option<String>,
    pub models: Vec<ProviderModelInput>,
}

impl std::fmt::Debug for ProviderReplacement {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("ProviderReplacement")
            .field("new_id", &self.new_id)
            .field("provider_type", &self.provider_type)
            /* api_key 刻意不在这里。 */
            .field("has_api_key", &self.api_key.is_some())
            .field("base_url", &self.base_url)
            .field("default_model", &self.default_model)
            .field("models", &self.models.len())
            .finish()
    }
}

/// 从上游目录导入一个 provider 时给的输入。
///
/// **手写 Debug**：`api_key` 不进 Debug 输出（同 `ProviderInput`）。
#[derive(Clone, Deserialize, Serialize)]
pub struct CatalogImport {
    pub catalog_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub api_key: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub base_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
}

impl std::fmt::Debug for CatalogImport {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("CatalogImport")
            .field("catalog_id", &self.catalog_id)
            .field("has_api_key", &self.api_key.is_some())
            .field("base_url", &self.base_url)
            .field("id", &self.id)
            .finish()
    }
}

/// 一次目录操作。
///
/// **手写 Debug**：`Create` / `Replace` 里装着 `api_key`，派生的 `{:?}` 会把明文密钥
/// 写进错误消息、日志与界面（AGENTS.md §5「Debug 不打载荷」）。这里只打判别式与
/// 非密文的标识，密钥那一格永不出现在任何 Debug 输出里。
#[derive(Clone)]
pub enum ModelCatalogOperation {
    Snapshot,
    RefreshProviders,
    Create(ProviderInput),
    Replace {
        provider_id: String,
        provider: ProviderReplacement,
    },
    Delete {
        provider_id: String,
    },
    ImportCatalog(CatalogImport),
    SetDefault {
        model_id: String,
    },
}

impl ModelCatalogOperation {
    /// 判别式，用于错误消息与线上 `kind`；不含任何载荷。
    #[must_use]
    pub const fn kind_name(&self) -> &'static str {
        match self {
            Self::Snapshot => "snapshot",
            Self::RefreshProviders => "refreshProviders",
            Self::Create(_) => "create",
            Self::Replace { .. } => "replace",
            Self::Delete { .. } => "delete",
            Self::ImportCatalog(_) => "importCatalog",
            Self::SetDefault { .. } => "setDefault",
        }
    }
}

impl std::fmt::Debug for ModelCatalogOperation {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        /* 只打判别式与 id：密钥、base_url 的查询串、patch 的内容都不进来。 */
        match self {
            Self::Create(provider) => write!(formatter, "Create({})", provider.id),
            Self::Replace { provider_id, .. } => write!(formatter, "Replace({provider_id})"),
            Self::Delete { provider_id } => write!(formatter, "Delete({provider_id})"),
            Self::SetDefault { model_id } => write!(formatter, "SetDefault({model_id})"),
            other => write!(formatter, "{}", other.kind_name()),
        }
    }
}

/// 一个 provider 的输入。
///
/// **手写 Debug**：同 `ModelCatalogOperation`，`api_key` 不进 Debug 输出。
#[derive(Clone, Deserialize, Serialize)]
pub struct ProviderInput {
    pub id: String,
    #[serde(rename = "type")]
    pub provider_type: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub api_key: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub base_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub default_model: Option<String>,
    pub models: Vec<ProviderModelInput>,
}

impl std::fmt::Debug for ProviderInput {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("ProviderInput")
            .field("id", &self.id)
            .field("provider_type", &self.provider_type)
            /* api_key 刻意不在这里 —— 它在时也不打。 */
            .field("has_api_key", &self.api_key.is_some())
            .field("base_url", &self.base_url)
            .field("default_model", &self.default_model)
            .field("models", &self.models.len())
            .finish()
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct Provider {
    pub id: String,
    #[serde(rename = "type")]
    pub provider_type: String,
    pub base_url: Option<String>,
    pub default_model: Option<String>,
    pub has_api_key: bool,
    pub status: String,
    pub models: Option<Vec<String>>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct Model {
    pub provider: String,
    pub model: String,
    pub display_name: Option<String>,
    pub max_context_size: u64,
    pub capabilities: Option<Vec<String>>,
    pub max_output_size: Option<u64>,
    pub support_efforts: Option<Vec<String>>,
    pub adaptive_thinking: Option<bool>,
    pub default_effort: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct CatalogModel {
    pub id: String,
    pub name: Option<String>,
    pub max_context_size: u64,
    pub capabilities: Option<Vec<String>>,
    pub reasoning: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct CatalogProvider {
    pub id: String,
    pub name: String,
    pub wire_type: Option<String>,
    pub guessed: bool,
    pub needs_base_url: bool,
    pub rejected: bool,
    pub reject_reason: Option<String>,
    pub env_key: Option<String>,
    pub models: Vec<CatalogModel>,
}

#[derive(Clone, Debug, Serialize)]
pub struct ModelCatalogSnapshot {
    pub providers: Vec<Provider>,
    pub models: Vec<Model>,
    pub catalog: Vec<CatalogProvider>,
    pub default_model: Option<String>,
}
