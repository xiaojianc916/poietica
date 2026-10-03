# 0038 内置浏览器经 omp 的 relay 交给 agent

日期：2026-10-03
状态：已接受
上下文：agent 的浏览器能力（ADR 0016/0021 接进来的 omp）

## 问题

agent 要用浏览器时自己拉一个 Chromium：一个独立窗口，与右侧栏那个内置浏览器
（Electron 主进程的 WebContentsView）毫无关系。用户要的是「AI 动的就是我眼前
这一台」，并且操控开始时右栏要自己开出来。

## 决策

内置浏览器作为 omp 浏览器工具的**第三档**接进去：走它自己的 relay 通道
（`browser.relay`，端点默认 `http://127.0.0.1:9224`）。

relay 是 omp 留给「驱动用户自己的浏览器标签页」的口子：本机一个 HTTP + WS 服务
冒充 Chrome 的 CDP 发现端点（`/json/version`、`/json/list`、`/cdp`），另一头本该由
它的 Chrome 扩展拨进 `/ext`。**那一侧由主进程扮演**
（`apps/desktop/electron/browser/relay.ts`）：应用不用装浏览器扩展，因为主进程手上
就有 `webContents.debugger` —— 与扩展用的 `chrome.debugger` 是同一套东西，
omp 看到的是一台普通浏览器，实际动的是面板里的标签。

### 为什么不走「开应用级 CDP 端口再把 cdpUrl 指过去」

那条路上整个应用共用一个调试面，**主界面自己也是一个 page target**；而 omp 挑
target 的判据是「可见的、或枚举到的第一个」（它的 `src/tools/browser/attach.ts`
的 `pickElectronTarget`），agent 会一头钻进主界面。relay 那条路上没有别的
target，「挑错页面」从根上不成立，也不必把主界面端到回环上。

### 三档的判据

`browser.relay` 为真即内置浏览器；否则 `cdpUrl` 为 null 是托管启动、有地址是附着到
现成端点。这在 omp 的 `resolveBrowserKind` 里就是 relay 优先于 cdpUrl，产品侧照抄
同一顺序，不另立一套。

## 后果

- **默认落在内置浏览器这一档**，但写的是默认不是强制：只有 `browser.relay` 从来没被
  谁配过（`Settings.isConfigured` 为假）才落一次。用「有没有被配过」而不是读值 ——
  值和 schema 默认相同时读不出来「有没有人选过」，那会把用户特意选的托管启动
  一次次改回来（`packages/agent-bridge/src/bridge.ts` 的 `settingsFor`）。
- 右栏自己开：relay 一接上就是「agent 正要动浏览器」的信号（主进程发
  `browser-driven`），`connectWorkbench` 据此展开面板并切到浏览器那一段。一个标签都
  没有时宿主先开一个空白标签，CDP 端点上才有页面可听 —— 用户不必先点开面板。
- relay 服务端由 omp 自己按需拉起，拉的是 **sidecar**（`resolveWorkerSpawnCmd`），
  所以 `packages/agent-bridge/src/main.ts` 必须认 `browser-relay` 这个子命令并把参数
  交给它自己的 CLI；少这一支，omp 拉起来的进程会把参数当 worker 选择器丢掉。
- 线上形状的正本是 omp 的 `src/tools/browser/relay/protocol.ts`（锚定 18.5.0）：
  它内部的契约、没有版本号，所以升级 omp 时两侧一起核。
- 原先在设置页里靠「探活猜端点」的那一档（`browser-endpoint.ts`、`endpoint-alive`）
  整支删除：内置浏览器现在是一个**真实**的地址，不用猜，也不改写用户的选择。
- 四条与内核打交道的硬约束（判据都在 `browser/relay.ts` 与 `browser/host.ts` 里就近写明）：
  - 没导航过的 WebContents 收不到 CDP：Electron 既不回执也不报错，relay 侧只会等到
    20s 超时。空白标签就是这一档，所以发命令前先给内核补一张 about:blank；
  - `hello` 带一个每次启动都不同的 `instanceId`。不带就落进 relay 的「anon」档，
    那里是「最新连接顶掉旧连接」：任何另一个 `/ext` 连接（另开一扇面板、别人的探针）
    都会把这一侧的注册清掉，而 TCP 还是 ESTABLISHED，看起来一切正常；
  - 内核为一轮 detach 会发不止一条 `detach` 事件。回执必须**每一条**都算 relay 主动，
    少一条就被判成「用户拆了调试器」，relay 把这张标签拉黑，面板的页面从此不在 CDP
    发现里，之后每次 `browser.open` 都只得到「没有可用页面」；
  - 面板那一页的地址由内核的 `did-navigate` 落账（host.ts 的 `noteUrl`）。地址是
    「这一页有没有东西可摆」的判据，所以落账要和 `layout()` 同批结算 —— 只报状态不重摆，
    agent 经 CDP 导航过来的页面就只有地址和标题、没有画面，要等用户拖一次分隔条。
- **第一次 `browser.open` 要给足预算。** omp 的浏览器工具链在 sidecar 进程里是懒加载的：
  刚起 sidecar（尤其刚 `bun dev` 重写过 `resources/agent/`）之后的第一次调用实测要几十秒，
  而工具的默认只有 30s（`TOOL_TIMEOUTS.browser`，上限 300s），于是那一次必然超时、页面却
  照样打开。这一段在 omp 侧，与本仓 relay 无关（relay 实测：daemon 1.3s 就绪、面板 1s 内
  hello、每条 CDP 毫秒级、冷加载一次站点 2.5s）。调用方给 `timeout: 120` 即过，之后每次秒回；
  agent 侧的那条规则写在受控 home 的 `managed-skills/poietica-drive-builtin-browser`。
