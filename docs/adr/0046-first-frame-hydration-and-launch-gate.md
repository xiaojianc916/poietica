# 0046. 首帧水合与启动门禁

- 状态：已接受
- 日期：2026-09-19

## 背景

开窗后工具条上三格（批准方式、模型与思考档位、Swarm）先是空白，要等 agent 进程起来、
握手、建锚会话之后才画出来。空白的原因不是读得慢：这张表本来就由 agent 拥有，而
`AgentCapabilityStore` 在 `start()` 时先提交一张空表。

慢的是读之前排队的东西。`prepareAgent` 把两件与「起 agent」无关的事挡在 launch 前面：

1. `pluginStore.start()` —— 插件账本、技能目录、外部账本、mcp.json、市场目录、
   能力清单六趟 I/O，外加 `reconcileBrowserMcpServer`。其中能力清单那趟经
   `agent_capability_report` 反过来还要 `ensure` 一次连接。
2. 模型目录的元数据同步（一趟目录快照加一次写）。

而真正的选择器读取（`get_selectors`）是一条独立的 REST 调用，不依赖上面任何一件。

## 决策

### 1. launch 只等 agent 启动时真会读的东西

`prepareAgent` 只等 `mcpReady()`。模型目录改成按需读，不挡在 launch 前面。

`readCapabilities` 从 plugin-store 首扫那一批里移出，排在首屏落定之后。它只喂插件页
那一格，没有读者在等它。

> 后续（ADR 0053）：当初那一趟「元数据同步」是我们拿一份 models.dev 快照去补
> `displayName` / 上下文 / 能力位，再经 `patchConfig` 写回。那是**第二个元数据产地**，
> 0053 已经把它整条删掉 —— 模型的档位与上限只认 agent 自己的注册表。所以今天
> `prepareAgent` 后面没有第二件事，「不阻塞」这一条落成了「根本没有这一趟」。

### 2. 上一趟 agent 确认过的那张表留到下一次开窗

新增 `SessionConfigMemoryPort`（`packages/conversation/src/agent/config.ts`）：读一份
上一趟确认过的表，写一份刚确认的表。桌面侧实现是 localStorage 偏好
`poietica.session-controls`，形状是 agent 的原话（id / label / purpose / current /
choices），解码器认不出就整份丢弃 —— 一张缺了 `current` 的表画出来只会更误导。

写入点是 `#adopt`：open / select / agent 主动上报三条路唯一的汇合处，所以「存的是
agent 说过的」由结构保证。

### 3. 未确认的那份只上屏，不参与任何下发

`AgentControls` 增加 `provisional`。只有从盘上读回来的那份置真，agent 的任何一次答复
落地都清成假。

三道闸，都拦同一件事 —— 拿「上一次是什么样」当「现在是什么样」：

- `AgentCapabilityStore.selectControl` 在 provisional 期间直接返回。闸放在这里而不是
  各颗按钮上：下发只有这一个出口，逐处禁用总会漏掉一处（面板里的模式行就不是工具条
  上那三颗控件）。
- `AssistantComposer` 把未确认的表换成一个空表再往下传（`confirmed`），交给工具条与
  输入框。这一条是安全相关的：摊平的 configuration 跟着 prompt 一起发出去，面板里的
  模式行会往草稿里写一格待提交的配置，模式 chip 点一下就是一次 set_config —— 一句
  「这次也别问」不能押在一个可能早就变了的值上。
- 三颗控件拦在各自的开启/点击回调里（`onOpenChange` / `onClick`），配 `aria-disabled`
  与 `aria-busy`。**不用 `disabled` 属性**：`DropdownMenuTrigger` 自带
  `disabled:opacity-50`，原生 `<button>` 也有自己的 `:disabled` 画法 —— 加上它整颗控件
  会变淡，而这里要的是「看起来与平时一样，只是暂时点不动」。

画与发就此分成两条输入：`controls` 只用来画，`confirmed` 只用来组装命令。

### 4. 补发批准方式的那一趟不画中间值

批准方式有一件事与别的格子不同：它跨会话持久（`PermissionPosturePort`），所以每开一条
新会话都要把它补发回去一次。而新会话默认报 `manual`，用户上次选的可能是 `auto` ——
照原样画就会先画「请求批准」、下一趟往返再跳回「完全访问」。

那一闪不是水合造成的，是「agent 报的中间值」造成的。所以补发已经在路上时，屏幕上画
的是要收敛到的那一档（`projectPosture`），不是这一趟报的那一个。

要紧的一处：**补发要不要发，判据必须是 agent 的原话，不是屏幕上投影过的那张表。**
投影过的那一格 `current` 已经等于要发的值，拿它去判「同一个值不重发」，这次补发会被
整个吞掉 —— 屏幕显示完全访问，agent 那头停在请求批准。锚会话因此另外记一份
`binding.reported`；单条对话那一侧的 `#dispatch` 本来就不按 `current` 判，无需另记。

agent 真拒了那次改动时不投影（同一个意图只补一次，判据是 `alignedTo`）：那时它报的
值就是事实，屏幕回到它说的那一句。

## 已知代价

- 未确认期间点不动那三格，但外观、悬停与气泡都不变。这是刻意的：那一刻我们并不知道
  这一档现在还算不算数。
- 补发期间批准方式那一格画的是要收敛到的值，不是 agent 刚报的中间值。两者会不一致
  一个往返的时间；agent 拒了那次改动时立刻回到它报的那一档。
- 盘上那份说的是「上一次开窗时 agent 怎么说」，未必属于用户马上要开的这条对话。所以
  它只喂入口那一格（读的是锚会话的表），不往已有对话里灌 —— 那里的表由 `#reopen`
  在打开时取回。

## 参考

- `packages/conversation/src/configuration/capability-store.ts`（provisional 与三道闸）
- `apps/desktop/src/assistant/controls-memory.ts`（盘上那份的形状）
- `apps/desktop/src/assistant/agent-runtime.ts`（launch 门禁）
- `packages/extension/src/plugin-store.ts`（首扫那几趟）
