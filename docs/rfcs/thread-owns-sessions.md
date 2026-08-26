# 对话拥有会话：本地日志、多 agent 常驻与对话内切换（提案）

- 状态：提案，未实施。
- 已知过时点（2026-08-11 核对）：文中 agent-client-protocol 锁定 `=1.3.0` 已过时，
  工作区现为 `"2"`；文中排的迁移号 0014–0016 已被 turn_spans、archiving、
  workbench_session 占用，实施时顺延取号。
- 本文由两份工作稿合并；附录保留产品语义与先例对照两节。

---

同一对话内切换 agent：本地对话日志与会话分段
<aside>
🎯
结论：能做到,不需要新协议能力。缺的是一份本地对话日志——`0009_drop_run_log.sql` 把它删了,而删它的理由只在单 agent 下成立。这份文档说明为什么要把它请回来、以什么形状请回来,以及分几步走。
</aside>
1. 问题
会话与 agent 绑定,同一条对话不能换 agent。
现象在 `addressing.rs::session_for()` 的这一句：
```rust
let mine = owner.as_deref().is_none_or(|id| id == live.agent_id);
```
`!mine` 时直接返回 `AgentHistory::Unavailable { reason: OtherAgent }`,并给这条对话开一条空会话。界面上就是那句提示：「这段对话由另一个 agent 保管,当前这个打不开它。」
这一行不是缺陷,是当前模型下的正确行为。ACP 的会话号由 agent 发放,B 进程不认识 A 发的号,协议层面没有任何手段让它认识。问题不在这一行,在它背后的假设。
2. 那个假设,以及它三条迁移之后就被自己推翻了
```sql
-- 0009_drop_run_log.sql
-- 历史从此只有一份,在 agent 那边,由 session/load 交还。
```
单 agent 下这句是真的,删掉本地日志也是对的：两份历史一旦分叉,屏幕上显示的是对面那份的赝品。
两个 agent 之后它变假——不是变弱,是变假：
B 打不开 A 的会话号。不是效果差,是 `session_for` 拒绝发送。
`can_load_session: false` 的 agent 一份都交不出来。
「只有一份」的实情是「零份,或者每个 agent 各自一份残缺的」。
「避免第二份真相」这个论证,在多 agent 下反过来指向本地日志。 把唯一那份历史托付给 N 个不受控的外部进程,才是漂移风险本身。
而这个反驳是自己写下的：
```sql
-- 0012_thread_owners.sql
-- 命令层今天靠「空主人一律算成自己的」把两者合并处理(session_for 里的 is_none_or),
-- 装得下的 agent 只有一个时它总是对的;一旦两个 agent 同时常驻,它就是把 A 开的号发给 B。
```
0009 假设永远只有一个 agent,0012 已经在为两个做准备。本次改动处理的就是这个不一致。
3. 设计哲学
3.1 对话不是会话
`acp-client.md` 里已有现成表述：
> The transcript is untouched by that, because a conversation is not a session.
> 
类型层也已经成立：`ThreadId` 与 `AcpSessionId` 是两个类型,不是同一个字符串的两个别名。
要做的只是让运行时兑现它：一条对话可以先后、甚至同时握着多个会话。 一对一是历史包袱,不是不变量。
3.2 本地日志是事实来源,agent 的会话是缓存
所有权关系反转。agent 手里那份从「唯一真相」降级为「一个恰好还热着的副本」。
判据很实际:副本可以丢失(进程退出、`can_load_session: false`、换了 agent),真相不可以。凡是会丢的东西就不是真相。
推论：`session/load` 不再用于显示,只用于水合。它的作用是把 agent 的脑子暖起来,不是把屏幕填起来。
3.3 一份权威,N 份可丢弃的投影
`0001` 已经把这条纪律写对了,而且写得比后来更准：
> run_events is append only and is the source of truth... runs, tool_calls and permissions are projections of it: they can be rebuilt from the log, and a bug in one of them is never a data loss bug.
> 
> 
> 
> threads is not one of those... A manual title and a pin are decisions the user made about a conversation, not things that happened inside one.
> 
保留这个二分：日志记录「发生了什么」,`threads` 记录「用户对这条对话做了什么决定」。 两者都权威,互不重建。新增的分段表属于第一类。
3.4 可移植性是帧的属性,不是全局开关
重放给另一个 agent 时,不是「发不发历史」的布尔选择,是逐帧判定能不能带走。
thought 帧是别人的推理过程,provider 原生的 `tool_use_id` 在别的实现里无意义,已授予的权限是安全边界。这些都要留在日志里(界面显示它们、审计需要它们),但不能出现在交给下一个 agent 的引导包里。
所以 `portability` 是列或按 `kind` 判定的函数,不是一个开关。
3.5 水合按成本递降,不是选一种策略
「切 agent 要不要重放历史」是个错问题。正确的问法是：这个 agent 对这条对话已经知道多少? 答案从「全部知道」到「一无所知」连续分布,对应四种成本差一个数量级的做法(见 §5)。
实现上这意味着要记 `known_up_to`——每个 agent 在这条对话上见过到哪一帧。有了它,「B 缺席期间发生了什么」是一次 `WHERE seq > ?`,不是每次全文重放。
3.6 不留双轨
引 AGENTS.md：
> 替换旧实现时,在同一次改动里删掉旧路径。不留无期限双轨,不用兼容层掩盖职责不清。
> 
这条对本次改动有硬约束：日志一旦成为权威,`session/load` 的显示路径必须在同一次改动里断掉。两条路径并存的那个中间状态,恰好就是 0009 当初要消灭的东西。
4. 数据模型
4.1 事件日志
```sql
CREATE TABLE session_events (
    session_id TEXT    NOT NULL REFERENCES thread_sessions (session_id) ON DELETE CASCADE,
    seq        INTEGER NOT NULL,
    at         INTEGER NOT NULL,
    kind       TEXT    NOT NULL,
    payload    TEXT    NOT NULL,
    PRIMARY KEY (session_id, seq)
) STRICT;
```
三处与 `0001` 的 `run_events` 不同,都是往好的方向：
主键从 `(run_id, seq)` 换成 `(session_id, seq)`。 不是设计选择,是既成事实——`recorder.rs` 早就改过来了：「一条会话上的序号线。位置按会话单调,不按轮次。」
`runs` 表不回来。 轮次由 `PromptAdmitted` / `RunFinished` 两帧自己界定。再建一张表就又有了两个真相。
主键仍然是 ACP 流的去重保证。 沿用 0001 那句：重复到达的 session update 由数据库拒绝,不由调用方拒绝。
`RecordedEvent` 逐字段就是这一行,`serde` 已经会序列化它。
4.2 分段
```sql
CREATE TABLE thread_sessions (
    thread_id   TEXT    NOT NULL REFERENCES threads (id) ON DELETE CASCADE,
    agent_id    TEXT    NOT NULL,
    session_id  TEXT    NOT NULL UNIQUE,
    known_up_to INTEGER NOT NULL DEFAULT 0,
    state       TEXT    NOT NULL CHECK (state IN ('active', 'suspended', 'closed')),
    opened_at   TEXT    NOT NULL,
    PRIMARY KEY (thread_id, agent_id)
) STRICT;
```
`session_id UNIQUE` 继承 `0002` 那条 `threads_session_id` 唯一索引的语义：一个会话号只属于一条对话。这条不变量不变,只是换了住处。
`known_up_to` 是 §3.5 的落地。
`state = 'suspended'` 是 L0 的前提：切走时不 `close`,切回来就是零成本。
`threads.session_id` / `agent_id` 保留,降级为「当前活跃分段」的指针。理由见 §7.3。
4.3 TS 侧
`ThreadHistory` 判别联合加一档,不改现有四档：
```tsx
type ThreadHistory =
  | { state: 'fresh' }
  | { state: 'live' }
  | { state: 'loaded' }
  | { state: 'stitched'; segments: readonly Segment[] }
  | { state: 'unavailable'; reason: ThreadHistoryLoss; owner: string | null }
```
`ThreadHistoryLoss` 的 `otherAgent` 不删。它从「常见状态」变成「真实失败」——本地日志也读不出来时才用,比如日志被清理过。
5. 水合的四级
级	前提	做法	成本
L0 Resume	目标 agent 的分段还 `suspended` 在册子里	直接用原会话号	零
L1 增量	有分段,`known_up_to < max(seq)`	只发缺席那一段	与缺口成正比
L2 重放	首次进入这条对话	从日志投影出可移植帧	与对话长度成正比
L3 简报	L2 超上下文预算	让当前 agent 先写交接,再发给下一个	常数,有损
挂载点已经存在。`addressing.rs` 里那个 `Wanted` 二分——`Address` 要地址、`History` 还要经过——就是水合的天然位置,加第三档：
```rust
enum Wanted {
    Address,
    History,
    Handoff { from: AgentId },
}
```
引导包三段隔离,当前请求必须单独隔出来,否则下一个 agent 会把历史里最后一条指令当成此刻要它做的事：
```xml
<handoff from="…" at="…">…</handoff>
<transcript>…</transcript>
<current_request>…</current_request>
```
5.1 更远一步：让 agent 自己去查
ACP 的 `session/new` 收 `mcpServers`,规范明确授权：
> Clients MAY use this ability to provide tools directly to the underlying language model by including their own MCP server.
> 
所以 L2 还有个上位替代：把日志做成一个内置 MCP server,每次 `session/new` 注入。
```
read_transcript(thread_id, from_seq, to_seq)
search_history(thread_id, query)
```
下一个 agent 不用吞下全部历史,按需去查。这对「AI 上下文必须是有意选择、尽可能最小、可检查的」不是让步而是正解:全量重放才是违反它的那个做法,而按需查询留下的每一次读取都记在 tool call 里,可审阅。
不列入首期。列出来是因为它会影响 L2 的实现深度——如果确定要走这条,L2 只需做到「够用」,不必做到「精美」。
6. 重放的裁剪规则
投影成引导包时,必须丢弃：
丢什么	为什么
thought / reasoning 帧	别人的推理过程,不是事实。而且它在一轮里占压倒多数,是上下文预算的头号消耗
provider 原生 `tool_call_id`	在另一个实现里无意义。`acp-client.md` 已记录过同类问题：agent 会在后一轮复用同一个 id
未完成的 tool call	它的结果永远不会到,留着就是一个假的悬挂状态
pending 的权限请求	请求的对象已经不在了
已授予的权限	安全边界。A 拿到的授权不得顺着 transcript 流给 B
最后一条是本节唯一一条不能商量的。其余四条是质量问题,它是安全问题。
7. 落地计划
三期,每期独立可验证、独立可发布。不允许停在期内。
第一期：本地日志(不碰多 agent)
目标：关掉应用重开,历史还在,且不再调用 `session/load` 显示。
迁移 `0014`：建 `session_events`。暂不建 `thread_sessions`,`session_id` 直接引用 `threads`。
迁移 `0015`：恢复 `run_snapshots` 的等价物(按 session 键)。折叠规则从 git 取回,`version` 列语义不变。
`AgentStore` 上加写路径。走 `store.rs` 现有的 `write()` / `prepare_cached`,不新开第二条。
在 `Frames` 的 sink 上挂持久化。 这是本期最省的一点：`FrameSink = Box<dyn FnMut(RecordedEvent) + Send>` 已经是注入的,`RecordedEvent` 逐字段就是那一行。加落库是加一个闭包,不动 `Frames`、不动 `Recorder`、不动 `driver`。
读回来投影成 `RecordedEvent[]`,喂给现有的 `replayThreadEvents`。界面一行不改。
断掉 `session/load` 的显示路径(见 §8)。
验证：`bun run check`,加一条「杀进程重开,转录完整」的测试。
第二期：多 agent 常驻(不碰历史)
目标：不同对话用不同 agent,两个 agent 进程同时活着。这本身就是能发布的能力。
`AgentRuntime` 的 `ensure_session` / `borrow` 从单个 `live: Handle` 换成 `HashMap<AgentId, Handle>` + 一个 `active` 指针。
`SessionBook` 一个字都不改。它本来就是 per-connection 的,只是上面多套一层 map。注释里那句「One agent process can hold several sessions at once」已经是对的。
修掉 0012 预言的那个 bug：`session_for` 里 `is_none_or` 的空主人兜底,在两个 agent 常驻时会把 A 的号发给 B。
验证：两个 agent 同时有活会话,帧不串台。
第三期：同一对话内切换
迁移 `0016`：建 `thread_sessions`,`session_events` 的外键改指向它。
`session_for` 改写：`!mine` 不再返回 `Unavailable`,而是按目标 `agent_id` 查分段——有则 L0/L1,无则 `session/new` + L2/L3。
seq 命名空间再套一层。界面按 seq 去重,两个分段之后会撞号。这个手法已经用过一次:`acp-client.md` 记录了 run 级的同类处理(「entry identities are namespaced by it」),现在从 run 级升到 session 级。`#routes` 里已经有 sessionId,改的是 `applyRunEvents` 的 key 构造。
界面：`SessionConfigControl.purpose` 加一档。切换器和模型选择器长在同一个位置,语义上确实是同一类东西。
8. 同期必须删掉的旧路径
按 §3.6,以下三处不能留到以后。
8.1 `session/load` 降级为纯水合
`Frames::record_session_update` 那句「重播回来的一帧,不落库」的行为保留、理由改写。现在的理由是「本地没有日志可写」;之后的理由是「这些帧是本地日志的回声,落库就是重复」。
同时 `agent_open_thread` 不再从 `session/load` 取历史。这是显示路径的断点。
8.2 `0010` / `0011` 的附件对齐可以删
附件现在靠「从末尾数第几条用户消息」认领,还要在 `M < N` 时整批放弃。这套精巧的东西存在的唯一原因,是本地不知道对话长什么样。
有了日志,附件直接挂 `(session_id, seq)`。`threads.prompts` 那一列可以退休。这一刀是净减法。
8.3 迁移力学的坑,0012 已经踩过
> 给已有表加 CHECK 只能走官方那套 12 步重建表流程,而重建要求 PRAGMA foreign_keys=OFF,pragma 在事务里是空操作;`migrations.rs` 把每条迁移都包在一个事务里,`connection.rs` 又把外键打开了,而 0010 的 thread_attachments 还引用着这张表,DROP TABLE threads 会当场被外键拒。
> 
所以 `threads` 表重建不了。这直接决定了 §4.2 的选择：保留 `threads.session_id` / `agent_id` 当活跃分段指针,而不是把它们删掉。
真要删的话顺序是：`DROP TRIGGER` 两个 → `DROP INDEX threads_session_id` → `ALTER TABLE DROP COLUMN`。SQLite 拒绝删有索引的列,顺序反了就失败。不推荐,收益不抵风险。
0012 那两个触发器改写为：`active_agent_id` 非空时,必须在 `thread_sessions` 里有对应行。约束从「有号必有主」升级为「活跃指针必须指向一个真实分段」。
9. 不做什么
不做跨 agent 的会话号翻译。 协议里没有这个东西,任何试图让 B 认识 A 的号的做法都是幻想。
不做自动 agent 路由。 切换是用户的显式动作。
不做 fork / 并行对比。 数据模型支持(多分段本来就是一对多),但不在这三期内。
不重建 `runs` 和 `tool_calls`。 见 §4.1。
10. 风险与未决
项	说明	状态
`agent-client-protocol` 锁 `=1.3.0`	`session/resume`、`sessionCapabilities` 等是否可用需核实。L0 若依赖 resume 而 1.3.0 没有,则 L0 退化为「同进程内 suspended 分段」,跨重启走 L1	待核实
Kimi 不发 `availableModes`	全树搜不到,`set_mode` 从未被调用。模型切换靠改 `~/.kimi-code/config.toml` 再重建 session。这意味着换模型和换 agent 走同一条水合路径——第一期做完就顺带修好了换模型丢历史的问题	已确认,是利好
日志体量	thought 帧占压倒多数,payload 是 JSON 文本。`0006` 当初存在就是因为原始帧直读长对话慢。所以第一期第 2 步不可省	已计入计划
`runtime.rs` 未通读	`ensure_session` / `borrow` 的确切语义、`Handle` 的生命周期,第二期开工前需读完	待办
新包分层	若第三期要新增包,先在 `tools/architecture/rules.config.mjs` 定层,否则 `bun run test:architecture` 直接失败。目录名黑名单同样适用	记住
11. 验收
每期各自跑通 `bun run check`。涉及 Rust 类型变化的期(一、三)必须 `bun run ipc:generate` 后 `bun run ipc:check` 无漂移。
行为级验收：
[ ]  一期：杀进程重开,转录完整;`session/load` 不再参与显示
[ ]  二期：两个 agent 同时常驻,帧不串台;空主人兜底 bug 消失
[ ]  三期：同一条对话内 A → B → A,三段都在;切回 A 是 L0 零成本
[ ]  三期：`can_load_session: false` 的 agent 也能看到完整历史

三点说明：
第一期完全不碰多 agent。 只做本地日志 + 断掉 session/load 的显示路径。它独立可发布，而且顺带修掉了「换模型丢历史」——因为 Kimi 换模型也是重建 session，走的是同一条水合路径。
有一处结构选择我替你定了：threads 表不重建，session_id / agent_id 保留为活跃分段指针。理由是 0012 记录的那个外键 + 事务内 pragma 空操作的坑，收益不抵风险。
两处待核实已列在 §10：runtime.rs 我没通读（第二期开工前要读完），以及 =1.3.0 是否有 session/resume——若没有，L0 退化为同进程内的 suspended 分段，跨重启走 L1，不影响整体设计。

---

# 附录（并自另一份工作稿）

## 七、产品层：三种"切换"是不同的东西，别做混了

1. **Switch（永久切换）** — 此后由新 agent 负责。走上面的水合流程。
2. **@mention（一次性委派）** — 只让另一个 agent 答这一轮，然后回到主 agent。**主 agent 需要把这一轮结果作为"外部观察"吸收**（以 user-side observation 形式注入，而非伪装成它自己说的）。
3. **Fork（分叉对比）** — 从某点复制子树，不同 agent 各跑一支并排比较。LibreChat 的消息树就是干这个的。

还有个白送的差异化功能：**Race / Ensemble** — 同一 prompt 同时发给多个 agent，用户"采纳"其一进主线。你已经接了多 agent，这是几乎零边际成本的杀手锏，Open WebUI 的多模型并行回答已经验证了这个交互。

**人格取舍**：让新 agent 内部把历史当作自己的（否则它会反复说"我不清楚之前发生了什么"，体验极差），但 UI 上用 provenance 明确标注每条消息的出处。**内部无缝，外部透明。**

---

## 八、开源先例

没有哪个开源项目直接给了你"ACP 跨 agent 会话迁移"的成品——这确实是个空白。但**这个问题的每一块都有成熟实现可抄**：

| 项目 / 规范 | 类型 | 它解决的等价问题 | 可直接抄的机制 |
| --- | --- | --- | --- |
| Zed (crates/acp_thread) | ACP 客户端 | ACP 的会话状态如何独立于 agent 进程存在于客户端侧 | 客户端持有 thread entries 作为事实来源，agent 只是 session/update 事件流的产生者；agent 崩溃或重启后 UI 与历史不丢 |
| LibreChat | 对话产品 | 同一条对话里自由切换 endpoint / provider / model，并支持从任意点分叉 | 消息树（parentMessageId）而非线性数组；每条消息自带 model / endpoint 的 provenance 字段；fork 复制子树 |
| Open WebUI | 对话产品 | 一个 chat 内并行让多个模型回答同一轮，再采纳其中一个 | 同一 turn 挂多个候选 response（每个带 model 标识），用户选中的那个才进入主线历史 |
| LangGraph / langgraph-swarm | 编排框架 | 多个 agent 共享同一份消息历史，「当前谁在说话」只是 state 里的一个字段 | active_agent 存于 state；handoff 用 Command(goto=...)；历史天然共享，切换不需要迁移任何东西 |
| OpenAI Agents SDK (handoffs) | 编排框架 | 交接时把完整对话历史移交给新 agent，并允许裁剪 | handoff 建模为一次工具调用；input_filter 决定哪些历史条目传递给接手方（对应你的「可移植性标记」） |
| AG-UI (CopilotKit) | 协议/规范 | 前端协议层面明确区分「一条对话」和「一次 agent 执行」 | threadId（长生命周期对话）与 runId（单次执行）分层；thread 状态由客户端拥有，run 可换后端 |
| A2A Protocol | 协议/规范 | 跨多个 agent 的若干 task 归属同一个上下文容器 | contextId 作为高于 task 的一层，多个 agent 的 task 可共享同一 contextId —— 正是 ACP 缺的那一层 |
| Roo Code / Cline | 编码 Agent | 同一个 task 进行中切换模式与模型（Plan/Act、自定义 mode） | 切换只在 turn 边界发生；mode 变更作为一条事件写入历史；不同 mode 可绑不同 model 但共享 task 历史 |
| Pydantic AI 的 ACP harness | ACP 客户端 | session/load 到底该存什么、怎么重放 | 双存储：模型侧 message history 与客户端可见 transcript 分开持久化，恢复时前者灌回模型、后者重放给 UI |

其中 **Zed 的 `crates/acp_thread`** 是你最该先读的——它就是一个成熟的多 agent ACP 客户端，且已经把"客户端拥有 thread"这件事做对了；你要加的是它没做的"跨 agent 水合"那一层。**LangGraph swarm** 则是"会话与执行者解耦"最干净的教科书。

---
