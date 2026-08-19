# 0021. 换轨：dsh SDK 线协议是接 DeepSeek 的唯一传输

> 传输前提已被 [ADR 0026](0026-kap-is-the-only-agent-transport.md) 取代；本文仅作为历史记录保留。

> Status: superseded by ADR 0022.

## 裁决

未来形态是纯 DeepSeek agent。接入传输选 deepseek-harness 的 SDK 线协议
（newline-delimited JSON-RPC 2.0，包 packages/sdk/protocol），不选它的 ACP。

依据（均为 deepseek-ai/deepseek-harness 官方仓库内的一手记载）：

- ACP 被官方定为 automation-only：只交付已提交的 assistant 文本，无流式、
  无工具活动、无计划、无 session load/list。
  （.agents/notes/implemented/simplification/2026-07-23-acp-automation-only-protocol.md）
- UI 集成的官方指引是消费 session/event 事件流。（docs/architecture.md）
- SDK 线协议面：方法 initialize / session/prompt / shutdown；通知
  session.event（全量会话日志信封）、session.status（running/idle）、
  subagent.started/finished。session/prompt 的 messageId 只是入队回执，
  轮次终点以 session.status=idle 判定。（packages/sdk/protocol/README.md）
- 已声明的限制：无 cancel / 无会话关闭（放弃一轮 = 关掉运行时进程）；
  server→client 请求是 dead capability（审批流属未来）；协议 0.0.1，
  无版本协商与兼容承诺。（同上 README，Known Limitations）
- 运行时入口：published bin dsh-jsonrpc-agent，配置经 DSH_CORDIS_CONFIG
  或 argv[2]；stdout 协议纯净；stdin EOF 立即 dispose。
  （packages/examples/jsonrpc-demo/README.md）
- Windows：官方单文件运行时明言 non-goal；node 载体要求 Node >= 22.19。
  （.agents/notes/…/2026-07-10-single-file-executable-sdk-runtime-distribution.md）

## 后果

1. 帧管线（frame.rs → Recorder → FrameSink → 投影）原样保留；换的只是
   协议轨道：frame.rs 的 acp_update 变体换成 session_event（持 dsh 会话
   信封，载荷照现行模式持 Value），permission_requested / permission_resolved
   随 ACP 退场，取消语义改为终止运行时进程并自动重启。
2. 线上无 load：本地帧日志落盘（Recorder → persistence），成为屏幕重放的
   唯一来源；宪法「本地不存对话正文」相应修订。对话正文的真相仍在 agent
   侧（dsh 的 JSONL 会话日志）。
3. Rust 无官方 dsh SDK。手写收窄为七个信封的最小定型 + 金样本传输测试，
   记为已知偏差；TS 侧一旦官方 protocol 包可用即 re-export，禁止扩抄。
4. 档案层：deepseek 档案行（command dsh-jsonrpc-agent，DSH_CORDIS_CONFIG
   指向本应用托管的 cordis 配置；DEEPSEEK_API_KEY 永不落本应用的盘）。
   kimi 档案、kimi/ 方言模块、catalog-codec 的 kimi 行与 ACP 依赖同一刀
   删净，不留双轨。
5. 待验证后方可动工的事实：jsonrpc-demo 的 npm 包名与安装口径；
   Poietica 托管 cordis.yml 的插件组合逐字名；session/prompt 能否寻址
   既有会话。

## 批次

批次二：agent-runtime 线协议客户端（sans-IO 定型 + 金样本测试）与 driver
换轨、帧契约同刀收窄；批次三：Recorder 落盘重放、审批策略入配置、
catalog 换行删 kimi、acp- 前缀改名、宪法与 README 口径收敛。
