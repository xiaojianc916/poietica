# 0016 — kimi 起的是 acp-v2 入口

> 已被 [ADR 0026](0026-kap-is-the-only-agent-transport.md) 取代：传输是 kap，不再有 ACP。

> 传输选型部分已由 ADR 0025 取代。

> Status: superseded by ADR 0025.

状态：已定。取代同编号的前一版结论 —— 那一版反对切换的三条理由里，两条已被
证据推翻（v2 自带 builtin-commands.ts 与 slash.ts；fs 反向 RPC legacy 也有）。

注（2026-08-11）：上游 0.33.0 起把 agent-core-v2 设为 `acp` 子命令的默认引擎并退役
`acp-v2` 子命令，现行档案因此起 `kimi acp`（见 packages/agent-catalog/src/kimi/descriptor.ts）。
本篇的选型理由与契约事实不变。

## 上游有两套并存的 ACP 实现

事实来源：MoonshotAI/kimi-code @ c396873。

| 子命令 | 后端包 | 上游自己的说法 |
| --- | --- | --- |
| kimi acp | @moonshot-ai/acp-adapter | acp-v2.ts 逐字：the legacy acp-adapter over the SDK harness |
| kimi acp-v2 | @moonshot-ai/acp-server + agent-core-v2 | experimental agent-core-v2 engine，惰性 import 隔离 |

## 切换的唯一必要理由：子代理的审批在 legacy 里到不了客户端

- legacy：acp-adapter/src/session.ts 的 onEvent 首行按 MAIN_AGENT_ID 过滤，
  子代理的审批请求随事件流一起被丢弃。引擎侧的 AgentPermissionGate 于是停在
  那里等一个永不到来的回答 —— 这就是「一调用子代理就卡死」。
- v2：acp-server/src/interaction-bridge.ts 不看事件流。它订阅
  interactions.changed（每次变更推送整份 pending 集合），逐条并发派发，用
  inFlight 集合防重入。interactions 是 Session 作用域，全文没有 agentId 一词。

过滤发生在上游包内部，客户端侧无论怎么改都碰不到。这一条在 legacy 上无解。

## 契约不变，所以我们侧零改动

- 审批 optionId：approve_once / approve_always / reject / plan_approve /
  plan_revise / plan_reject_and_exit / plan_opt_<i>，并继续接受 legacy 的
  approve 与 approve_for_session。与 acp-adapter 逐字相同。
- 提问 optionId：q<n>_opt_<i> 与 q<n>_skip。我们的 QUESTION_DIALECT 是超集。
- 选项名七个全在 OPTION_LABELS 里：Approve once、Approve for this session、
  Reject、Approve、Revise、Reject and Exit、Skip。
- server.ts 的 initialize 同时声明 sessionCapabilities.close 与 .delete，
  driver.rs 读的 .delete 仍然成立 —— Rust 侧一行不动。
- 提问卡的 content 是 q.question 本身，不再是入参 JSON。

## session/close：上游有，我们从来没发过

这一条要留证，因为两份证据打架，而赢的是源码：

- acp-server/test/close.test.ts 逐字
  expect(init.agentCapabilities?.sessionCapabilities?.close).toBeDefined()，
  随后 session/close 通过；另一条测试逐字 closing an unknown sessionId is a
  best-effort no-op，返回 {}。
- acp-server/test/initialize.test.ts 还多一格：sessionCapabilities 里有
  additionalDirectories、delete、fork。（toMatchObject 允许额外键，所以它不构成
  close 缺席的反证。）
- 上游自己的 docs/zh/reference/kimi-acp.md 那张能力矩阵把 session/close 记成
  缺席。那份文档过时了。别信它，信 test 和 server.ts。

我们这侧：driver.rs 的握手只读 sessionCapabilities.delete，commands.rs 的
Command 枚举里按会话的关闭一条都没有 —— 只有 Shutdown（整条连接）和
DeleteSession（连 agent 那侧的历史一起删）。sessions.rs 的 SessionBook::close
逐字 Forgets a session：本地忘了，从没告诉 agent。v2 是 DI x Scope 引擎，
Session scope 持着日志写入器和一批按会话注册的服务（acpFsService.ts 逐字
registerScopedService(LifecycleScope.Session, ...)），不 close 就是攒着。

为什么这一刀不接：close 的正确调用点是"用户关掉或切走一条对话"，那在前端。
把它塞进 Shutdown 里凑一个调用点是仪式 —— 进程紧接着就死了。下一刀先读
apps/desktop/src-tauri 的命令表、packages/ipc、packages/agent-session 的
ThreadPort 实现，找到那个真实的时机，再动 Command 枚举。

## 顺带白拿的

- tool_call 带 locations（toolCallLocations，只发绝对路径，缺则省略不编造）。
- 懒建卡在 tool.call.started 到达时补齐 rawInput（legacy 永远补不上，意图轴
  因此在部分卡上必然落空）。
- todo_list 投影成 plan；usage_update；session_info_update（会话标题）；
  config_option_update 与 current_mode_update 并存。
- session/fork（上游标 UNSTABLE）、session/list 的 cwd 过滤、logout。

## 明确不做

- 不声明 clientCapabilities.fs。理由不是"还没实现"，那种理由只会招来下一次
  实现：这项能力存在的全部意义是客户端手上有一份比磁盘更新的事实 —— 编辑器里
  未保存的缓冲区。Zed 实现它是因为 Zed 是编辑器。我们不是：整个前端没有 buffer
  store，一次 fs/read_text_file 只会变成 agent 求我们读同一块盘、我们读了、把
  字节原样递回去。零新增事实，外加三个新的出错面（路径语义、编码、行窗口）。
  什么时候该重新考虑：我们自己开始持有文件状态的那一天，不是别的日子。
- 不声明 clientCapabilities.terminal。声明即承诺由我们起进程、持有、响应 kill
  与 release。能力关闭时 acp-server 走 execLocal，其 docstring 逐字：behavior
  with the capability off is therefore identical to today s —— 关掉不丢功能,
  只丢终端卡片。声明而不实现比不声明糟。
- 不声明 elicitation.form。声明后提问改走 elicitation/create（原生多问、多选），
  而我们的提问卡目前只画单问单选。

## 未定案，留给下一刀

- acp-server/src/session.ts（47 KB）未读：子代理的工具事件本身是否出网，以及
  斜杠命令面板由谁拼（acp-v2.ts 不传 slashCommands，但 acp-server 自带
  builtin-commands.ts 与 slash.ts，分别是 legacy 的 5.6 倍与 1.6 倍）。
- 入参回显不是 legacy 的毛病：两套 events-map.ts 的 toolCallStartToSessionUpdate
  逐字相同，都把 stringifyArgs(event.args) 当 content 发。acp-projection.ts 的
  withoutArgumentEcho 因此是长期资产，不是兼容层。

## 后果

首次连接要求本机的 kimi 带 acp-v2 子命令。这是安装版本的下限，不是代码问题。
