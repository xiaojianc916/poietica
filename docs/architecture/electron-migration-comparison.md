# Tauri → Electron 迁移前后对比

> 数据截至本次迁移完成（2026-10-01）。所有数字都由仓库当前状态或 `git show HEAD:` 直接取得，
> 没有一处是估计值。架构决策与理由见 [ADR 0028](../adr/0028-electron-with-napi-is-the-desktop-host.md)。

## 一、一句话

宿主从 **wry 的 Rust 组合根**换成 **Electron 44 主进程**，原生能力从「跨进程 IPC 命令」
换成「同进程 NAPI 调用」，内置浏览器从「主窗口里的 WebView2 子 webview」换成
**`WebContentsView`**。契约的产地（Rust 类型）、传输的线上形状（omp 那条协议）与
oh-my-pi 的接入方式（SDK 直连 + 随包 Bun）**一个字没动**。

## 二、结构

| 面 | 迁移前 | 迁移后 |
| --- | --- | --- |
| 宿主进程 | `poietica.exe`（wry/tao 事件循环） | `electron.exe`（Chromium + Node 主进程） |
| Rust 组合根 | `apps/desktop/src-tauri/src/`，71 个文件 / 7995 行 | `apps/desktop/native/src/`，53 个文件 / 6575 行 |
| 宿主层语言 | 全 Rust（建窗、托盘、协议、IPC、浏览器都在 Rust 里） | 主进程 TypeScript（`apps/desktop/electron/`，8 个文件 / 2133 行）+ Rust 只留能力 |
| 原生调用 | IPC 命令 → Rust 组合根（跨进程序列化） | 主进程 `require('poietica.node')` → `#[napi]` 函数（同进程） |
| 能力 crate | `crates/`，132 个文件 / 21516 行 | **不变**（它们本来就不认识 tauri） |
| 渲染层 | `apps/desktop/src/`，86 个文件 | **不变**（只有传输那几行改了） |

## 三、命令面

| 面 | 迁移前 | 迁移后 |
| --- | --- | --- |
| 清单产地 | `collect_commands![…]`（110 条） | `collect_functions![…]`（89 条原生）+ 主进程自有命令 |
| 宿主自有的那 21 条 | 也在 Rust 里（`window_*` / `browser_*` / `diagnostics_*`） | 移出原生面，归主进程（窗口与视图是宿主的对象） |
| 绑定生成 | `tauri-specta` 的 `Builder::export` | `specta::function::collect_functions![]` + `specta-typescript` |
| 生成入口 | `apps/desktop/src-tauri/src/bin/export-ipc-bindings.rs` | `cargo run -p poietica --bin export-ipc-bindings`（同一个 bin，换 crate） |
| 生成物 | `packages/contract/src/generated/ipc-bindings.ts` | **同一个路径、同一份形状** |
| 调用体 | `TAURI_INVOKE('agent_prompt', { request })` | `window.poietica.invoke('agent_prompt', { request })` |
| 参数键 | snake_case（Rust 原名） | lowerCamelCase，**键与值同名**（一处名字一处写法） |
| 错误传输 | `invoke` 抛 Problem | preload 把 Problem 原样 reject；`throughIpc` 一行没改 |
| 事件订阅 | `events.x.listen(cb)`，异步返回卸载函数 | `events.x(cb)`，**同步**返回卸载函数 |

## 四、内置浏览器

| 面 | 迁移前 | 迁移后 |
| --- | --- | --- |
| 视图对象 | 主窗口的原生子 webview（`Window::add_child`，wry 的 `unstable` multiwebview） | `WebContentsView` + `win.contentView.addChildView` |
| 标签模型 | `crates/browser` 的 `Tabs`（Rust，进程内） | `apps/desktop/electron/browser/host.ts`（TypeScript，行为等价重写） |
| 摆位 | `set_position` / `set_size` + 自己算的 `PanelBounds::clamped` | `setBounds` + `Math.max(1, …)`（内核同样不接受零尺寸） |
| 显隐 | `webview.show()` / `webview.hide()`，对账表 `placed` 防重复下发 | `setVisible` + 同一张对账表 |
| 弹窗 | `on_new_window` 回调 → 新标签 | `setWindowOpenHandler` → `{ action: 'deny' }` + 新标签 |
| 站点数据 | WebView2 用户数据目录（`browser/profile/`） | `partition: 'persist:poietica-browser'`（与 UI 会话分开） |
| 外站能否碰 IPC | 靠 capabilities 没有 remote 声明 | 不注入任何 preload + `senderFrame.origin` 白名单，两头堵 |
| 元素拾取 | `eval` 注入 `window.__poieticaElementPicker`，回调走自定义 URL 的 `on_navigation` | `executeJavaScriptInIsolatedWorld(999, …)`，回调走 `will-navigate` 拦截 |
| 自检 | 无（跑在应用里） | `bun test apps/desktop/electron` 24 pass（假 View 桩，覆盖摆位/显隐/最近关闭/拾取/命令面） |

## 五、其余宿主能力

| 面 | 迁移前 | 迁移后 |
| --- | --- | --- |
| 资产协议 | `register_asynchronous_uri_scheme_protocol('poietica-asset')` | `protocol.handle('poietica-asset')` + `registerSchemesAsPrivileged`（`standard`+`stream`） |
| 大文件 range | wry 自己处理 | 手写 206 + `Content-Range` + `createReadStream`（`net.fetch` 不处理 range，且 [electron#38749](https://github.com/electron/electron/issues/38749) 至今 open） |
| 终端流 | `TerminalStreamed.emit(app)` → Tauri 事件 | `transport::emit("terminal_streamed", …)` → weak TSFN → 主进程 → 渲染层 |
| 单实例 | `tauri-plugin-single-instance` | `app.requestSingleInstanceLock()` |
| 托盘 | `TrayIconBuilder` | `Tray` + `nativeImage` |
| 窗口状态 | `tauri-plugin-window-state`（`StateFlags` 刻意不含 VISIBLE） | Electron 内置 `windowStatePersistence`（判据不变：仍不含可见性） |
| 主题 | `WindowSurface::adopt` → `Window::set_theme` + 两层底色 | `createWindowSurface` → `nativeTheme.themeSource` + `win.setBackgroundColor`（**两层收敛成一层**） |
| 文件对话框 | `tauri-plugin-dialog`（Rust 侧 `app.dialog()`） | 主进程 `dialog.showOpenDialog`（原生侧不再有对话框命令） |
| 打包 | Tauri bundler + NSIS | electron-builder 26 + NSIS（`asarUnpack: ['**/*.node']`） |
| 自动更新 | `tauri-plugin-updater`（**minisign** 密钥对） | `electron-updater`（**sha512**，无需要保管的私钥）；三条命令归主进程（`electron/update.ts`），与 `browser_*` 同一张表 |
| 构建工具链 | `tauri dev` / `tauri build` | `electron-vite` / `electron-builder` |

## 六、依赖

| 面 | 迁移前 | 迁移后 |
| --- | --- | --- |
| Rust workspace 依赖 | 17 个 `tauri*` | **0 个**；新增 `napi` / `napi-derive` / `napi-build` |
| JS 依赖 | `@tauri-apps/api`、`@tauri-apps/cli`、`@tauri-apps/plugin-dialog` | 全部移除；新增 `electron` / `electron-builder` / `electron-vite` / `electron-updater` |
| `bun.lock` 里的 `@tauri-apps` | 3 个包 | **0** |
| `Cargo.lock` 里的 `tauri*` | 有 | **0** |
| ABI 重建 | — | **不需要**：Node-API 是 ABI 稳定的 C 接口，`.node` 直接在主进程加载 |

## 七、不变的那些（迁移的边界）

- **oh-my-pi 的接入方式**：仍是 SDK 直接集成，仍跑在随包的 `bun.exe` 里，stdio 一行一条 JSON
  的传输原样保留。没有改成在 Electron 里 `import` —— 见 ADR 0021 的三条判据（`bun:sqlite`、
  Bun API 的广泛使用、只认 bun 的 `engines`），它们在 Electron 里逐条同样成立。
- **传输的线上形状**：`packages/agent-bridge/src/protocol.ts` ↔ `crates/agent-client/src/wire.rs` 一对。
- **`crates/` 的每一个 crate**：它们不认识宿主，这次一行没改（只有指向旧路径的注释锚点更新）。
- **产品不变量**：会话是唯一中心、屏幕经过由 transcript 提供、每类状态单一所有者、本地优先。

## 八、代价（诚实的部分）

- **Rust panic 会杀主进程。** 同进程意味着 `.node` 里的 panic 没有「外部进程死了再拉起来」这层隔离。
- **主进程持有的原生状态在重启前不释放。** 终端会话、桥的连接、资产会话都挂在主进程生命周期上。
- **tokio worker 是有限资源，且在 worker 上阻塞会 panic。** 凡是要阻塞的活必须自己
  `spawn_blocking`（`bootstrap::install` 就是按这条写的 —— 这是迁移中实测抓到的第一个真 bug）。
- **安装包体积大一个量级**：Electron 自带 Chromium + Node，而 Tauri 用系统 WebView2。
- **preload 是新的攻击面**：`contextIsolation` 与 `contextBridge` 用错一次就是远程代码执行。

## 九、验证证据

| 关卡 | 命令 | 结果 |
| --- | --- | --- |
| 全量门禁 | `bun run check` | **退出码 0** |
| 架构闸门 | `bun tools/architecture/verify.ts` | **通过：20 个工作区、16 个 crate** |
| 契约一致性 | `bun run ipc:check` | **退出码 0**（生成物与 Rust 命令面逐字一致） |
| 全工作区类型 | `bun run typecheck` | **22/22 通过** |
| Rust 测试 | `cargo test --workspace` | **全绿** |
| 渲染层测试 | `bun test packages apps/desktop/src` | 72 pass |
| 浏览器宿主 | `bun test apps/desktop/electron/browser` | **24 pass** |
| 端到端自检 | `bun run --filter @poietica/desktop electron:smoke` | **`smoke ok`**（真实加载 `.node`、走完 invoke 往返、收到事件帧） |
| 前端构建 | `bun run --filter @poietica/desktop electron:build` | **成功** |

## 十、迁移中实测抓到的真问题

这一节单独列出来，因为它们是「包级检查通过」之外的东西：

1. **`LocalIndex::open` 在 tokio worker 上直接阻塞** → `Cannot block the current thread from within a runtime`，
   第一次调用必 panic。修法：`NativeHost.start` 走 `spawn_blocking`，并把 `Handle` 显式传进去
   （阻塞线程上没有「当前 runtime」可问）。**这是 `electron:smoke` 抓到的，不是读代码看出来的。**
2. **20 条宿主命令在原生面留了空壳**（`browser_*` / `window_*` / `diagnostics_*` 只能返回 `Error::Internal`）。
   它们被移出原生面、归主进程 —— 空壳会让契约看起来有这条命令，实际上没有。
3. **11 条命令因 `pub(crate)` 静默从契约里消失过**（`automations_*` 与 `settings_*`）。
   是 `unreachable_pub` 这条 lint 把它们指出来的 —— 判据的价值在这里。
4. **`bootstrap.rs` 的 `Handle` 按值传但只借用**，clippy 的 `needless_pass_by_value` 指出后改引用。
5. **asar 里的 `.node` 会被 dlopen 抽到临时文件**（有开销、可能惊动杀软），而 Electron **不会**
   自动从 `app.asar.unpacked` 加载 —— 必须显式 `asarUnpack` + 运行时自己拼绝对路径。

## 十一、已知偏差

`domain-crates-are-reachable` 对 `poietica-browser-native`：`crates/browser` 仍是标签模型、
地址归一化、favicon 抓取与 picker token 的能力正本，但宿主换 Electron 后由
`apps/desktop/electron/browser/host.ts` 以 TypeScript 重写承载（视图对象只有宿主有），
crate 本身因此没有生产调用方。已登记在 [AGENTS.md](../../AGENTS.md) §10，闸门里写成具名例外。

