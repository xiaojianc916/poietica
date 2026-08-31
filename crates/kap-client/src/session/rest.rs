//! kap 的 REST 调用面：sessions / prompts / approvals / profile / goal。
//!
//! 信封约定 { code, msg, data, request_id }：业务成败看 code，不看 HTTP 状态
//! （contracts/kap 的 openapi.json）。data 按生成类型解码；选择器面（status /
//! models / goal）的 Value 归 config.rs。

use std::path::Path;

use serde_json::{Value, json};

use crate::connection::handshake::subscribe;
use crate::connection::socket::WsSink;
use crate::error::{KapError, Result};
use crate::generated::rest::{
    CreateSessionDataStruct, CreateSessionRequestAgentConfigStruct,
    CreateSessionRequestMetadataStruct, CreateSessionRequestStruct,
    ListCapabilitiesDataCapabilitiesStateEnum, ListCapabilitiesDataCapabilitiesStruct,
    ListCapabilitiesDataStruct, ListMcpServersDataServersStatusEnum,
    ListMcpServersDataServersTransportEnum, ListMcpServersDataStruct, ListSessionsDataStruct,
    ListSkillsDataSkillsSourceEnum, ListSkillsDataStruct, SessionSnapshotDataStruct,
    SetProfileRequestStruct, SubmitPromptDataStruct, SubmitPromptRequestContentChoice,
    SubmitPromptRequestContentChoiceImageSourceChoice, SubmitPromptRequestSkillsStruct,
    SubmitPromptRequestStruct,
};
use crate::session::book::SessionBook;
use crate::session::client::{PromptAttachment, PromptSkill};
use crate::session::config::{
    ConfigControl, GoalSnapshot, controls, goal_snapshot, selector_patch,
};
use crate::session::{
    Capability, CapabilityInstall, CapabilityReadiness, Cursor, McpServer, McpStatus, McpTransport,
    OpenedSession, Skill,
};

/// 取信封里的 data。信封的 code 判据只有一处：根上那个类型化的 envelope_data。
/// data 在这里仍是 Value —— 各路由的类型化解码随路由消费一批批接上。
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

/// 按快照类型读一条 data：字段名与形状的判据只有生成类型，没有第二条手挖的路。
fn decoded<T: serde::de::DeserializeOwned>(data: Value, what: &str) -> Result<T> {
    serde_json::from_value(data).map_err(|error| KapError::Transport {
        message: format!("{what} does not fit the pinned contract: {error}"),
    })
}

pub(crate) async fn get(http: &reqwest::Client, url: &str) -> Result<Value> {
    send(http.get(url)).await
}

pub(crate) async fn post<T: serde::Serialize>(
    http: &reqwest::Client,
    url: &str,
    body: &T,
) -> Result<Value> {
    send(http.post(url).json(body)).await
}

/// 发请求、解信封。get 与 post 只差请求的构造，收发与解包走同一条路。
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

/// POST /sessions 的请求体：sessionCreateSchema 只认 metadata.cwd 与 workspace_id。
pub(crate) fn create_session_body(cwd: &Path) -> CreateSessionRequestStruct {
    CreateSessionRequestStruct {
        metadata: Some(CreateSessionRequestMetadataStruct {
            cwd: cwd.to_string_lossy().into_owned(),
        }),
        ..Default::default()
    }
}

/// POST /sessions/{id}/profile 的请求体：只带要改的那一格，其余缺席不上 wire。
pub(crate) fn profile_body(
    patch: CreateSessionRequestAgentConfigStruct,
) -> SetProfileRequestStruct {
    SetProfileRequestStruct {
        agent_config: Some(patch),
        ..Default::default()
    }
}

/// 提交一句话。幂等键随载荷上 wire（快照的 SubmitPromptRequest.prompt_id）：
/// 重试投递时 server 收过就不重复入列，所以 ambiguous 的传输失败可以重试。
pub(crate) async fn submit_prompt(
    http: &reqwest::Client,
    base_url: &str,
    session_id: &str,
    text: &str,
    attachments: &[PromptAttachment],
    skills: &[PromptSkill],
    idempotency: &str,
) -> Result<String> {
    let mut body = prompt_body(text, attachments, skills)?;
    let retryable = body.skills.is_none();
    if retryable {
        body.prompt_id = Some(idempotency.to_owned());
    }
    let url = format!("{base_url}/sessions/{session_id}/prompts");
    let mut attempt = 0_u32;
    let data = loop {
        attempt = attempt.saturating_add(1);
        match post(http, &url, &body).await {
            Ok(data) => break data,
            Err(KapError::Transport { message }) if retryable && attempt < 3 => {
                log::warn!("ambiguous prompt submission {attempt}/3: {message}");
                tokio::time::sleep(std::time::Duration::from_millis(200 * u64::from(attempt)))
                    .await;
            }
            Err(error) => return Err(error),
        }
    };

    let accepted: SubmitPromptDataStruct = decoded(data, "prompt submission")?;

    Ok(accepted.prompt_id)
}

fn prompt_body(
    text: &str,
    attachments: &[PromptAttachment],
    skills: &[PromptSkill],
) -> Result<SubmitPromptRequestStruct> {
    let mut content = Vec::new();
    if !text.is_empty() {
        content.push(SubmitPromptRequestContentChoice::Text {
            text: text.to_owned(),
        });
    }
    for attachment in attachments {
        match attachment {
            PromptAttachment::Image {
                data, mime_type, ..
            } => content.push(SubmitPromptRequestContentChoice::Image {
                source: SubmitPromptRequestContentChoiceImageSourceChoice::Base64 {
                    media_type: mime_type.clone(),
                    data: data.clone(),
                },
            }),
            PromptAttachment::Text { text, .. } => {
                content.push(SubmitPromptRequestContentChoice::Text { text: text.clone() });
            }
        }
    }
    if content.is_empty() {
        return Err(KapError::Validation {
            message: "prompt has no content".to_owned(),
        });
    }
    let activations: Vec<SubmitPromptRequestSkillsStruct> = skills
        .iter()
        .map(|skill| SubmitPromptRequestSkillsStruct {
            name: skill.name.clone(),
            args: skill
                .args
                .as_deref()
                .filter(|args| !args.is_empty())
                .map(str::to_owned),
        })
        .collect();
    Ok(SubmitPromptRequestStruct {
        content,
        skills: (!activations.is_empty()).then_some(activations),
        ..Default::default()
    })
}

/// 原子快照先由生成契约验证；调用方只消费水位与重建载荷。
pub(crate) async fn session_snapshot(
    http: &reqwest::Client,
    base_url: &str,
    session_id: &str,
) -> Result<(Cursor, Value)> {
    let data = get(http, &format!("{base_url}/sessions/{session_id}/snapshot")).await?;
    let snapshot: SessionSnapshotDataStruct = decoded(data.clone(), "snapshot")?;

    Ok((
        Cursor {
            seq: snapshot.as_of_seq,
            epoch: Some(snapshot.epoch),
        },
        data,
    ))
}

/// 三条会话出生路（新开 / 装载 / 分叉）共用的激活序列。
async fn activate(
    http: &reqwest::Client,
    base_url: &str,
    session_id: &str,
    from: Option<&Cursor>,
    book: &SessionBook,
    ws: &WsSink,
) -> Result<OpenedSession> {
    book.open(session_id)?;
    subscribe(ws, session_id, from).await?;

    ensure_model(http, base_url, session_id).await;

    Ok(OpenedSession {
        session_id: session_id.to_owned(),
        selectors: best_effort_selectors(http, base_url, session_id).await,
    })
}

pub(crate) async fn open_session(
    http: &reqwest::Client,
    base_url: &str,
    cwd: &Path,
    book: &SessionBook,
    ws: &WsSink,
) -> Result<OpenedSession> {
    let data = post(
        http,
        &format!("{base_url}/sessions"),
        &create_session_body(cwd),
    )
    .await?;

    let opened: CreateSessionDataStruct = decoded(data, "created session")?;

    activate(http, base_url, &opened.id, None, book, ws).await
}

/// kap 的会话在 server 侧持久：装载 = 验存在 + 重新订阅。号在 server 侧也没了
/// 时，GET 的信封带非零 code，在这里变成 Err —— 调用侧据此走 Forgotten 路径
/// （桌面 seam 的 addressing.rs）。
pub(crate) async fn load_session(
    http: &reqwest::Client,
    base_url: &str,
    session_id: &str,
    from: Option<&Cursor>,
    book: &SessionBook,
    ws: &WsSink,
) -> Result<OpenedSession> {
    get(http, &format!("{base_url}/sessions/{session_id}")).await?;

    activate(http, base_url, session_id, from, book, ws).await
}

pub(crate) async fn fork_session(
    http: &reqwest::Client,
    base_url: &str,
    source_id: &str,
    drop_turns: u32,
    book: &SessionBook,
    ws: &WsSink,
) -> Result<OpenedSession> {
    // 动作后缀路由：POST /sessions/{id}:fork（routes/action-suffix.ts）。
    let data = post(
        http,
        &format!("{base_url}/sessions/{source_id}:fork"),
        &json!({}),
    )
    .await?;

    let forked: CreateSessionDataStruct = decoded(data, "forked session")?;
    let id = forked.id;

    // 分叉点。:fork 的请求体只有 title 与 metadata（kap-server 的
    // sessionForkSchema），没有分叉点这一格；能回退上下文的只有 :undo，它按用户
    // 轮次数收（undoSessionRequestSchema 的 count）。回退落在复制件上，源会话
    // 一个字不动。
    if drop_turns > 0 {
        post(
            http,
            &format!("{base_url}/sessions/{id}:undo"),
            &json!({ "count": drop_turns }),
        )
        .await?;
    }

    activate(http, base_url, &id, None, book, ws).await
}

pub(crate) async fn archive_session(
    http: &reqwest::Client,
    base_url: &str,
    session_id: &str,
    book: &SessionBook,
) -> Result<()> {
    post(
        http,
        &format!("{base_url}/sessions/{session_id}:archive"),
        &json!({}),
    )
    .await?;

    let _ = book.close(session_id);

    Ok(())
}

pub(crate) async fn list_sessions(
    http: &reqwest::Client,
    base_url: &str,
) -> Result<Vec<crate::session::SessionEntry>> {
    let data = get(http, &format!("{base_url}/sessions")).await?;
    let listed: ListSessionsDataStruct = decoded(data, "session list")?;

    Ok(listed
        .items
        .into_iter()
        .map(|item| crate::session::SessionEntry {
            session_id: item.id,
            title: (!item.title.is_empty()).then_some(item.title),
            updated_at: item.updated_at.as_str().map(str::to_owned),
        })
        .collect())
}

/// 选择器表：生效值由 status 路由报，候选由 /models 目录报（config.rs 的
/// controls 把两张表拼成一张）。新会话刚出生时表读不出来不是故障 —— 它下一
/// 次被问（capabilities / open_thread）时会再读一次。
async fn best_effort_selectors(
    http: &reqwest::Client,
    base_url: &str,
    session_id: &str,
) -> Vec<ConfigControl> {
    match get_selectors(http, base_url, session_id).await {
        Ok((offered, _goal)) => offered,
        Err(error) => {
            log::warn!("could not read the session's selectors: {error}");
            Vec::new()
        }
    }
}

/// 这条会话能用的技能（rest-skill.ts 的 listSkillsResponseSchema）。
pub(crate) async fn list_skills(
    http: &reqwest::Client,
    base_url: &str,
    session_id: &str,
) -> Result<Vec<Skill>> {
    let data = get(http, &format!("{base_url}/sessions/{session_id}/skills")).await?;
    let listed: ListSkillsDataStruct = decoded(data, "skill list")?;

    Ok(listed
        .skills
        .into_iter()
        .map(|item| Skill {
            name: item.name,
            description: item.description,
            source: skill_source(item.source).to_owned(),
        })
        .collect())
}

/// 技能来源的领域写法与 wire 同名；判别式在生成枚举里，这里只落成名字。
const fn skill_source(source: ListSkillsDataSkillsSourceEnum) -> &'static str {
    match source {
        ListSkillsDataSkillsSourceEnum::Project => "project",
        ListSkillsDataSkillsSourceEnum::User => "user",
        ListSkillsDataSkillsSourceEnum::Extra => "extra",
        ListSkillsDataSkillsSourceEnum::Builtin => "builtin",
    }
}

pub(crate) async fn list_mcp_servers(
    http: &reqwest::Client,
    base_url: &str,
) -> Result<Vec<McpServer>> {
    let data = get(http, &format!("{base_url}/mcp/servers")).await?;
    let listed: ListMcpServersDataStruct = decoded(data, "MCP server list")?;

    listed
        .servers
        .into_iter()
        .map(|item| {
            Ok(McpServer {
                id: item.id,
                name: item.name,
                transport: match item.transport {
                    ListMcpServersDataServersTransportEnum::Stdio => McpTransport::Stdio,
                    ListMcpServersDataServersTransportEnum::Http => McpTransport::Http,
                    ListMcpServersDataServersTransportEnum::Sse => McpTransport::Sse,
                },
                status: match item.status {
                    ListMcpServersDataServersStatusEnum::Connected => McpStatus::Connected,
                    ListMcpServersDataServersStatusEnum::Connecting => McpStatus::Connecting,
                    ListMcpServersDataServersStatusEnum::Disconnected => McpStatus::Disconnected,
                    ListMcpServersDataServersStatusEnum::Error => McpStatus::Error,
                },
                tool_count: u32::try_from(item.tool_count).map_err(|_| KapError::Transport {
                    message: format!("MCP tool_count is out of range: {}", item.tool_count),
                })?,
                last_error: item.last_error,
            })
        })
        .collect()
}

/// 本机 KAP 报的能力清单。生成类型先验证 wire，随后才进入领域映射。
pub(crate) async fn list_capabilities(
    http: &reqwest::Client,
    base_url: &str,
) -> Result<Vec<Capability>> {
    let data = get(http, &format!("{base_url}/capabilities")).await?;
    let listed: ListCapabilitiesDataStruct = decoded(data, "capability list")?;

    Ok(listed.capabilities.into_iter().map(capability_of).collect())
}

const CAPABILITY_POLL_INTERVAL: std::time::Duration = std::time::Duration::from_millis(700);
/// 等待上限 10 分钟：上游光 Windows runtime 一步就给 180s（kimi-code 的
/// WINDOWS_INSTALL_TIMEOUT_MS），之外还有下载、插件层与体检 —— 等短了会把还在
/// 装的判成装失败。
const CAPABILITY_POLL_ATTEMPTS: u32 = 600_000 / 700;

/// 启动或跟随 KAP 的后台安装，直到它明确落定。
pub(crate) async fn install_capability(
    http: &reqwest::Client,
    base_url: &str,
    capability_id: &str,
) -> Result<Capability> {
    let mut latest = get_capability(http, base_url, capability_id).await?;

    if latest.state == CapabilityReadiness::Ready && !latest.install.running {
        return Ok(latest);
    }

    if !latest.install.running {
        let accepted = post(
            http,
            &format!("{base_url}/capabilities/{capability_id}:install"),
            &serde_json::json!({}),
        )
        .await?;
        latest = capability_of(decoded(accepted, "capability")?);
    }

    for _ in 0..CAPABILITY_POLL_ATTEMPTS {
        if !latest.install.running {
            return Ok(latest);
        }
        tokio::time::sleep(CAPABILITY_POLL_INTERVAL).await;
        latest = get_capability(http, base_url, capability_id).await?;
    }

    Err(KapError::Timeout {
        message: format!("kap is still installing {capability_id}"),
    })
}

async fn get_capability(
    http: &reqwest::Client,
    base_url: &str,
    capability_id: &str,
) -> Result<Capability> {
    let data = get(http, &format!("{base_url}/capabilities/{capability_id}")).await?;

    Ok(capability_of(decoded(data, "capability")?))
}

fn capability_of(wire: ListCapabilitiesDataCapabilitiesStruct) -> Capability {
    Capability {
        id: wire.id,
        plugin_id: wire.plugin_id,
        label: wire.display_name,
        supported: wire.supported,
        state: match wire.state {
            ListCapabilitiesDataCapabilitiesStateEnum::NotInstalled => {
                CapabilityReadiness::NotInstalled
            }
            ListCapabilitiesDataCapabilitiesStateEnum::Partial => CapabilityReadiness::Partial,
            ListCapabilitiesDataCapabilitiesStateEnum::Ready => CapabilityReadiness::Ready,
            ListCapabilitiesDataCapabilitiesStateEnum::Unsupported => {
                CapabilityReadiness::Unsupported
            }
        },
        install: CapabilityInstall {
            running: wire.install.running,
            step: wire.install.step,
            percent: wire.install.percent,
            error: wire.install.error,
        },
    }
}

/// 给这条会话绑上模型。
///
/// 新开的会话没有模型：POST /sessions 的 body 里就没有这一格
/// （createSessionRequestSchema 只收 title / metadata / workspace_id），服务器建完
/// 会话回的 agent_config.model 是写死的空串（routes/sessions.ts 的 toWireSession）。
/// 而 agent 走第一步就要模型，没有就是 [model.not_configured] Model not set —— 一句
/// 话都答不出来，回合以 turn.ended reason=failed 收场。
///
/// 全局默认模型是 config 域的一个值（GET /config 的 default_model），会话不继承它：
/// 绑上去是开会话这一方的活，kap 只给了 POST /sessions/{id}/profile 这一个入口
/// （applySessionAgentConfig → IAgentProfileService.setModel，空串会被它跳过）。
///
/// 判据全部来自服务器：生效值问 status，默认值问 /config。本 crate 另有一条读
/// config.toml 的路（process/controlled_home.rs），那是装配阶段判断「这个别名有没有
/// 可用凭据」的本地对照，不是这里的依据 —— 同一件事有两个说法，迟早对不上。
///
/// 已经有模型的会话原样不动：装载与分叉带回来的选择是用户的，不是我们的。
///
/// 绑不上不在这里判死。握手一失败，界面连让用户改模型的地方都没有了；原因写进
/// 日志，真回合会带着 agent 自己的原话失败（run_failed 的 message）。
pub(crate) async fn ensure_model(http: &reqwest::Client, base_url: &str, session_id: &str) {
    let status = match get(http, &format!("{base_url}/sessions/{session_id}/status")).await {
        Ok(status) => status,
        Err(error) => {
            log::warn!("could not read the session's model: {error}");
            return;
        }
    };

    if status
        .get("model")
        .and_then(Value::as_str)
        .is_some_and(|model| !model.is_empty())
    {
        return;
    }

    let config = match get(http, &format!("{base_url}/config")).await {
        Ok(config) => config,
        Err(error) => {
            log::warn!("could not read the default model: {error}");
            return;
        }
    };

    let Some(default_model) = config
        .get("default_model")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|alias| !alias.is_empty())
    else {
        log::warn!(
            "this kimi has no default model configured, so the session stays without one and every turn ends in model.not_configured"
        );
        return;
    };

    if let Err(error) = post(
        http,
        &format!("{base_url}/sessions/{session_id}/profile"),
        &profile_body(CreateSessionRequestAgentConfigStruct {
            model: Some(default_model.to_owned()),
            ..Default::default()
        }),
    )
    .await
    {
        log::warn!("could not set the session's model to {default_model}: {error}");
    }
}

pub(crate) async fn abort_session(
    http: &reqwest::Client,
    base_url: &str,
    session_id: &str,
) -> Result<()> {
    post(
        http,
        &format!("{base_url}/sessions/{session_id}:abort"),
        &json!({}),
    )
    .await?;
    Ok(())
}

/// 读取目标真相；协议缺席与传输失败不能合并。
pub(crate) async fn fetch_goal(
    http: &reqwest::Client,
    base_url: &str,
    session_id: &str,
) -> Result<Option<GoalSnapshot>> {
    let goal = get(http, &format!("{base_url}/sessions/{session_id}/goal")).await?;

    Ok(goal_snapshot(&goal))
}

/// 选择器表与目标快照一趟取回：turn.ended 收尾两样都要，分开打就是同一轮里
/// 第二次 /goal。
pub(crate) async fn get_selectors(
    http: &reqwest::Client,
    base_url: &str,
    session_id: &str,
) -> Result<(Vec<ConfigControl>, Option<GoalSnapshot>)> {
    let status = get(http, &format!("{base_url}/sessions/{session_id}/status")).await?;
    let catalog = get(http, &format!("{base_url}/models")).await?;
    let goal = get(http, &format!("{base_url}/sessions/{session_id}/goal")).await?;
    Ok((controls(&status, &catalog, &goal), goal_snapshot(&goal)))
}

pub(crate) async fn set_selector(
    http: &reqwest::Client,
    base_url: &str,
    session_id: &str,
    config_id: &str,
    value: &str,
    input: Option<&str>,
) -> Result<Vec<ConfigControl>> {
    let (current, _goal) = get_selectors(http, base_url, session_id).await?;
    let control = current
        .iter()
        .find(|control| control.id == config_id)
        .ok_or_else(|| KapError::Validation {
            message: format!("the session offers no control {config_id}"),
        })?;
    if control.current == value && input.is_none() {
        return Ok(current);
    }
    if !control.choices.iter().any(|choice| choice.value == value) {
        return Err(KapError::Validation {
            message: format!("control {config_id} does not offer {value}"),
        });
    }
    let patch = selector_patch(config_id, value, input)?;
    post(
        http,
        &format!("{base_url}/sessions/{session_id}/profile"),
        &profile_body(patch),
    )
    .await?;
    let (selectors, _goal) = get_selectors(http, base_url, session_id).await?;
    Ok(selectors)
}

#[cfg(test)]
mod tests {
    // 与 tests/recorder.rs 顶上那一句同一条纪律、同一个理由（Cargo.toml lints
    // 注释）：测试里的 expect 是响亮失败，豁免只写在测试作用域，不靠根配置放开。
    #![allow(
        clippy::expect_used,
        reason = "a test proves itself by panicking, so a failed step must fail the test"
    )]

    use super::*;

    #[test]
    fn bundled_skills_share_one_prompt_and_never_send_a_client_prompt_id() {
        let body = prompt_body(
            "review this",
            &[],
            &[PromptSkill {
                name: "research".to_owned(),
                args: None,
            }],
        )
        .expect("prompt body");
        let wire = serde_json::to_value(&body).expect("wire body");
        assert!(wire.get("prompt_id").is_none());
        assert_eq!(
            wire.get("skills").and_then(Value::as_array).map(Vec::len),
            Some(1)
        );
        assert_eq!(
            wire.get("content").and_then(Value::as_array).map(Vec::len),
            Some(1)
        );
    }
}
