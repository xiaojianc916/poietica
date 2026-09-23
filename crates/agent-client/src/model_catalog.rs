//! 模型与 provider 的目录：产品侧的词汇。
//!
//! 旧实现把这套 DTO 打在 kap 的 providers/models REST 上（读一份、改一份、回一份
//! 新快照）。omp 那条路要在它自己的 `models.yml` / `config.yml` 上做同样的事，
//! 那是另一件活；这里先把形状留住 —— 界面与 IPC 契约一个字不改，缺的只是执行侧。

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::error::{AgentError, Result};

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

#[derive(Clone, Debug, Deserialize, Serialize)]
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

#[derive(Clone, Debug, Deserialize, Serialize)]
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

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct CatalogImport {
    pub catalog_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub api_key: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub base_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct RegistryImport {
    pub url: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub api_key: Option<String>,
}

#[derive(Clone, Debug)]
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
    ImportRegistry(RegistryImport),
    SetDefault {
        model_id: String,
    },
    PatchConfig(Value),
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

/// 目录改动还没有 omp 那条路。如实说不支持，不假装改成功了 —— 界面上那几个
/// 控件因此照常渲染、照常给出失败原因（ADR 0052 的后果第 5 条）。
pub(crate) fn execute(operation: &ModelCatalogOperation) -> Result<ModelCatalogSnapshot> {
    Err(AgentError::Validation {
        message: format!(
            "the model catalog is not wired to this agent yet ({})",
            name_of(operation)
        ),
    })
}

const fn name_of(operation: &ModelCatalogOperation) -> &'static str {
    match operation {
        ModelCatalogOperation::Snapshot => "snapshot",
        ModelCatalogOperation::RefreshProviders => "refresh",
        ModelCatalogOperation::Create(_) => "create",
        ModelCatalogOperation::Replace { .. } => "replace",
        ModelCatalogOperation::Delete { .. } => "delete",
        ModelCatalogOperation::ImportCatalog(_) => "import_catalog",
        ModelCatalogOperation::ImportRegistry(_) => "import_registry",
        ModelCatalogOperation::SetDefault { .. } => "set_default",
        ModelCatalogOperation::PatchConfig(_) => "patch_config",
    }
}
