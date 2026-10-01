# 0028 — Electron 是宿主，原生能力经 NAPI 同进程直达

## 状态

已接受，**已落地**。取代 Tauri 2 作为桌面宿主的全部形态：建窗、IPC、内置浏览器、资产协议、
打包与更新。产品不变量、传输的线上形状
（`packages/agent-bridge/src/protocol.ts` ↔ `crates/agent-client/src/wire.rs`）与 IPC
契约的产地（Rust 类型）都不动。

## 背景

三件事促成了换宿主，每一条都能指到具体代码：

1. **原生能力被一条多余的边界切成两跳。** 原生逻辑住在 `crates/`（`asset`、
   `terminal`、`git-adapter`、`agent-client`），进程边界却在 webview 边上：渲染层 →
   Tauri IPC → 组合根 → 要么就地处理，要么再 `tokio::process::Command` 起一个外部
   进程。第二跳是宿主强加的，不是能力的形状。

2. **内置浏览器是挂在主窗口上的原生子 webview。** 标签宿主、摆位、profile 隔离、
   弹窗拦截都压在 wry 的窗口坐标系与 `Window::add_child` 上
   （那份 Rust 实现在迁移前住在 `src-tauri`，现已由主进程的 TypeScript 重写承载）。

3. **契约的产地已经是 Rust，生成器只是实现。** 命令清单只有一份
   （`native/src/ipc/mod.rs` 的 `surface()`），生成物只有一份
   （`packages/contract/src/generated/ipc-bindings.ts`）。换宿主换不掉这张契约，
   换掉的只是它的上半截。

Electron 把第一条边界**去掉**（同进程），把第二条换成宿主自带的一等对象
（`WebContentsView`），第三条只换生成管线。

| 面 | Tauri 时代的做法 | Electron 时代的做法 | 为什么 |
| --- | --- | --- | --- |
| 宿主与进程模型 | wry 宿主 exe + 独立 Rust 组合根，两侧隔一条 IPC | Electron 44.x：主进程（Node）+ preload + 渲染进程，Rust 编成 `.node` 载入主进程 | 原生能力不再需要第二个进程来承载 |
| 原生调用路径 | IPC 命令 → 组合根 → `crates/`，或再起外部进程 | 主进程 `require` `.node`，`#[napi]` 函数直接调 `crates/` | 少一条序列化边界与一次跨进程往返 |
| IPC 契约生成 | Rust 类型经 `tauri-specta` 导出 `ipc-bindings.ts`，调用体是 `invoke()` | 同一份 Rust 类型经 `specta::function::collect_functions![]` + `specta-typescript` 导出同一个 `ipc-bindings.ts`，调用体是 `window.poietica.invoke(...)` | 产地不变（仍是 `surface()`），只换生成器与传输 |
| 内置浏览器 | 主窗口里的原生子 webview（`Window::add_child` + WebView2），profile 自己分 | 一个标签一个 `WebContentsView`：`contentView.addChildView` 挂载、`setBounds`/`setVisible` 摆位、`setWindowOpenHandler` 接管弹窗，`partition: 'persist:poietica-browser'` | 视图是宿主的一等对象；`<webview>` 已弃用且跑在渲染进程里 |
| 资产协议 | `poietica-asset://`，`register_asynchronous_uri_scheme_protocol` | `protocol.handle('poietica-asset', ...)` | 同一条自定义协议、同一份字节产地（`crates/asset`），只换注册点 |
| 终端流 | crate 的 sink 回调经 Tauri 事件推给渲染层 | 同一个 sink 经 `ThreadsafeFunction` 交给主进程推送 | 会话状态住 crate（AGENTS.md §3），宿主只负责搬运 |
| 桥的生命周期 | 组合根用 `tokio::process` 起 `resources/bun.exe` + `poietica-bridge.js` | **同一个 crate 起同一对东西**，只是随包目录搬到 `resources/agent/`；stdio 一行一条 JSON 原样保留 | 保留 omp 的 Bun 运行时边界（ADR 0021）；它是库，不是 Electron 模块 |
| 托盘与单实例 | `tauri-plugin-single-instance` + `TrayIconBuilder`；退出是请求，屏障归 shutdown | `requestSingleInstanceLock()` + Electron `Tray`；退出屏障与"强制退出"菜单项照搬 | 语义一模一样，只换 API |
| 窗口状态 | `tauri-plugin-window-state`，`StateFlags` = SIZE/POSITION/MAXIMIZED/FULLSCREEN（刻意不含 VISIBLE） | 主进程自己读写同一组字段 | 少一个插件，判据（不含 VISIBLE）保留 |
| 自动更新 | Tauri bundler + NSIS + `tauri-plugin-updater`（minisign） | electron-builder（NSIS）+ `electron-updater`；工具链迁到 `electron-vite` | 更新链路跟着打包链路一起走 |
| 打包体积 | bundler 产物 + 系统 WebView2 | electron-builder 产物自带 Chromium + Node | 用体积换确定性与宿主 API，见代价一节 |

## 决定

1. **宿主换 Electron，目录整体换。** `apps/desktop/src-tauri` 消失，代之以
   `apps/desktop/electron/`（主进程 + preload，JS/TS）与 `apps/desktop/native/`
   （Rust，编译成 NAPI-RS 的 `.node`）。`crates/` 不动 —— 它们本来就不认识 tauri。
   版本以 catalog 为准。

2. **原生能力不再经 IPC 命令序列化到外部进程，而是同进程内调用。** Electron 主进程
   `require` 那个 `.node`，Rust 代码跑在主进程的线程上。

3. **`#[napi]` 的 async fn 跑在 napi-rs 接管的那个 tokio 运行时上，不是事件循环。**
   `native/src/lib.rs` 的 `module_init` 用 `create_custom_tokio_runtime` 显式建了一个
   多线程 runtime（线程名 `poietica`），所有命令共享它 —— 慢的原生调用因此**不会**冻结
   界面。代价是 tokio worker 是有限资源，且**在 worker 上阻塞会 panic**
   （`Cannot block the current thread from within a runtime`）：凡是要阻塞的活
   （开 SQLite、等子进程）必须自己 `spawn_blocking`，`bootstrap::install` 就是按这条写的。
   同步 `#[napi]` 函数没有这层缓冲，直接阻塞事件循环，所以命令面一律是 async。

4. **IPC 契约仍是 Rust 类型为权威，命令清单仍只有一份。**
   `native/src/ipc/mod.rs` 是唯一产地：`types()` 挂类型、`functions()` 经
   `specta::function::collect_functions![]` 收函数签名、`submit()` 是那唯一一张分发
   表，三者必须同时出现在同一处，漏一条就是漏一条命令。生成物仍是
   `packages/contract/src/generated/ipc-bindings.ts`，由
   `cargo run -p poietica --bin export-ipc-bindings` 写出。

5. **传输换掉，渲染层仍是唯一消费者。** 命令入口的调用体从 Tauri 的 `invoke()` 换成经
   preload 暴露的 `window.poietica.invoke(command, args)`，底下是
   `ipcRenderer.invoke`。preload 是 `contextIsolation: true` 下唯一那扇门：渲染层拿到的
   是一组具名方法，不是 `ipcRenderer` 本身。

6. **内置浏览器用 `WebContentsView`，不用 `<webview>` 标签。** 一个
   `WebContentsView` 一个标签；`baseWindow.contentView.addChildView(view)` 挂载，
   `setBounds`/`setVisible` 摆位与显隐，`setWindowOpenHandler` 接管弹窗；
   `partition: 'persist:poietica-browser'` 承接原来那份独立 profile 的语义（浏览器数据
   与 UI webview 的必须分开）。`<webview>` 是被弃用的老路，且它跑在渲染进程里 ——
   标签的生死与导航就此落在不可信的一侧。

7. **资产协议换成 `protocol.handle('poietica-asset', ...)`。** 字节仍由 `crates/asset`
   读，URL 形状与错误信封不变，只换注册点。

8. **oh-my-pi 的集成方式不变。** 仍是 SDK 直接集成（`packages/agent-bridge` 里
   `createBridge`），仍跑在随包的 Bun 运行时里（`apps/desktop/resources/agent/` 下的
   `bun.exe` + `poietica-bridge.js`），stdio 一行一条 JSON 的传输原样保留。
   起进程的仍是原生侧（`crates/agent-client/src/session/bridge.rs` 的
   `tokio::process::Command::new(&resolved).arg(&bridge)`），而不是主进程 —— 会话生命
   周期归会话运行时，主进程不该在中间多插一手。**不**改成在 Electron 里直接 `import`：
   ADR 0021 的判据（`bun:sqlite`、Bun API 与 `bun:*` 模块的广泛使用、只认 bun 的
   `engines`）在 Electron 里逐条同样成立。

9. **打包与更新整体换到 Electron 侧。** electron-builder（NSIS）出安装包，
   `electron-updater` 做出货更新，构建工具链迁到 `electron-vite`。Tauri bundler、
   `tauri-plugin-updater` 与 minisign 那套随之消失。

10. **架构闸门跟着换判据。** "除生成物外只有 `@poietica/native-bridge` 可碰宿主 API"
    这条不变量保留，判据里的 `@tauri-apps/*` 换成对 `window.poietica` 的直接使用
    （`tools/architecture/layering.ts` 的 `HOST_AWARE_PACKAGES`）。
11. **生成本身也换侧。** Tauri 时代导出绑定的可执行文件住在 `src-tauri` 里；现在它就是
    `native` crate 自己的一个 bin，命令面与它同 crate，契约与产地之间再没有第二条编译单元。

## 后果

好处：

- 少一条序列化边界：资产、终端、git、浏览器这些高频路径不再为跨进程付税。
- 内置浏览器有了宿主自带的视图对象，标签的挂载、摆位、弹窗与 profile 都是现成语义，
  不用再在窗口坐标系里自己造一套。
- 渲染层与契约零改动：命令清单、生成物路径、`ipc-bindings.ts` 的形状都不变，改的只是
  调用体那一行与它底下的传输。
- 更新与打包是一条走熟了的链路（NSIS + electron-updater），签名与增量更新的边角不用自己维护。
- 宿主 API 面比 wry 宽：托盘、单实例、协议、视图、快捷键都有一等对象，胶水更少。

代价：

- **Rust panic 会杀主进程。** 同进程意味着 `.node` 里的 panic 不再有"外部进程死了再拉起来"
  这层隔离，进程一倒界面跟着倒。panic 必须在 Rust 侧收紧（`Result` 优先，边界处
  `catch_unwind`），不能再指望宿主兜底。
- **主进程持有的原生状态在重启前不会释放。** 终端会话、桥的连接、资产会话快照都挂在主进程
  生命周期上；以前重启边车就能清干净的，现在必须显式 teardown，清不掉就只能重启应用。
- **libuv 线程池是共享资源。** 默认槽位有限，被慢的原生调用占满会让其它 async 调用与 Node
  内建（`fs`/`dns`/`zlib`）一起排队；同步 `#[napi]` 函数则直接阻塞事件循环，要逐条审。
- **安装包体积远大于 Tauri。** Electron 自带 Chromium + Node，比"用系统 WebView2"大一个量级。
- **自动更新的钥匙换了。** minisign 的签名与验签配置作废，签名要用 electron-updater 认的
  那一套重配。
- **preload 就是攻击面。** 它暴露的每个方法渲染层都能调，`contextIsolation` 与
  `contextBridge` 用错一次就是远程代码执行。

## 待办

- [x] Electron 主进程入口与 preload 骨架（`apps/desktop/electron/`，含 `contextBridge`
      暴露的 `window.poietica.invoke`）
- [x] `apps/desktop/native/` 的 NAPI-RS 工程骨架，`native/src/ipc/mod.rs` 的 `surface()`
      随之迁入
- [x] `collect_functions![]` + `specta-typescript` 生成管线，产出与现
      `ipc-bindings.ts` 逐字对齐
- [x] napi 侧 `ThreadsafeFunction` 事件桥（终端流、transcript、托盘请求退出等原来走 Tauri
      事件的那几条）
- [x] `WebContentsView` 标签宿主（挂载、摆位、弹窗接管、`persist:poietica-browser`）
- [x] `protocol.handle('poietica-asset', ...)` 协议处理器，接到 `crates/asset`
- [x] 托盘、单实例锁与窗口状态迁移（判据保持"不含 VISIBLE"）
- [x] 打包与更新链路（electron-builder NSIS + electron-updater），签名与发布配置重做
- [x] 架构闸门与 CI：`HOST_AWARE_PACKAGES` 的判据从 `@tauri-apps/*` 换成 `electron`，
      `bun run check` 全绿
- [x] 删干净：`apps/desktop/src-tauri` 与 Tauri 依赖，不留兼容层与开关双活（AGENTS.md §8）

## 相关代码

- 契约产地与命令清单：`native/src/ipc/mod.rs` 的 `surface()`；生成物
  `packages/contract/src/generated/ipc-bindings.ts`
- 宿主：`apps/desktop/electron/{main,preload,native,ipc-router,asset-protocol}.ts`、
  `apps/desktop/electron/browser/{host,element-picker}.ts`
- crates（不动）：`crates/asset`、`crates/terminal`、`crates/git-adapter`、
  `crates/agent-client`
- 桥：`packages/agent-bridge/src/{bridge.ts,main.ts,protocol.ts}`、
  `crates/agent-client/src/wire.rs`
- 渲染层端口：`packages/native-bridge/src/`；分层闸门：`tools/architecture/layering.ts`
