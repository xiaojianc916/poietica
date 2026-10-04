use super::{CommandError, Runtime, RuntimeFailure, Takeover};
use crate::connection::Handle;
use crate::session::{SessionMode, SessionRequest};
use poietica_agent_client::{
    BrowserSettings, Capability, ConfigControl, McpServer, ModelCatalogOperation,
    ModelCatalogSnapshot, SettingEntry, SettingValue, SettingsCatalog, Skill,
};

impl<E: RuntimeFailure> Runtime<E> {
    /// 进程级读的连接选择：复用同 agent 的活连接，**不看工作区**。
    ///
    /// 这些读问的是进程级事实（模型目录、能力清单、名册、设置），与连接锚在哪无关。
    /// 传 cwd 进来按工作区重锚是有害的：首启那几条读是并发的，锚一旦不一致，后到的那条
    /// 就把前一条**正在服务这次读**的连接拆掉，前一条手里在飞的请求当场
    /// `Refused(Gone)` —— 屏幕上是首启一次「agent 连接失败」，两秒后自愈。
    ///
    /// 传 `Reuse` 而不是 `Replace`：`Replace` 在 cwd 缺席时会解析成兜底工作区，把用户
    /// 对话正用的连接拆掉重起；cwd 在场时又会按工作区重锚，拆掉另一条读正在用的那条。
    /// 两条路都拆，所以这里根本不该重锚 —— 重锚是开会话的事。
    ///
    /// cwd 必须由调用方给，而且必须是**活动工作区**：真到了「没有活连接、这一读自己起一条」
    /// 那一步，锚就落在它上面。给了 `None` 就会落到兜底根，于是这一读**替整条进程选了锚** ——
    /// 而那个锚注定被「恢复上次对话」按真工作区用 `Replace` 换掉，换掉的一刻这一读还挂在
    /// 旧连接上，应答槽随连接一起没 → 首启一次「agent 连接失败」。所以缺席不再代表「随便」，
    /// 它只剩「调用方真的不知道活动工作区」这一种意思（见 `ensure` 的缺席分支：先复用活连接
    /// 的锚，实在没有才退兜底根）。`Reuse` 只管「有活连接时不重锚」，不管「起新的时锚在哪」。
    async fn or_live(&self, agent: String, cwd: Option<String>) -> Result<Handle, CommandError<E>> {
        self.ensure(agent, cwd, Takeover::Reuse)
            .await
            .map_err(CommandError::Runtime)
    }

    /// 选择器读的是活连接上那条锚会话，判据与其它进程级读同一条（见 `or_live`）。
    pub async fn configuration_for(
        &self,
        agent: String,
        cwd: Option<String>,
    ) -> Result<Vec<ConfigControl>, CommandError<E>> {
        let live = self.or_live(agent, cwd).await?;
        live.client
            .selectors(live.anchor)
            .map_err(CommandError::Agent)?
            .await
            .map_err(|_| CommandError::ResponseClosed)?
            .map_err(CommandError::Agent)
    }

    /// 名册读与其它进程级读同一条连接判据（见 `or_live`）：复用同 agent 的活连接。
    ///
    /// cwd 在这里只用来给 project 技能标名（`collect_toolkit` 的 `fallback_cwd`），
    /// **不**用来选连接 —— 它是读的一部分，不是锚的一部分。
    pub async fn toolkit(
        &self,
        agent: String,
        cwd: Option<String>,
        thread: Option<String>,
    ) -> Result<(Vec<Skill>, Vec<McpServer>), CommandError<E>> {
        let live = self.or_live(agent, cwd).await?;
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

    /// agent 的浏览器控制设置；进程级事实，与连接锚在哪个工作区无关。
    pub async fn browser_settings(
        &self,
        agent: String,
        cwd: Option<String>,
    ) -> Result<BrowserSettings, CommandError<E>> {
        let live = self.or_live(agent, cwd).await?;
        live.client
            .browser_settings()
            .await
            .map_err(CommandError::Agent)
    }

    /// 写浏览器控制设置；缺席的格不改，交回写完的整份。
    pub async fn set_browser_settings(
        &self,
        agent: String,
        cwd: Option<String>,
        enabled: Option<bool>,
        headless: Option<bool>,
        relay: Option<bool>,
        cdp_url: Option<String>,
    ) -> Result<BrowserSettings, CommandError<E>> {
        let live = self.or_live(agent, cwd).await?;
        live.client
            .set_browser_settings(enabled, headless, relay, cdp_url)
            .await
            .map_err(CommandError::Agent)
    }

    /// agent 自己那份设置目录。
    ///
    /// 目录是进程级事实，与连接锚在哪个工作区无关：用活着的连接。
    pub async fn settings_catalog(
        &self,
        agent: String,
        cwd: Option<String>,
    ) -> Result<SettingsCatalog, CommandError<E>> {
        let live = self.or_live(agent, cwd).await?;
        live.client
            .settings_catalog()
            .await
            .map_err(CommandError::Agent)
    }

    /// 改一格设置，交回改完之后整份目录的 settings 那一格。
    ///
    /// 写的是 agent 自己的持久层（它自己热重载），本层不碰它的 config 文件，也不预筛
    /// 路径与类型 —— 预筛就是第二份路径表，两边必然分叉。认不出的由 agent 自己拒绝。
    pub async fn set_setting(
        &self,
        agent: String,
        cwd: Option<String>,
        path: String,
        value: SettingValue,
    ) -> Result<Vec<SettingEntry>, CommandError<E>> {
        let live = self.or_live(agent, cwd).await?;
        live.client
            .set_setting(path, value)
            .await
            .map_err(CommandError::Agent)
    }

    /// 能力清单是进程级事实，与连接锚在哪个工作区无关，见 `or_live`。
    pub async fn capability_report(
        &self,
        agent: String,
        cwd: Option<String>,
    ) -> Result<Vec<Capability>, CommandError<E>> {
        let live = self.or_live(agent, cwd).await?;
        live.client
            .capabilities()
            .await
            .map_err(CommandError::Agent)
    }

    /// 开关一项本机能力；应答是改完之后的**整份**清单。
    ///
    /// 与 `capability_report` 同形是有意的：omp 里这一项没有「安装」这一步（它是构建期
    /// 编进来的 eval 前奏），一次开关只改一个设置，而清单里别的项也可能跟着变 ——
    /// 只交回被点的那一项就是把「别的项现在长什么样」丢给调用方去猜。
    pub async fn capability_install(
        &self,
        agent: String,
        cwd: Option<String>,
        capability: String,
        enabled: bool,
    ) -> Result<Vec<Capability>, CommandError<E>> {
        let live = self.or_live(agent, cwd).await?;
        live.client
            .install_capability(capability, enabled)
            .await
            .map_err(CommandError::Agent)
    }

    /// 读或改模型目录。
    ///
    /// 目录是 agent 自己的进程级事实（它按 mtime 热重载），与连接锚在哪个工作区无关：
    /// 用活着的连接。改成 `ensure` 会在 cwd 缺席时解析成兜底工作区，把用户对话正用的
    /// 连接拆掉——切模型那一趟正好紧跟在会话选择之后，拆掉就等于把刚改好的设置连人一起
    /// 丢掉（屏幕上是「设置没有改成」+「agent 已经退出」）。
    pub async fn model_catalog(
        &self,
        agent: String,
        cwd: Option<String>,
        operation: ModelCatalogOperation,
    ) -> Result<ModelCatalogSnapshot, CommandError<E>> {
        let live = self.or_live(agent, cwd).await?;
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
    ) -> Result<serde_json::Value, CommandError<E>> {
        self.require_live()?
            .client
            .read_transcript(session, agent, before)
            .await
            .map_err(CommandError::Agent)
    }

    pub async fn transcript_ops(
        &self,
        session: String,
        agent: String,
        since: i64,
    ) -> Result<serde_json::Value, CommandError<E>> {
        self.require_live()?
            .client
            .catch_up_transcript(session, agent, since)
            .await
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
