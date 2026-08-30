//! 受控的 agent CLI 调用。
//!
//! 模式 B 下，provider 与模型的写入路径只有一条：agent 自己的 CLI。我们不
//! 自己拼 TOML —— 那等于把对方的配置 schema 抄一份到这里，对方一改就坏，而且
//! 两个进程同时写同一个文件没有跨进程锁。
//!
//! 这不是通用的命令执行入口，也永远不该变成那个东西：
//!   - 子命令白名单，只放行 provider 的五条操作；
//!   - 拒绝任何含 shell 元字符的参数（虽然不经 shell，仍然拒绝，避免它被当成
//!     可以放心传任意文本的通道）；
//!   - 显式禁止 --api-key：Windows 上任何用户都能读到别的进程的完整命令行，
//!     密钥一律走环境变量注入。
//!
//! 目录文档只在「从目录添加 provider」时携带：对方的 catalog add 只吃一个
//! http(s) 的目录地址（默认 models.dev，部分网络下不可达），于是把渲染层带来
//! 的 api.json 绑在一次性 loopback 服务上，经官方 --url 喂给它。地址从绑定结果
//! 现算，不是用户输入；文档里没有密钥。

use crate::commands::catalog_server::CatalogServer;
use crate::error::{Error, Result};
use poietica_problem::Problem;
use serde::{Deserialize, Serialize};
use specta::Type;
use tauri::{AppHandle, async_runtime, command};

use super::profile::{agent_program, global_launch_env, global_provider_secret, launch_env};

type AgentCliCommandResult<T> = std::result::Result<T, Problem>;

const MAX_ARGS: usize = 16;
const MAX_ARG_LEN: usize = 512;
/// 目录文档的体积上限。三家厂商的 api.json 只有几 KB，64 KB 已经宽到离谱。
const MAX_CATALOG_BYTES: usize = 64 * 1024;

/// 反引号写成转义形式，避免源码里出现难以辨认的字面量。
const SHELL_METACHARACTERS: [char; 11] = [
    ';', '&', '|', '<', '>', '$', '\u{60}', '\n', '\r', '"', '\'',
];

/// 命令行上被禁止出现的参数。密钥只能走环境变量。
const FORBIDDEN_FLAGS: [&str; 2] = ["--api-key", "--apikey"];

#[derive(Debug, Deserialize, Serialize, Type, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AgentCliRequest {
    /// 用于算出受控 home，也用于从档案里查出该执行哪个程序。
    pub agent_id: String,
    /// 完整的子命令序列，例如 `["provider", "list", "--json"]`。
    ///
    /// 第一项是子命令名，`is_allowed` 看的就是它。
    ///
    /// 可执行文件不在这里。它曾经在：渲染层报一个程序路径过来，而白名单只
    /// 校验参数，于是 `{ command: 任意程序, args: ["provider", "list"] }` 会
    /// 被放行执行。程序现在由 `agent_program` 从档案里取。
    pub args: Vec<String>,
    /// 要注入的凭据环境变量名。它不是秘密，只是个名字。
    ///
    /// 缺席即不注入。此前它是必填，于是一次只读的 provider list 也得先声称自己
    /// 带着凭据、再用一对空字符串把这句话收回去 —— 用 "" 编码「没有」，而 ""
    /// 同时也是一个合法的变量名。
    #[serde(default)]
    pub secret_var: String,
    /// 凭据本身。只在内存里过一趟：注入子进程后随请求一起丢弃，不落盘、不进
    /// 日志，也永远不上命令行（见 `FORBIDDEN_FLAGS`）。缺席即不注入。
    #[serde(default)]
    pub secret_value: String,
    /// api.json 形状的目录文档：只在 catalog add 时携带。它会被绑在一次性
    /// loopback 服务上，经官方 --url 喂给对方的目录命令。
    #[serde(default)]
    pub catalog_document: Option<String>,
    /// 读用户全局 home 而不是受控 home。只为一次性导入的只读探测（provider
    /// list）使用；validate 会拒掉任何带着它的写操作。
    #[serde(default)]
    pub use_global_home: bool,
    /// 从用户全局配置里取哪家 provider 的密钥来注入。只为一次性导入使用：
    /// 密钥由原生侧从全局 config.toml 取出直达子进程，全程不进渲染层。
    /// 与 `secret_value` 互斥（validate 会拒掉同带）。
    #[serde(default)]
    pub secret_from_global_provider: Option<String>,
    // 受控 home 不在这里，也不该在：它由原生侧的 launch_env 用 paths::agent_home
    // 现算，与 kap 会话同源。让渲染层报一个路径过来，等于给了两条管线各算出不同
    // 目录的自由。
}

#[derive(Debug, Deserialize, Serialize, Type, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AgentCliResult {
    /// 进程退出码。被信号终止时为 -1。
    pub status: i32,
    pub stdout: String,
    pub stderr: String,
}

fn contains_metacharacter(text: &str) -> bool {
    SHELL_METACHARACTERS
        .iter()
        .any(|candidate| text.contains(*candidate))
}

/// 判断这串参数是否落在白名单内。
fn is_allowed(args: &[String]) -> bool {
    let first = args.first().map(String::as_str);
    let second = args.get(1).map(String::as_str);
    let third = args.get(2).map(String::as_str);

    if first != Some("provider") {
        return false;
    }

    match second {
        Some("list" | "add" | "remove") => true,
        Some("catalog") => matches!(third, Some("list" | "add")),
        _ => false,
    }
}

/// 「找不到那个程序」这一种失败的唯一文案。
///
/// 程序名来自我们自己的 agents.json，不是系统路径，所以说得出名字；which
/// 的错误里可能带上被搜过的目录，那部分丢掉。
fn missing_program(program: &str) -> Error {
    Error::AgentCli(format!(
        "找不到可执行文件 {program}，请确认它已安装并在 PATH 中"
    ))
}

/// 校验从档案里取出来的程序名。
///
/// 档案在 TS 侧过了 `parseAcpAgentProfile`，但那道校验不在这个进程里 ——
/// agents.json 是一个可以手改的文件，信它等于把校验交给了文本编辑器。
fn validate_program(program: &str) -> Result<()> {
    if program.is_empty() || program.len() > MAX_ARG_LEN {
        return Err(Error::AgentCli(
            "agent 接入档案里的程序名为空或超长".to_owned(),
        ));
    }

    if contains_metacharacter(program) {
        return Err(Error::AgentCli(
            "agent 接入档案里的程序名含有 shell 元字符".to_owned(),
        ));
    }

    Ok(())
}

fn validate(request: &AgentCliRequest) -> Result<()> {
    if request.args.len() > MAX_ARGS {
        return Err(Error::AgentCli(format!("参数不能超过 {MAX_ARGS} 项")));
    }

    for arg in &request.args {
        if arg.len() > MAX_ARG_LEN {
            return Err(Error::AgentCli("参数过长".to_owned()));
        }

        if contains_metacharacter(arg) {
            return Err(Error::AgentCli(format!("参数含有不被接受的字符：{arg}")));
        }

        let lowered = arg.to_ascii_lowercase();

        if FORBIDDEN_FLAGS
            .iter()
            .any(|flag| lowered == *flag || lowered.starts_with(&format!("{flag}=")))
        {
            return Err(Error::AgentCli(
                "密钥不能出现在命令行上，请使用环境变量注入".to_owned(),
            ));
        }
    }

    if !is_allowed(&request.args) {
        return Err(Error::AgentCli(
            "只允许 provider list / add / remove / catalog list / catalog add".to_owned(),
        ));
    }

    // 全局 home 只给一次性导入的只读探测用。带着它做任何别的操作一律拒绝 ——
    // 往全局 home 写入不在任何一条已批准的管线上。
    if request.use_global_home && request.args.get(1).map(String::as_str) != Some("list") {
        return Err(Error::AgentCli(
            "用户全局 home 只允许只读的 provider list".to_owned(),
        ));
    }

    if let Some(document) = &request.catalog_document {
        let is_catalog_add = request.args.get(1).map(String::as_str) == Some("catalog")
            && request.args.get(2).map(String::as_str) == Some("add");

        if !is_catalog_add {
            return Err(Error::AgentCli(
                "目录文档只在从目录添加 provider 时使用".to_owned(),
            ));
        }

        if document.is_empty() || document.len() > MAX_CATALOG_BYTES {
            return Err(Error::AgentCli("目录文档为空或超出大小上限".to_owned()));
        }
    }

    if let Some(provider_id) = &request.secret_from_global_provider {
        let is_catalog_add = request.args.get(1).map(String::as_str) == Some("catalog")
            && request.args.get(2).map(String::as_str) == Some("add");

        if !is_catalog_add {
            return Err(Error::AgentCli(
                "从全局配置取密钥只用于从目录添加 provider".to_owned(),
            ));
        }

        if provider_id.is_empty() || !request.secret_value.is_empty() {
            return Err(Error::AgentCli(
                "密钥二选一：随请求携带，或从全局配置取，不能同带".to_owned(),
            ));
        }
    }

    Ok(())
}

/// 在白名单内调用 agent 的 CLI。
///
/// 凭据由调用方随这一次请求带上，经环境变量注入子进程。
///
/// 我们不保存它。agent 的 CLI 会把它写进 agent 自己的配置文件，那之后它与
/// Poietica 无关 —— 包括「配没配过」这个问题，答案也在那边。
///
/// # Errors
///
/// 参数未通过白名单校验、或子进程无法启动时返回错误。子进程本身以非零码退出
/// 不算错误 —— 那是调用方需要看到的结果，通过 status 与 stderr 返回。
#[command]
#[specta::specta]
pub async fn agent_cli_exec(
    app: AppHandle,
    request: AgentCliRequest,
) -> AgentCliCommandResult<AgentCliResult> {
    validate(&request).map_err(Problem::from)?;

    // 程序与环境来自同一份档案。CLI 用哪个程序、往哪个 home 写 provider，
    // 都得与 kap 会话起来的那个进程一致 —— 两处各算一次，迟早算出两个。
    let program = agent_program(&app, &request.agent_id).map_err(Problem::from)?;
    validate_program(&program).map_err(Problem::from)?;

    let env = if request.use_global_home {
        global_launch_env(&app, &request.agent_id)
    } else {
        launch_env(&app, &request.agent_id)
    }
    .map_err(Problem::from)?;

    // 裸名字不是一条可启动的路径：Windows 上包管理器装出来的是 kimi.CMD，
    // CreateProcess 只补 .exe、不读 PATHEXT，于是 Command::new("kimi") 直接
    // NotFound —— 明明装了，界面却报找不到。kap 会话那条路径一直是解析过的，
    // 这条没有，同一个程序两条管线一条找得到一条找不到。
    //
    // 这也是「路径不能写死」的答案：解析用的是运行这台机器的 PATH 与
    // PATHEXT，agents.json 里换成绝对路径也照样原样通过。
    let resolved = poietica_kap_client::resolve_program(&program)
        .map_err(|_searched| missing_program(&program))
        .map_err(Problem::from)?;

    // 密钥二选一：随请求带来的，或现在从全局配置取出 —— 不管哪种，都在 request
    // 被目录服务的 match 与闭包拆走之前落袋。
    let secret = match request.secret_from_global_provider {
        Some(provider_id) => {
            global_provider_secret(&app, &request.agent_id, &provider_id).map_err(Problem::from)?
        }
        None => request.secret_value,
    };

    // 目录服务只活到这次调用结束：它随闭包进入阻塞线程，子进程退出、闭包返回时
    // 被 Drop，端口随即释放 —— 不论这次调用成败。--url 在这里追加而不是经调用方
    // —— 地址从绑定结果现算，不是用户输入，所以放在白名单校验之后。
    let catalog_server = match request.catalog_document {
        Some(document) => Some(
            CatalogServer::start(document)
                .map_err(|error| Error::Internal(format!("无法启动目录服务：{error}")))
                .map_err(Problem::from)?,
        ),
        None => None,
    };

    let spawned = async_runtime::spawn_blocking(move || {
        let mut final_args = request.args.clone();

        if let Some(server) = &catalog_server {
            final_args.push("--url".to_owned());
            final_args.push(server.url());
        }

        let mut command = std::process::Command::new(&resolved);
        command.args(&final_args);
        command.envs(env);

        // 目录服务绑在 127.0.0.1 上，而子进程继承了我们这个进程的全部环境变量，
        // 其中很可能有 HTTP_PROXY / HTTPS_PROXY / ALL_PROXY。
        //
        // 这不是杞人忧天：会走到这条导入路径的人，正是因为上面那句「默认目录是
        // models.dev，部分网络下不可达」才需要它 —— 也就最可能挂着代理。一旦对方
        // 的 HTTP 客户端认这几个变量，这次本机取文档就会被送进代理然后失败，而
        // 报出来的仍然只是一句 fetch failed，看不出是被谁劫走的。
        //
        // no_proxy 是这件事的通用答案（curl、npm、git、Node 生态都认它）。两种
        // 大小写都设，不同客户端读的不是同一个；只在真的起了目录服务时设，不去
        // 影响别的调用。
        if catalog_server.is_some() {
            command.env("NO_PROXY", "127.0.0.1,localhost");
            command.env("no_proxy", "127.0.0.1,localhost");
        }

        poietica_kap_client::hide_console(&mut command);

        if !request.secret_var.is_empty() && !secret.is_empty() {
            command.env(&request.secret_var, &secret);
        }

        command.output()
    })
    .await
    .map_err(|error| Error::Internal(error.to_string()))
    .map_err(Problem::from)?;

    // 「没装」是这里最常见的一种失败，也是用户自己能解决的那一种。其余的
    // io 错误可能带上系统路径，仍然走脱敏。
    let output = spawned
        .map_err(|error| {
            if error.kind() == std::io::ErrorKind::NotFound {
                // 解析成功之后仍然 NotFound：文件在这两步之间被移走了。
                missing_program(&program)
            } else {
                Error::Internal(format!("无法启动 agent CLI：{error}"))
            }
        })
        .map_err(Problem::from)?;

    Ok(AgentCliResult {
        status: output.status.code().unwrap_or(-1),
        stdout: String::from_utf8_lossy(&output.stdout).into_owned(),
        stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
    })
}
