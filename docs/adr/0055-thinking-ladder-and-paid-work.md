# 0055 — 思考档位只有这条模型自己的梯子，且不该花的钱一分不花

## 状态

已接受。补 0053 的执行细节：那一号决定了「选择器与模型元数据全部从 agent 读」，
这一号决定「读回来的候选里留哪几档」以及「agent 自己会花掉的钱由谁拦」。
第四节的结论是**不为模型目录另造一份**，一并记在这里备查。

## 背景

两个症状，一个根因：**上游愿意自己做的事，我们照单全收。**

1. 输入框那一排的思考档位，候选固定是 `off` + `auto` + 模型档位。看起来像一张写死的
   通用表，其实后三项已经是这条模型的梯子（`getAvailableThinkingLevels()`，产地是
   pi-catalog 烘进每行的 `thinking.efforts`）—— 用户看到「每条模型都是这五档」，是因为
   他在 models.yml 里给自己那几条模型抄了同一张梯子。真正写死的只有 `off` 与 `auto`
   两个前缀。
2. **用户的余额会莫名其妙变少。** 上游有一条自发的会话标题请求：首条消息
   （`maybeStartTitleGeneration`）与 todo 首次初始化之后的重规划
   （`agent-session.ts` 的 `#scheduleReplanTitleRefresh`）各一次。它选模型是
   「tiny → commit → smol 角色，一个都没配就退回**当前会话模型**」
   （`utils/title-generator.ts` 的 `getTitleModels`），而产品不配那三个角色 —— 于是
   这一次调用落到用户自己那条模型、自己那个密钥上，输入是最近六轮真实对话。
3. `auto` 那一档是**每轮**多一次分类调用（`model-controls.ts` 的
   `applyAutoThinkingLevel` → judge 角色链；角色链的 `@default` 也落在用户当前模型上）。
   一次不多，但它是每轮都有的、用户没点的那一次。

## 决定一 · 候选只有模型自己的梯子

`readSelectors` 报的候选取 `getAvailableThinkingLevels()`，**不前置 `off`/`auto`**。

梯子的正本是模型元数据。它有两层产地，都是**数据**，都不是运行时猜的：

- **随包烘好的目录**（`@oh-my-pi/pi-catalog` 的 `src/models.json`，11.5 MB，5510 行，
  其中约 3200 行带梯子）。它由构建期的 `bun run gen:models` 生成，源是
  `src/compat/rules/*.kdl` 那些**人评审过的规则**加各家目录抓取；`gen:compat` 再把
  KDL 编成 `rules.json`（318 KB，随包发），运行时由 `compat/resolve.ts` 把轴物化到每一行。
  实测 5510 行里有 **18 种不同的梯子** —— `["high"]`、`["low","high","max"]`、
  `["minimal","low","medium","high","xhigh"]` 都真实存在。
- **用户自己的 `models.yml`**，`providers.<id>.models[].thinking.efforts`。实测它**赢过**
  内置那一行（把 `deepseek-flash` 的梯子改成 `["xhigh"]`，注册表读回来就是 `xhigh`）。

所以产品这边**不需要自己的档位表**：上游那张就是。谁在代码里写死一张档位表，谁就在报这条
模型没有的档位 —— 人选中了它，请求发出去被厂商拒、或被上游悄悄夹回另一档，而屏幕上写着
人刚选的那个（违反 §1 的单一所有者）。

`off` 去掉是产品判断：这个产品的用户要的就是深度思考。`auto` 去掉是成本判断：
它按上面第 3 条每轮花钱，而这个花的钱用户点不出来。

## 决定二 · 收敛只落在梯子上，落点是上游自己的默认

盘上读回来的会话可能停在产品不提供的档位上（旧版本留下的 `off`/`auto`，或换过模型之后
停在另一条模型的档位上）。报一个自己都不提供的 `current`，胶囊与轨道说的就不是一件事。

`settleThinking`（`packages/agent-bridge/src/thinking.ts`）在**开一条会话时做一次**收敛，
落点依次是：模型声明的 `defaultLevel` → 全局 `defaultThinkingLevel`（上游 schema 默认，
实测 `high`）→ 这条模型能给的最深一档。**不另立一张表，也不猜哪一档「更好」**；夹取归
上游 `setThinkingLevel` 自己。

放在 `adopt()` 里、订阅之前：这一步自己会发 `thinking_level_changed`，订阅之后再动就是
多报一遍选择器；而下面那一次报的就是收敛后的值。读（`readSelectors`）里不写 —— 读里写
会让「报一次」变成「沿着事件回来再报一次」。

## 决定三 · 关掉 agent 自发的标题生成

桥在启动时置 `PI_NO_TITLE=1`（上游 `agent-session.ts` 两处 fail closed；官方自己的
rpc/acp 模式也置它，见它 `src/main.ts`）。

产品**用不上**这个能力：会话标题在我们这边是本地账本的 `threads` 表（ADR 0049），而
omp 生成的那个标题唯一的上屏出口是 `agent-client` 的会话清单读
（`ClientCommand::Sessions` → `lifecycle::entries_of` 的 `title`），那条路在**本仓没有
任何调用方**（`crates/` 与 `apps/desktop/src-tauri/` 全仓 grep 为空）。所以它花的钱换不
来任何屏幕上的东西。

置法是运行时赋值 `process.env.PI_NO_TITLE`，不是档案的 `env` 格：档案的 `env` 是**用户
那几格**（`agent-profile.ts` 的 `blankProfile` 只投影 command/args/unsetEnv/homeVar/
ownHomeDirectory），写进描述符会被用户那份配置盖掉、也不落盘。上游读的是 pi-utils 的
`$env`，而它**就是 `Bun.env`**，与 `process.env` 是同一个活对象，所以这句赋值在任何一次
读之前落地都算数。

## 后果

1. 屏幕上的档位条数随模型变 —— 这是对的，不是数据缺失。
2. 不配 `tiny`/`smol`/`commit` 角色的产品，从此不再有 agent 自发的模型调用；产品里
   **唯一**发起轮次的地方仍是 `prompt`/`steer`（用户点的那一下）。
3. `capabilities` 里的 `always_thinking`（上游 `thinking.requiresEffort`：那种端点拒掉
   「不思考」的请求）暂时没有单独的 UI 表达 —— 产品已经不给 `off`，那些模型因此不再需要
   这一个例外。留着它是因为模型配置页那一栏还在读它。
4. 用户若要 `auto` 的按轮分类能力，得先在产品里给它一个**不额外花钱**的住处（例如先配一
   条便宜模型当 `tiny`/`judge` 角色），否则这个开关就是「每轮多一次调用」的隐形成本。

## 决定四 · 模型目录用上游自带的那份，不自己烘

上游把 models.dev 全部 225 个 provider 烘进**随包发**的 `@oh-my-pi/pi-catalog` 的
`models.json`（11.0 MB / 5510 行）。本产品只接 DeepSeek / GLM / Kimi，那 10 MB 用不上 ——
但这个诱惑**已经试过并被否掉**，理由记在这里，免得再试一次。

**试过什么。** 一个 `tools/agent` 下的脚本，复用上游随包发的三个公开导出
（`fetchWellKnownModels → mapModelsDevToModels → buildModel`）走同一条生成路，只留三家、
只留最近半年，产出一份 21 行 / 76 KB 的精简目录，再由 `build-bridge.ts` 的一个 Bun 插件
在打包时**替掉**上游那一份（不动 node_modules）。它**是能跑通的**：打包产物 11 300 KB →
393 KB，二进制 187.7 MB → 154.8 MB，执行打包产物问得到 5 家 / 21 行、梯子与上游逐行相同。

**为什么仍然撤掉。** 这是自造上游能力的复制品，违反本仓自己的规矩（AGENTS.md §7
「加东西走上游的路，别发明新路」；§8「一次换干净、禁双活」）。具体代价：

1. **它是第二份事实。** 上游有一张随时在更新的目录，我们另存一份子集，两边的选取口径
   （哪三家、半年怎么算）从此要靠人维护。「半年」还是个**会自己漂的**判据：过几个月重跑
   会静默掉几条模型，不重跑则静止在某一刻 —— 两种都不是「跟上上游」。
2. **它复制了上游的选取口径。** 三家是谁、日期怎么读、没映射的 provider 怎么办，这些全是
   我们替上游做的决定；上游改了 `MODELS_DEV_PROVIDER_DESCRIPTORS` 或换了字段名，我们这份
   会静默走偏，而构建照样报成功。
3. **它求的是一个不存在的问题。** 用户能看到的模型本来就受凭据门限制：实测
   `getAll('all')` 是 5555 行，而 `getAvailable()` 只有 4 行 / 1 个 provider。那 10 MB 是
   磁盘与启动开销（实测 `JSON.parse` 21 ms、堆 9.9 MB 一次性），**不是**屏幕上多出来的东西。

**留下的是能力，不是复制品。** 真要收窄可见范围，用上游自己的两个旋钮：`enabledModels`
（支持 glob）与 `disabledProviders`（`settingsFor()` 已经在用它停掉 11 个外来 provider）。
零新代码，零第二份事实。

## 待验证

- 本条的实证到「候选表、收敛、梯子产地」这一层，都用真桥/真注册表核对过（见上。
  `thinking` 控制项报 `low/high/max`、无 `off`/`auto`、`current` 是 `high`；
  `defaultThinkingLevel` 被钉成 `auto` 的受控 home 收敛到了 `high`；把 `models.yml`
  的梯子改成 `["xhigh"]` 后注册表读回来的就是 `xhigh`）。**没有**在真凭据下跑一整轮，
  因此「关掉标题生成之后余额不再少」这一条是静态读源码得出的（调用点、选模型口径、
  开关名都逐条指到文件），未经账单核对。
- `XHigh` 这一档在 omp 的标签表里被缺省略过（`THINKING_OPTIONS` 从上游
  `defaultThinkingLevel.ui.options` 取，那张表里没有 xhigh 的说明），标签退回档位名本身
  —— 与从前一致，不是这次引入的。
