//! 模型与 provider 的目录：kap 的 providers/models REST 是唯一读写路。
//!
//! 权威是 agent 进程自己（它 watch config.toml 并热重载），这一侧不持有第二份
//! 副本 —— 每次调用现问，每次改完由 agent 回一份新快照。crate 侧的线上类型是
//! snake_case 的协议形状，这里的 DTO 是 IPC 形状，互转只在本文件。

use poietica_kap_client::{
    CatalogImport, CatalogModel, CatalogProvider, Model, ModelCatalogOperation,
    ModelCatalogSnapshot, Provider, ProviderInput, ProviderModelInput, ProviderReplacement,
    RegistryImport,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use specta::Type;
use tauri::{AppHandle, State};

use super::AgentCommandResult;
use super::dto::AgentLaunch;
use super::failure::translate;
use super::runtime::{AgentRuntime, ensure_session};

#[derive(Debug, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ProviderModelInputDto {
    pub model: String,
    pub max_context_size: u64,
    pub display_name: Option<String>,
    pub capabilities: Option<Vec<String>>,
    pub max_output_size: Option<u64>,
    pub support_efforts: Option<Vec<String>>,
    pub adaptive_thinking: Option<bool>,
}

#[derive(Debug, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ProviderInputDto {
    pub id: String,
    pub provider_type: String,
    pub api_key: Option<String>,
    pub base_url: Option<String>,
    pub default_model: Option<String>,
    pub models: Vec<ProviderModelInputDto>,
}

#[derive(Debug, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ProviderReplacementDto {
    pub new_id: Option<String>,
    pub provider_type: String,
    pub api_key: Option<String>,
    pub base_url: Option<String>,
    pub default_model: Option<String>,
    pub models: Vec<ProviderModelInputDto>,
}

/// 一次目录操作。判别式与 @poietica/settings 的 ModelCatalogOperation 一一对应。
#[derive(Debug, Deserialize, Type)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ModelCatalogOperationDto {
    Snapshot,
    #[serde(rename_all = "camelCase")]
    Create {
        provider: ProviderInputDto,
    },
    #[serde(rename_all = "camelCase")]
    Replace {
        provider_id: String,
        provider: ProviderReplacementDto,
    },
    #[serde(rename_all = "camelCase")]
    Delete {
        provider_id: String,
    },
    #[serde(rename_all = "camelCase")]
    ImportCatalog {
        catalog_id: String,
        api_key: Option<String>,
        base_url: Option<String>,
        id: Option<String>,
    },
    #[serde(rename_all = "camelCase")]
    ImportRegistry {
        url: String,
        api_key: Option<String>,
    },
    #[serde(rename_all = "camelCase")]
    SetDefault {
        model_id: String,
    },
    #[serde(rename_all = "camelCase")]
    PatchConfig {
        patch: Value,
    },
}

#[derive(Debug, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ProviderDto {
    pub id: String,
    pub provider_type: String,
    pub base_url: Option<String>,
    pub default_model: Option<String>,
    pub has_api_key: bool,
    pub status: String,
    pub models: Option<Vec<String>>,
}

#[derive(Debug, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ModelDto {
    pub provider: String,
    pub model: String,
    pub display_name: Option<String>,
    pub max_context_size: u64,
    pub capabilities: Option<Vec<String>>,
    pub support_efforts: Option<Vec<String>>,
    pub default_effort: Option<String>,
}

#[derive(Debug, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct CatalogModelDto {
    pub id: String,
    pub name: Option<String>,
    pub max_context_size: u64,
    pub capabilities: Option<Vec<String>>,
    pub reasoning: bool,
}

#[derive(Debug, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct CatalogProviderDto {
    pub id: String,
    pub name: String,
    pub wire_type: Option<String>,
    pub guessed: bool,
    pub needs_base_url: bool,
    pub rejected: bool,
    pub reject_reason: Option<String>,
    pub env_key: Option<String>,
    pub models: Vec<CatalogModelDto>,
}

#[derive(Debug, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ModelCatalogSnapshotDto {
    pub providers: Vec<ProviderDto>,
    pub models: Vec<ModelDto>,
    pub catalog: Vec<CatalogProviderDto>,
    pub default_model: Option<String>,
}

#[derive(Debug, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AgentModelCatalogRequest {
    pub launch: AgentLaunch,
    pub cwd: Option<String>,
    pub operation: ModelCatalogOperationDto,
}

/// 读或改这个 agent 的模型目录。写操作执行完，回答的仍是改后的整份快照。
#[tauri::command]
#[specta::specta]
pub async fn agent_model_catalog(
    app: AppHandle,
    state: State<'_, AgentRuntime>,
    request: AgentModelCatalogRequest,
) -> AgentCommandResult<ModelCatalogSnapshotDto> {
    let live = ensure_session(&app, &state, request.launch, request.cwd).await?;

    let snapshot = live
        .client
        .model_catalog(into_operation(request.operation))
        .await
        .map_err(translate)?;

    Ok(into_snapshot(snapshot))
}

fn into_operation(operation: ModelCatalogOperationDto) -> ModelCatalogOperation {
    match operation {
        ModelCatalogOperationDto::Snapshot => ModelCatalogOperation::Snapshot,
        ModelCatalogOperationDto::Create { provider } => {
            ModelCatalogOperation::Create(provider.into())
        }
        ModelCatalogOperationDto::Replace {
            provider_id,
            provider,
        } => ModelCatalogOperation::Replace {
            provider_id,
            provider: provider.into(),
        },
        ModelCatalogOperationDto::Delete { provider_id } => {
            ModelCatalogOperation::Delete { provider_id }
        }
        ModelCatalogOperationDto::ImportCatalog {
            catalog_id,
            api_key,
            base_url,
            id,
        } => ModelCatalogOperation::ImportCatalog(CatalogImport {
            catalog_id,
            api_key,
            base_url,
            id,
        }),
        ModelCatalogOperationDto::ImportRegistry { url, api_key } => {
            ModelCatalogOperation::ImportRegistry(RegistryImport { url, api_key })
        }
        ModelCatalogOperationDto::SetDefault { model_id } => {
            ModelCatalogOperation::SetDefault { model_id }
        }
        ModelCatalogOperationDto::PatchConfig { patch } => {
            ModelCatalogOperation::PatchConfig(patch)
        }
    }
}

impl From<ProviderModelInputDto> for ProviderModelInput {
    fn from(dto: ProviderModelInputDto) -> Self {
        Self {
            model: dto.model,
            max_context_size: dto.max_context_size,
            display_name: dto.display_name,
            capabilities: dto.capabilities,
            max_output_size: dto.max_output_size,
            support_efforts: dto.support_efforts,
            adaptive_thinking: dto.adaptive_thinking,
        }
    }
}

impl From<ProviderInputDto> for ProviderInput {
    fn from(dto: ProviderInputDto) -> Self {
        Self {
            id: dto.id,
            provider_type: dto.provider_type,
            api_key: dto.api_key,
            base_url: dto.base_url,
            default_model: dto.default_model,
            models: dto
                .models
                .into_iter()
                .map(ProviderModelInput::from)
                .collect(),
        }
    }
}

impl From<ProviderReplacementDto> for ProviderReplacement {
    fn from(dto: ProviderReplacementDto) -> Self {
        Self {
            new_id: dto.new_id,
            provider_type: dto.provider_type,
            api_key: dto.api_key,
            base_url: dto.base_url,
            default_model: dto.default_model,
            models: dto
                .models
                .into_iter()
                .map(ProviderModelInput::from)
                .collect(),
        }
    }
}

fn into_snapshot(snapshot: ModelCatalogSnapshot) -> ModelCatalogSnapshotDto {
    ModelCatalogSnapshotDto {
        providers: snapshot
            .providers
            .into_iter()
            .map(ProviderDto::from)
            .collect(),
        models: snapshot.models.into_iter().map(ModelDto::from).collect(),
        catalog: snapshot
            .catalog
            .into_iter()
            .map(CatalogProviderDto::from)
            .collect(),
        default_model: snapshot.default_model,
    }
}

impl From<Provider> for ProviderDto {
    fn from(provider: Provider) -> Self {
        Self {
            id: provider.id,
            provider_type: provider.provider_type,
            base_url: provider.base_url,
            default_model: provider.default_model,
            has_api_key: provider.has_api_key,
            status: provider.status,
            models: provider.models,
        }
    }
}

impl From<Model> for ModelDto {
    fn from(model: Model) -> Self {
        Self {
            provider: model.provider,
            model: model.model,
            display_name: model.display_name,
            max_context_size: model.max_context_size,
            capabilities: model.capabilities,
            support_efforts: model.support_efforts,
            default_effort: model.default_effort,
        }
    }
}

impl From<CatalogModel> for CatalogModelDto {
    fn from(model: CatalogModel) -> Self {
        Self {
            id: model.id,
            name: model.name,
            max_context_size: model.max_context_size,
            capabilities: model.capabilities,
            reasoning: model.reasoning,
        }
    }
}

impl From<CatalogProvider> for CatalogProviderDto {
    fn from(provider: CatalogProvider) -> Self {
        Self {
            id: provider.id,
            name: provider.name,
            wire_type: provider.wire_type,
            guessed: provider.guessed,
            needs_base_url: provider.needs_base_url,
            rejected: provider.rejected,
            reject_reason: provider.reject_reason,
            env_key: provider.env_key,
            models: provider
                .models
                .into_iter()
                .map(CatalogModelDto::from)
                .collect(),
        }
    }
}
