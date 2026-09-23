use super::{CommandError, Runtime, RuntimeFailure, Takeover};
use crate::session::{SessionMode, SessionRequest};
use poietica_agent_client::{
    Capability, ConfigControl, McpServer, ModelCatalogOperation, ModelCatalogSnapshot, Skill,
};

impl<E: RuntimeFailure> Runtime<E> {
    pub async fn configuration_for(
        &self,
        agent: String,
        cwd: Option<String>,
    ) -> Result<Vec<ConfigControl>, CommandError<E>> {
        let live = self
            .ensure(agent, cwd, Takeover::Replace)
            .await
            .map_err(CommandError::Runtime)?;
        live.client
            .selectors(live.anchor)
            .map_err(CommandError::Agent)?
            .await
            .map_err(|_| CommandError::ResponseClosed)?
            .map_err(CommandError::Agent)
    }

    pub async fn toolkit(
        &self,
        agent: String,
        cwd: Option<String>,
        thread: Option<String>,
    ) -> Result<(Vec<Skill>, Vec<McpServer>), CommandError<E>> {
        let live = self
            .ensure(agent, cwd, Takeover::Replace)
            .await
            .map_err(CommandError::Runtime)?;
        let held = match thread.as_deref() {
            Some(named) => Some(
                self.sessions()
                    .resolve(
                        &self.index,
                        &live.client,
                        &live.book,
                        SessionRequest {
                            owner: &live.agent_id,
                            default_root: self.root(),
                            named,
                            mode: SessionMode::CreateIfUnbound,
                        },
                    )
                    .await
                    .map_err(CommandError::Session)?,
            ),
            None => None,
        };
        let session = held
            .as_ref()
            .map_or_else(|| live.anchor.clone(), |held| held.session_id.clone());
        let snapshot = tokio::try_join!(live.client.skills(session), live.client.mcp_servers())
            .map_err(CommandError::Agent)?;
        drop(held);
        Ok(snapshot)
    }

    pub async fn capability_report(
        &self,
        agent: String,
    ) -> Result<Vec<Capability>, CommandError<E>> {
        let live = self
            .ensure(agent, None, Takeover::Replace)
            .await
            .map_err(CommandError::Runtime)?;
        live.client
            .capabilities()
            .await
            .map_err(CommandError::Agent)
    }

    pub async fn capability_install(
        &self,
        agent: String,
        capability: String,
    ) -> Result<Capability, CommandError<E>> {
        let live = self
            .ensure(agent, None, Takeover::Replace)
            .await
            .map_err(CommandError::Runtime)?;
        live.client
            .install_capability(capability)
            .await
            .map_err(CommandError::Agent)
    }

    pub async fn model_catalog(
        &self,
        agent: String,
        cwd: Option<String>,
        operation: ModelCatalogOperation,
    ) -> Result<ModelCatalogSnapshot, CommandError<E>> {
        let live = self
            .ensure(agent, cwd, Takeover::Replace)
            .await
            .map_err(CommandError::Runtime)?;
        live.client
            .model_catalog(operation)
            .await
            .map_err(CommandError::Agent)
    }

    pub async fn transcript(
        &self,
        session: String,
        agent: String,
        before: Option<String>,
    ) -> Result<String, CommandError<E>> {
        self.require_live()?
            .client
            .read_transcript(session, agent, before)
            .await
            .map(|value| value.to_string())
            .map_err(CommandError::Agent)
    }

    pub async fn transcript_ops(
        &self,
        session: String,
        agent: String,
        since: i64,
    ) -> Result<String, CommandError<E>> {
        self.require_live()?
            .client
            .catch_up_transcript(session, agent, since)
            .await
            .map(|value| value.to_string())
            .map_err(CommandError::Agent)
    }

    ///
    /// 取一张会话媒体（历史图片）的字节并以 base64 回交：webview 无法带 Bearer 直连
    /// daemon 的 media 端点，只能由这条已鉴权的连接代取。失败按传输错误上抛，调用方
    /// 降级为占位图，不挡对话。
    pub async fn session_media(
        &self,
        session: String,
        file_id: String,
    ) -> Result<(String, String), CommandError<E>> {
        use base64::Engine as _;
        use base64::engine::general_purpose::STANDARD as BASE64;

        let media = self
            .require_live()?
            .client
            .read_media(session, file_id)
            .await
            .map_err(CommandError::Agent)?;
        Ok((media.content_type, BASE64.encode(media.bytes)))
    }
}
