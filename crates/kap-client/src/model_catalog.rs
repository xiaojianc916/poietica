use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::error::{KapError, Result};
use crate::generated::rest::{
    ClientConfigDataStruct, ListCatalogProvidersDataStruct, ListModelsDataStruct,
    ListProvidersDataStruct, routes,
};
use crate::session::rest::{delete, get, post, put};

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
    pub support_efforts: Option<Vec<String>>,
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

fn projected<T, U>(wire: T, what: &str) -> Result<U>
where
    T: Serialize,
    U: serde::de::DeserializeOwned,
{
    serde_json::from_value(
        serde_json::to_value(wire).map_err(|error| KapError::Transport {
            message: format!("could not project {what}: {error}"),
        })?,
    )
    .map_err(|error| KapError::Transport {
        message: format!("{what} does not fit the domain projection: {error}"),
    })
}

async fn snapshot(http: &reqwest::Client, base_url: &str) -> Result<ModelCatalogSnapshot> {
    let providers: ListProvidersDataStruct = serde_json::from_value(
        get(http, routes::list_providers(base_url)).await?,
    )
    .map_err(|error| KapError::Transport {
        message: error.to_string(),
    })?;
    let models: ListModelsDataStruct = serde_json::from_value(
        get(http, routes::list_models(base_url)).await?,
    )
    .map_err(|error| KapError::Transport {
        message: error.to_string(),
    })?;
    let catalog: ListCatalogProvidersDataStruct =
        serde_json::from_value(get(http, routes::list_catalog_providers(base_url)).await?)
            .map_err(|error| KapError::Transport {
                message: error.to_string(),
            })?;
    let config: ClientConfigDataStruct = serde_json::from_value(
        get(http, routes::client_config(base_url)).await?,
    )
    .map_err(|error| KapError::Transport {
        message: error.to_string(),
    })?;

    Ok(ModelCatalogSnapshot {
        providers: projected(providers.items, "providers")?,
        models: projected(models.items, "models")?,
        catalog: projected(catalog.items, "provider catalog")?,
        default_model: config.default_model,
    })
}

pub(crate) async fn execute(
    http: &reqwest::Client,
    base_url: &str,
    operation: ModelCatalogOperation,
) -> Result<ModelCatalogSnapshot> {
    match operation {
        ModelCatalogOperation::Snapshot => {}
        ModelCatalogOperation::Create(provider) => {
            post(http, routes::create_provider(base_url), &provider).await?;
        }
        ModelCatalogOperation::Replace {
            provider_id,
            provider,
        } => {
            put(
                http,
                routes::replace_provider(base_url, &provider_id),
                &provider,
            )
            .await?;
        }
        ModelCatalogOperation::Delete { provider_id } => {
            delete(http, routes::delete_provider(base_url, &provider_id)).await?;
        }
        ModelCatalogOperation::ImportCatalog(request) => {
            post(
                http,
                routes::provider_collection_action(base_url, ":import_catalog"),
                &request,
            )
            .await?;
        }
        ModelCatalogOperation::ImportRegistry(request) => {
            post(
                http,
                routes::provider_collection_action(base_url, ":import_registry"),
                &request,
            )
            .await?;
        }
        ModelCatalogOperation::SetDefault { model_id } => {
            post(
                http,
                routes::set_default_model(base_url, &format!("{model_id}:set_default")),
                &json!({}),
            )
            .await?;
        }
        ModelCatalogOperation::PatchConfig(patch) => {
            post(http, routes::update_client_config(base_url), &patch).await?;
        }
    }
    snapshot(http, base_url).await
}
