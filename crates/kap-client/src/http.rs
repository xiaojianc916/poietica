//! KAP REST 传输：请求发送与信封解包。
//!
//! 信封只在这里解一次，领域层不接触未验证数据。这一层不认识会话、进程与链路
//! —— 它是全 crate 共用的那条 HTTP 路，所以住在 crate 根而不是某个领域目录里：
//! 住在 session/ 之下时，capability 门禁、模型目录与实例注册表都要反向依赖会话。

use serde_json::Value;

use crate::error::{KapError, Result};
use crate::generated::rest::routes;

/// 信封解成 data；业务成败看 code，不看 HTTP 状态。
pub(crate) fn envelope_data(body: &Value) -> Result<Value> {
    let envelope: crate::generated::rest::RestEnvelope = serde_json::from_value(body.clone())
        .map_err(|error| KapError::Transport {
            message: format!("the REST envelope does not fit the pinned contract: {error}"),
        })?;

    crate::envelope_data(envelope).map_err(|error| match error {
        crate::error::EnvelopeError::Refused { code, msg } => {
            KapError::Envelope { code, message: msg }
        }
        crate::error::EnvelopeError::Shape(error) => KapError::Transport {
            message: error.to_string(),
        },
    })
}

pub(crate) fn decoded<T: serde::de::DeserializeOwned>(data: Value, what: &str) -> Result<T> {
    serde_json::from_value(data).map_err(|error| KapError::Transport {
        message: format!("{what} does not fit the pinned contract: {error}"),
    })
}

pub(crate) async fn get(http: &reqwest::Client, route: routes::Route) -> Result<Value> {
    let url = route.map_err(|error| KapError::Transport {
        message: error.to_string(),
    })?;
    send(http.get(url)).await
}

pub(crate) async fn post<T: serde::Serialize>(
    http: &reqwest::Client,
    route: routes::Route,
    body: &T,
) -> Result<Value> {
    let url = route.map_err(|error| KapError::Transport {
        message: error.to_string(),
    })?;
    send(http.post(url).json(body)).await
}

pub(crate) async fn put<T: serde::Serialize>(
    http: &reqwest::Client,
    route: routes::Route,
    body: &T,
) -> Result<Value> {
    let url = route.map_err(|error| KapError::Transport {
        message: error.to_string(),
    })?;
    send(http.put(url).json(body)).await
}

pub(crate) async fn delete(http: &reqwest::Client, route: routes::Route) -> Result<()> {
    let url = route.map_err(|error| KapError::Transport {
        message: error.to_string(),
    })?;
    let response = http
        .delete(url)
        .send()
        .await
        .map_err(|error| KapError::Transport {
            message: error.to_string(),
        })?;
    let status = response.status();
    let bytes = response
        .bytes()
        .await
        .map_err(|error| KapError::Transport {
            message: error.to_string(),
        })?;
    if bytes.is_empty() && status.is_success() {
        return Ok(());
    }
    let body: Value = serde_json::from_slice(&bytes).map_err(|error| KapError::Transport {
        message: error.to_string(),
    })?;
    envelope_data(&body).map(|_| ())
}

async fn send(builder: reqwest::RequestBuilder) -> Result<Value> {
    let body: Value = builder
        .send()
        .await
        .map_err(|e| KapError::Transport {
            message: e.to_string(),
        })?
        .json()
        .await
        .map_err(|e| KapError::Transport {
            message: e.to_string(),
        })?;

    envelope_data(&body)
}
