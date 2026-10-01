//! 构建期把命令面导出成 TypeScript。
//!
//! 命令清单与类型清单都在 `super::ipc`，这里只管把两者渲染成文件。命令的入口体不再是
//! Tauri 的 `invoke()`，而是渲染层经 preload 转发到 NAPI 的 `{ command, args }`；
//! 参数与返回值的类型一个字都不变，所以渲染层那次改动只在传输层。

use std::path::Path;

use heck::ToLowerCamelCase as _;
use specta::TypeCollection;
use specta::datatype::{DataType, Function, FunctionResultVariant};
use specta_typescript::Typescript;

/// 生成物的开头：接线、说明，以及那条唯一的传输函数。
///
/// `call` 不写在别处：生成的命令体只经它说话，而它只认一个东西 —— preload 装上的
/// `window.poietica`。渲染层因此既拿不到 `require`，也不必知道传输是谁实现的。
const HEADER: &str = r"
// 生成物，禁手改：由 `bun run ipc:generate` 从 apps/desktop/native/src/ipc/mod.rs 导出。
//
// 命令名与参数名是线上形状，与 Rust 一字不差；类型定义在同一个文件的上半部分。

declare global {
  interface Window {
    /** preload 装的唯一入口。渲染层没有 require，也没有 ipcRenderer。 */
    poietica: {
      invoke(command: string, args: unknown): Promise<unknown>
      on(kind: string, handler: (payload: unknown) => void): () => void
    }
  }
}

async function call<T>(command: string, args: unknown): Promise<T> {
  return (await window.poietica.invoke(command, args)) as T
}

";

/// 渲染层订阅的那些事件。线上名是 Rust 结构体名的 snake_case，与 `transport::emit` 的调用处一致。
const EVENTS: &[(&str, &str, &str)] = &[
    (
        "agentSessionEvent",
        "agent_session_event",
        "AgentSessionEvent",
    ),
    (
        "agentTranscriptEvent",
        "agent_transcript_event",
        "AgentTranscriptEvent",
    ),
    (
        "automationCatalogChanged",
        "automation_catalog_changed",
        "AutomationCatalogChanged",
    ),
    (
        "gitWorkingTreeChanged",
        "git_working_tree_changed",
        "GitWorkingTreeChanged",
    ),
    ("terminalStreamed", "terminal_streamed", "TerminalStreamed"),
];

/// 渲染成一份绑定文件。
pub(crate) fn write(path: &Path, options: &Typescript) -> Result<(), String> {
    let types = super::ipc::types();
    let functions = super::ipc::functions();

    let mut document = String::from(HEADER);
    document.push_str(&render_types(&types, options)?);
    document.push('\n');
    document.push_str(&render_commands(&functions, &types, options)?);
    document.push('\n');
    document.push_str(&render_events());

    std::fs::write(path, document).map_err(|error| error.to_string())
}

/// 类型定义。
fn render_types(types: &TypeCollection, options: &Typescript) -> Result<String, String> {
    let rendered = types
        .into_iter()
        .map(|(_, definition)| specta_typescript::export_named_datatype(options, definition, types))
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?;

    Ok(rendered.join("\n"))
}

/// 命令表：每条命令的文档注释原样保留 —— 它是渲染层唯一能看见的「这条命令干什么」。
///
/// 返回类型只写成功那一半：失败经 `call` 的拒绝到达，不走返回值的联合。Tauri 时代那
/// 一半是 `invoke` 的异常，语义相同，只是现在写在了类型上。
fn render_commands(
    functions: &[Function],
    types: &TypeCollection,
    options: &Typescript,
) -> Result<String, String> {
    let mut entries = Vec::new();

    for function in functions {
        let args = function
            .args()
            .map(|(name, ty)| {
                specta_typescript::datatype(
                    options,
                    &FunctionResultVariant::Value(ty.clone()),
                    types,
                )
                .map(|rendered| format!("{}: {rendered}", name.to_lower_camel_case()))
            })
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| error.to_string())?;

        let returned = specta_typescript::datatype(options, &success(function), types)
            .map_err(|error| error.to_string())?;

        let name = function.name().to_lower_camel_case();
        let names = function
            .args()
            .map(|(name, _)| name.to_string())
            .collect::<Vec<_>>();
        let call = format!(
            "call<{returned}>('{}', {})",
            function.name(),
            arguments(&names)
        );
        let docs = js_doc(function.docs());

        entries.push(format!(
            "{docs}  async {name}({args}): Promise<{returned}> {{\n    return {call}\n  }}",
            args = args.join(", ")
        ));
    }

    Ok(format!(
        "export const commands = {{\n{}\n}}\n",
        entries.join(",\n")
    ))
}

/// 一条命令的成功返回类型。`Result<T, E>` 取 T；没有返回值的取 null。
fn success(function: &Function) -> FunctionResultVariant {
    match function.result() {
        Some(FunctionResultVariant::Value(value)) => FunctionResultVariant::Value(value.clone()),
        Some(FunctionResultVariant::Result(value, _)) => {
            FunctionResultVariant::Value(value.clone())
        }
        None => {
            FunctionResultVariant::Value(DataType::Literal(specta::datatype::LiteralType::None))
        }
    }
}

/// 事件订阅：每一条都是「装一个处理器、交回一个卸掉它的函数」。
///
/// 同步返回卸载函数。异步返回会逼每个调用方在清理路径上再 await 一次，而清理路径多半
/// 是在组件卸载时跑的，那一刻再挂一个微任务只是把时序问题往后挪。
fn render_events() -> String {
    let mut entries = Vec::new();

    for (name, wire, ty) in EVENTS {
        entries.push(format!(
            "  {name}(handler: (payload: {ty}) => void): () => void {{\n    return window.poietica.on('{wire}', handler as (payload: unknown) => void)\n  }}"
        ));
    }

    format!("export const events = {{\n{}\n}}\n", entries.join(",\n"))
}

/// 参数对象的唯一一处：键与值都是同一个 lowerCamelCase 名字。
///
/// 线上（Rust 侧的 argument 取键、preload 的 IPC 载荷）与 TS 两侧共用这一个名字：
/// 一处名字两处写法，就必然出现「键是 snake_case、值是 camelCase」这类只在运行时
/// 才炸的错配，而 tsc 看不见它。
fn arguments(names: &[String]) -> String {
    if names.is_empty() {
        return "{}".to_owned();
    }

    let fields = names
        .iter()
        .map(|name| {
            let name = name.to_lower_camel_case();

            format!("{name}: {name}")
        })
        .collect::<Vec<_>>()
        .join(", ");

    format!("{{ {fields} }}")
}

/// 每条命令的文档注释渲染成 JSDoc。
///
/// 自己拼而不是调 specta-typescript 的 js_doc：它的入参结构体是 non_exhaustive，外部
/// crate 构造不出来。注释的来源相同（Rust 的 doc comment），形状也就三行。
fn js_doc(docs: &str) -> String {
    if docs.is_empty() {
        return String::new();
    }

    let body = docs
        .split('\n')
        .map(|line| format!(" * {line}"))
        .collect::<Vec<_>>()
        .join("\n");

    format!("/**\n{body} */\n")
}
