use std::path::Path;

use reqwest::header::{CONTENT_TYPE, HeaderMap};
use serde_json::Value;
use tokio::io::AsyncWriteExt;

use crate::error::{KapError, Result};
use crate::generated::rest::{ExportSessionRequestStruct, routes};
use crate::session::rest::envelope_data;

const MAX_ERROR_BODY_BYTES: usize = 1024 * 1024;

fn is_zip(headers: &HeaderMap) -> bool {
    headers
        .get(CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.parse::<mime::Mime>().ok())
        .is_some_and(|value| value.essence_str() == "application/zip")
}

async fn response_error(mut response: reqwest::Response) -> KapError {
    let status = response.status();
    let mut body = Vec::new();

    loop {
        match response.chunk().await {
            Ok(Some(chunk)) => {
                if body.len().saturating_add(chunk.len()) > MAX_ERROR_BODY_BYTES {
                    return KapError::Transport {
                        message: format!(
                            "session export failed with HTTP {status} and an oversized error body"
                        ),
                    };
                }
                body.extend_from_slice(&chunk);
            }
            Ok(None) => break,
            Err(error) => {
                return KapError::Transport {
                    message: format!("could not read the session export error: {error}"),
                };
            }
        }
    }

    if let Ok(envelope) = serde_json::from_slice::<Value>(&body)
        && let Err(error) = envelope_data(&envelope)
    {
        return error;
    }

    KapError::Transport {
        message: format!(
            "session export returned HTTP {status} without a ZIP or a valid error envelope"
        ),
    }
}

pub(crate) async fn export_session(
    http: &reqwest::Client,
    base_url: &str,
    session_id: &str,
    destination: &Path,
) -> Result<()> {
    let url =
        routes::export_session(base_url, session_id).map_err(|error| KapError::Transport {
            message: error.to_string(),
        })?;
    let response = http
        .post(url)
        .json(&ExportSessionRequestStruct {
            desktop: Some(true),
            web_log: None,
        })
        .send()
        .await
        .map_err(|error| KapError::Transport {
            message: error.to_string(),
        })?;

    if !response.status().is_success() || !is_zip(response.headers()) {
        return Err(response_error(response).await);
    }

    let parent = destination
        .parent()
        .filter(|path| !path.as_os_str().is_empty())
        .ok_or_else(|| KapError::Validation {
            message: "the session export destination has no parent directory".to_owned(),
        })?;
    let temporary = tempfile::Builder::new()
        .prefix(".poietica-session-export-")
        .tempfile_in(parent)?;
    let (file, temporary_path) = temporary.into_parts();
    let mut output = tokio::fs::File::from_std(file);
    let mut response = response;

    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|error| KapError::Transport {
            message: error.to_string(),
        })?
    {
        output.write_all(&chunk).await?;
    }

    output.flush().await?;
    output.sync_all().await?;
    drop(output);
    temporary_path
        .persist(destination)
        .map_err(|failure| KapError::Io(failure.error))?;

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use reqwest::header::HeaderValue;

    #[test]
    fn zip_media_type_accepts_parameters() {
        let mut headers = HeaderMap::new();
        headers.insert(
            CONTENT_TYPE,
            HeaderValue::from_static("application/zip; charset=binary"),
        );
        assert!(is_zip(&headers));
    }

    #[test]
    fn non_zip_media_type_is_rejected() {
        let mut headers = HeaderMap::new();
        headers.insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));
        assert!(!is_zip(&headers));
    }
}
