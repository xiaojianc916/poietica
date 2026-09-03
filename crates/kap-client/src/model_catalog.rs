use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::error::{KapError, Result};
use crate::generated::rest::{
    ClientConfigDataStruct, ListModelsDataStruct, ListProvidersDataStruct, routes,
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

fn parse_catalog(raw: Value) -> Result<Vec<CatalogProvider>> {
    if let Some(items) = raw.get("items") {
        return projected(items.clone(), "model catalog");
    }
    projected(raw, "model catalog")
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProviderWriteFields {
    max_output_size: Option<u64>,
    adaptive_thinking: Option<bool>,
}

fn hydrate_provider_write_fields(models: &mut [Model], configured: Option<&Value>) -> Result<()> {
    let Some(configured) = configured.and_then(Value::as_object) else {
        return Ok(());
    };
    for model in models {
        let Some(raw) = configured.get(&model.model) else {
            continue;
        };
        let fields: ProviderWriteFields =
            serde_json::from_value(raw.clone()).map_err(|error| KapError::Transport {
                message: format!(
                    "model {} has invalid provider write fields: {error}",
                    model.model
                ),
            })?;
        model.max_output_size = fields.max_output_size;
        model.adaptive_thinking = fields.adaptive_thinking;
    }
    Ok(())
}

async fn snapshot(http: &reqwest::Client, base_url: &str) -> Result<ModelCatalogSnapshot> {
    let providers: ListProvidersDataStruct = serde_json::from_value(
        get(http, routes::list_providers(base_url)).await?,
    )
    .map_err(|error| KapError::Transport {
        message: error.to_string(),
    })?;
    let listed_models: ListModelsDataStruct = serde_json::from_value(
        get(http, routes::list_models(base_url)).await?,
    )
    .map_err(|error| KapError::Transport {
        message: error.to_string(),
    })?;
    let config: ClientConfigDataStruct = serde_json::from_value(
        get(http, routes::client_config(base_url)).await?,
    )
    .map_err(|error| KapError::Transport {
        message: error.to_string(),
    })?;
    let catalog = parse_catalog(get(http, routes::list_catalog_providers(base_url)).await?)?;
    let mut models: Vec<Model> = projected(listed_models.items, "models")?;
    hydrate_provider_write_fields(&mut models, config.models.as_ref())?;

    Ok(ModelCatalogSnapshot {
        providers: projected(providers.items, "providers")?,
        models,
        catalog,
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
        ModelCatalogOperation::RefreshProviders => {
            let _: Value = post(
                http,
                routes::provider_collection_action(base_url, ":refresh"),
                &json!({}),
            )
            .await?;
        }
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

#[cfg(test)]
mod tests {
    #![allow(clippy::expect_used, reason = "fixture failures must fail the test")]
    use super::*;

    #[test]
    fn hydrate_provider_write_fields_keeps_fields_missing_from_models_route() {
        let mut models = vec![Model {
            provider: "tokenrouter".to_owned(),
            model: "tokenrouter/z-ai/glm-5.3-free".to_owned(),
            display_name: Some("GLM 5.3 (free)".to_owned()),
            max_context_size: 131_072,
            capabilities: Some(vec!["thinking".to_owned()]),
            max_output_size: None,
            support_efforts: Some(vec!["low".to_owned(), "high".to_owned()]),
            adaptive_thinking: None,
            default_effort: Some("high".to_owned()),
        }];
        let configured = json!({
            "tokenrouter/z-ai/glm-5.3-free": {
                "maxOutputSize": 65_536,
                "adaptiveThinking": true
            }
        });

        hydrate_provider_write_fields(&mut models, Some(&configured))
            .expect("configured fields must hydrate");

        let hydrated = models.first().expect("fixture has one model");
        assert_eq!(hydrated.max_output_size, Some(65_536));
        assert_eq!(hydrated.adaptive_thinking, Some(true));
    }
}
