# 0053 — 屏幕上的选择器与模型元数据全部来自 agent 自己

## 状态

已接受。补 0052 的执行细节：那一号决定了「用 SDK、不用 RPC」，这一号决定
「SDK 的能力怎么变成屏幕上的三格」。

## 决定

模型、思考强度、批准方式三格，以及模型配置页的供应商/目录两栏，**每一格的值都
从 agent 自己的 API 读，不在这条线上造**。桥（`packages/agent-bridge`）只做形状
转换，Rust 只搬运，谁都不许回一份「看起来对」的默认值。

四格的产地，逐格可查：

| 屏幕上的格 | 产地 | 依据 |
| --- | --- | --- |
| 模型清单 | `session.getAvailableModels()` | 官方选择器读的同一份（含 `enabledModels` 过滤） |
| 思考档位的当前值 | `session.configuredThinkingLevel()` | 保留 `auto`；`thinkingLevel` 是它此刻落到的**有效**值 |
| 思考档位的候选与说法 | `getAvailableThinkingLevels()` + `getUi("defaultThinkingLevel")` | 梯子来自模型元数据，说法来自上游自己那张表 |
| 批准方式 | `settings.get("tools.approvalMode")` | 授权闸门读的就是它（`extensions/wrapper.ts`） |
| 模型配置页的「已配置」 | `authStorage.hasAuth(provider)` | 与官方 model-hub 的 locked/unlocked 同一句判据 |
| 模型配置页的「可添加」 | 其余 provider（内置目录里还没配的） | 官方 TUI 侧栏的另一半 |
| 一条模型的思考元数据 | `model.thinking.efforts / defaultLevel / mode` | pi-catalog 的 `ThinkingConfig`，由 `buildModel` 烘进每一行 |

## 为什么

**屏幕上的值只能有一个产地，而且必须是真身。** 这一页的每一格都在回答「现在
是什么」，答错的代价是人按着一件不存在的事做决定：报一个模型没有的档位，人选中
了它，请求发出去要么被厂商拒、要么被上游悄悄夹回另一档，而屏幕上写着人刚选的那
个。§1 的「每一类状态有且只有一个所有者」在这里就是「agent 的元数据是唯一产地」。

**假数据比缺数据更坏。** 缺一格，界面画不出来，人知道这里没接上；填一个看起来
合理的默认值（`supportEfforts: null`、`catalog: []`、`adaptiveThinking: null`），
界面画得出来、也画得对，只是画的是我们编的。这一条在 0052 的「待验证」里已经埋着
——当时只验到握手，选择器与目录两栏的字段是照旧 DTO 的形状填的，没验过它们有没有
真值。**旧 DTO 的形状不能反过来当作字段有意义的证据。**

**批准方式没有独立通道。** omp 不提供「权限档位」这个控制项，它只有
`tools.approvalMode` 一个设置（`always-ask` / `write` / `yolo`），授权闸门读的就是
它。产品那三颗按钮与它逐档对应（`manual`→`always-ask`、`yolo`→`write`、
`auto`→`yolo`），映射只有一处（桥的 `POSTURES`），写回走 `Settings.set` ——
它自己落盘并热重载，我们不碰 YAML。

## 后果

1. `packages/agent-bridge/src/catalog.ts` 的两栏互斥：有凭据的进 `providers`，
   其余进 `catalog`。同一个 provider 不会两边都出现，界面因此不需要自己筛。
2. `crates/agent-client` 的 `catalog_snapshot` 不再丢字段：`capabilities`、
   `supportEfforts`、`adaptiveThinking`、目录项的 `models`/`envKey` 都原样搬。
   「没有这一格」与「这一格是空表」在 Rust 侧也不许混（`strings` 帮手）。
3. 轮终的结局由 `stopReason` 判（新 `outcome.ts`）：`error`→failed、
   `aborted`→cancelled、静默中止不算失败。一律报 completed 会把厂商报错说成一轮
   成功 —— 屏幕上既没有正文也没有错误。
4. `model_changed` / `thinking_level_changed` 两个上游事件触发选择器重报，
   不再靠人切页才刷新。
5. 界面一个控件都不删（与 0052 第 5 条同一条纪律）。
6. **用户自建的 provider 由我们写 models.yml**（新 `models-file.ts`）。omp 的 SDK
   只给了读者（`ModelsConfigFile` 没有 save），官方 TUI 是在交互界面里自己写这个
   文件；我们嵌的是 SDK，没有那个界面，所以这一格由我们补上。三条硬约束：
   - 整份读、整份写：文件里还有用户手写的 `headers` / `compat` / `discovery` /
     `modelOverrides`，只动 `providers.<id>` 那一格。
   - 序列化必须传缩进（`Bun.YAML.stringify(v, null, 2)`）。不传出的是流式 YAML，
     合法但 omp 读不回来（实测写进去读出来 0 条）。
   - 必须写 `auth: none`：上游规定定义 `models` 时要么给 `apiKey` 要么 `auth` 是
     `none`/`oauth`，否则**整份配置失效**。密钥在 agent.db，不在这个文件里。
7. **可缺席的格在线上是 `null`，不是 `undefined`。** Rust 的 `Option::None` 经
   `serde_json::json!` 序列化成 null，桥那侧从 JSON 解出来也是 null。所以
   `protocol.ts` 里可缺席的格一律写 `?: T | null`，下游只许用 `??` 判。
   按 `=== undefined` 判会漏掉 null，后面 `.length` 一取就炸在
   「null is not an object」上（这一条已经发生过一次，见
   `src/__tests__/provider-input.test.ts`）。
8. **密钥不进 Debug 输出。** `ModelCatalogOperation` / `ProviderInput` /
   `ProviderReplacement` / `CatalogImport` 手写 `Debug`，只打判别式与 id。此前派生
   `Debug` 加上桥的 `format!("{other:?}")` 兜底，把用户的明文密钥写进了错误消息与
   `logs/poietica.log`（2026-09-24，两行，已擦洗）。回归测试在
   `crates/agent-client/tests/secret_debug.rs`。
9. **`disabledProviders` 在凭据之前判，所以「写配置」与「让它可见」必须同一次做完。**
   官方 providers.md 的「How omp decides a provider is available」定死了这个次序：
   停用的 provider 就算有钥匙也一条模型都不出。两处因此成对：

   - 桥的 `settingsFor()` **只**经官方写入面（`discovery` 的 `disableProvider`）停用
     外来 provider，不写 `Settings.override`。覆盖层是整份替换数组的：把开机那一刻
     读到的表钉进去，之后任何启停都被它盖住，删掉再建的 provider 永远回不来。
   - `create` / `replace` / `importCatalog` 三条路都要把目标 provider 从停用表里
     **拿掉**（`enableProvider`）。少了这一步，「删除」写进去的停用标记就永远盖着，
     人再配一次也回不来 —— 界面看上去正是「写了配置完全没反应」（2026-09-24 实测：
     `models.yml` 写得完好，界面两栏全空）。
10. **「从目录添加」不抄目录。** 目录里那一行的 baseUrl / api / 模型清单已经在 omp
    编在包里的目录里，原样添加只写钥匙并解除停用；只有改端点（`baseUrl`）或改 id 时
    才写 models.yml，且改端点走「只覆盖」那一格（`writeProviderOverride`），不声明
    `models` —— 声明了就是抄第二份目录，上游换了我们不跟。

## 待验证

- 一次真实模型轮次的完整事件流（当前只验到厂商拒绝那一步，正文流式与工具调用
  尚未用真凭据跑通）。
- `tools.approvalMode` 之外，产品是否需要暴露 `tools.approval.<tool>` 的逐工具
  策略（会话级放行那一档今天与「批准」同义）。
- 从目录添加时改 id 会把目录那一行整份搬进 models.yml。omp 认的是目录里的 id，
  所以新 id 拿不到上游目录的后续更新；产品是否需要拦一下改名，待定。
