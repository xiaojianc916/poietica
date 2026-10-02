# apps/desktop 审计（缺陷 + 性能）

范围：`apps/desktop/src/**`、`apps/desktop/electron/**`、`apps/desktop/*.ts|.html|.json`。
方法：静态阅读全量源码（84 个源文件 / 9404 行）+ CDP（真实 Electron 宿主）实测 + 可复现微基准。
所有「已修复」都有测试或前后测量；纯观察写在「仅报告」。

验证命令（全绿）：
```
bun run --filter @poietica/desktop test        # 111 → 现 112 pass / 0 fail
bun run --filter @poietica/desktop typecheck   # 3 个 project 全过
bun run test:architecture                      # 20 工作区 / 16 crate
```

---

## 已修复

### 1. 图片附件预览 100% 取不到字节：handler 认的地址形状与正本产出不一致

- 位置：`apps/desktop/electron/asset-protocol.ts:71-75`（原 67-75）
- 事实：
  - 正本 `crates/asset/src/delivery.rs:13-21` 的 Windows 分支产出
    `http://poietica-asset.localhost/asset/<sessionToken>/<contentHash>`；
    实测 `asset_import` 一张真 PNG 返回的 `source` 就是这个字符串。
  - `main.ts:756` 只注册了 `protocol.handle('poietica-asset', …)`，**没有任何东西应答
    `.localhost` 那个 http 源**。渲染层 `<img src>` 指向它 → 网络面板实测
    `net::ERR_CONNECTION_REFUSED`（reqid=521）。
  - 而 `packages/conversation/src/surface/composer/attachment-tray.tsx:149` 正是拿它当
    `<img src>`。⇒ 附件托盘里的图片预览在真实宿主里从来没有显示过。
  - 同一文件的 `filePath()` 只认 `poietica-asset://blob/<hash>`，**全仓没有任何地方产出过
    这个形状**（grep 无命中），是死分支。
- 修复（与 Lead 复核后按 D 方案，只动 desktop 侧；Rust 侧 `delivery.rs` 由 audit-rust 落地）：
  - `filePath()` 改认正本形状 `poietica-asset://asset/<sessionToken>/<contentHash>`：
    `hostname === 'asset'` 且两段路径，取**最后一段**当哈希；session 段不参与取字节
    （字节按内容寻址，与令牌无关）。死分支 `blob` 删除（§8 一次换干净）。
  - 摘要判据从 `/^[0-9a-f]{8,128}$/` 收紧为 `/^[0-9a-f]{64}$/`，与正本
    `crates/asset/src/formats.rs` 的 `is_content_hash` 同一条。原正则把「64 位摘要」
    放宽成 8-128 位任意十六进制，等于给「哪些路径算资产」留第二个答案。
- 证据（真实 Electron，CDP 实测）：
  | 项 | 前 | 后 |
  | --- | --- | --- |
  | `poietica-asset://asset/<s>/<真实hash>` `<img>` | onerror | **onload 32×32** |
  | 同上 `fetch()` | 400 | **200 / content-length 2078** |
  | 同上 + `Range: bytes=0-7` | 400 | **206 / bytes 0-7/2078** |
  | `poietica-asset://blob/<hash>` | 200（死形状） | **400**（已删） |
  | 逃逸 `..%2F..%2Fsettings.json` | — | 400 |
- 测试：`apps/desktop/electron/asset-protocol.test.ts`（新增，15 个用例）——
  正本形状命中、session 段无关、缺/多/空段拒、host 不对拒、查询串拒、哈希不合规拒、
  合规但文件不在 404、Range 四种、逃逸拒。

### 2. Content-Type 按扩展名判，而资产文件名是 sha256 全文（没有后缀）

- 位置：`apps/desktop/electron/asset-protocol.ts:17-37`（原）
- 事实：落盘正本是 `<dataRoot>/attachments/<hash 前两位>/<hash>`（`crates/asset/src/blob.rs:33-39`），
  **文件名就是 64 位摘要，没有扩展名**。原实现 `path.slice(path.lastIndexOf('.') + 1)`
  取到的永远是整串哈希 → switch 全落 default → **每一个**字节都被报成 `text/plain`。
  那张扩展名表对经这条协议取出的任何字节都是死代码。
- 修复：换成按文件头嗅探，逐条与正本 `crates/asset/src/formats.rs` 的 `FORMATS` 同表同序
  （PNG/JPEG/GIF/BMP/WEBP/AVIF），认不出来回 `application/octet-stream`（★不再回
  `text/plain` —— 那是把二进制谎报成文本，嗅探方会因此不去嗅）。注释里注明正本当前路径
  （AGENTS.md §4）。实现**只读开头 12 字节**（`openSync/readSync/closeSync`），不整份读进内存。
- 证据（Lead 放的三张真图 + 一张 32×32 真 PNG，经真实 handler）：
  ```
  png  ec453a7b… → image/png    (78 B)
  gif  ef1955ae… → image/gif    (42 B)
  jpeg cb0501d6… → image/jpeg   (160 B)
  32×32 png      → image/png    (2078 B, 首字节 0x89 0x50)
  ```
  与 crates/asset 的 `FORMATS` 逐条一致；`<img>` 对 text/plain 的 PNG 恰好会靠内容嗅探
  蒙对（实测 onload 成功），但那是运气，不是正确性。
- 测试：同文件新增 4 个用例（六种文件头各一次、判不出回 octet-stream、空文件回
  octet-stream、Range 请求的类型与整份一致）。

### 3. 面板拖动时逐帧对每个标签重复下发同一个可见性

- 位置：`apps/desktop/electron/browser/host.ts:232-236`（原）
- 事实：`layout()` 每次都无条件 `tab.view.setVisible(shown)`；而 `layout()` 是
  `setBounds`（`packages/browser/src/viewport-alignment.ts` 按 rAF 帧上报）与窗口 resize
  共同的落点。拖动辅助面板/窗口的那一秒里，每个标签每一帧都被叫一次。
- 实测（用 `host.test.ts` 同一套假视图，5 标签 × 60 帧）：
  | | setVisible 调用 | setBounds 调用 |
  | --- | --- | --- |
  | 前 | **300**（5/帧） | 60 |
  | 后 | **0**（可见性没翻转） | 60 |
- 修复：`Tab` 增加 `shown` 字段记「上一次下发的可见性」，只在真的翻转时叫内核。
  省的是重复，不是真变化 —— 翻转两次仍下发两次。
- 测试：`apps/desktop/electron/browser/host.test.ts` 新增
  「可见性没翻转就不叫内核；翻转了就照旧下发」。

### 4. `electron/` 下 3 个测试文件、40 个用例根本没进门禁

- 位置：`apps/desktop/package.json:7`
- 事实：脚本是 `bun test src`，而 `apps/desktop/electron/` 下有 `browser/host.test.ts`、
  `update.test.ts`、`native-paths.test.ts`。实测 `bun test src` 56 用例、
  `bun test src electron` 96 用例 —— 宿主侧（浏览器标签模型、更新相位、原生库路径）
  整整一半的自检从来没被 `bun run check` 的 turbo test 跑到过。
- 修复：`"test": "bun test src electron"`（Lead 批准）。现在 112 个用例进门禁。

---

## 仅报告（不在本任务写入范围，或经复核后判定不值得改）

### R1. `crates/asset/src/delivery.rs` 的 Windows 分支是 WebView2 时代的过期绕法
`delivery.rs:4` 注释写着「Windows 上 WebView2 走不了自定义 scheme，只能借 .localhost 的
loopback 特例」—— 那是 Tauri 时代的前提。ADR 0028 已把宿主换成 Electron，`main.ts:39`
把 `poietica-asset` 注册成 `standard/secure/stream/fetch/cors` 的特权 scheme，
真宿主里自定义 scheme 直接可用（改完 desktop 侧后实测 200）。**由 audit-rust 落地**
（Lead 已派），落地后那个 `cfg!(windows)` 分支与 `.localhost` 常量可整段删除。
本任务未触碰 `crates/**`。

### R2. `apps/desktop/package.json` 的几处死配置
- `:21` `"electron:dev:with-picker": "electron-vite dev"` 与 `:14` `"electron:dev"` 的尾部
  一字不差，是个没人引用的别名（全仓 grep 无命中）。
- `:14` `electron:dev` **不**跑 `:16` 的 `electron:picker`，只有 `:15` `electron:build` 跑。
  于是 dev 下 `dist-electron/element-picker.js` 不存在，`loadPickerScript()`
  （`browser/element-picker.ts:188-204`）走 catch、缓存 null，
  `browser/host.ts` 的 `setElementPicker` 记一句 warn 就返回 —— **元素拾取在开发期
  永远起不来，且不报错**。（实测：`dist-electron/` 里只有 main.cjs/preload.cjs；
  `fs.existsSync('dist-electron/element-picker.js') === false`。）生产构建有这一步，
  所以这是「开发期静默失效」。修法要动 dev 脚本链，超出「审计」的收益判断，交 Lead 定。

### R3. `dist-electron/electron-vite dev` 默认不监听主进程
`electron-vite` 只在带 `-w/--watch` 时才 `chokidar` 主进程并重启 Electron
（`electron-vite/dist/chunks/lib-7y7CgM8M.js:27-36`）。此前改 `electron/` 不会生效，
是本轮审计一开始「改了但行为没变」的直接原因。Lead 已改用 `--watch -w` 重启 dev。

### R4. 会话列表每变一次就全量重注册命令，订阅者被线性放大
- 位置：`apps/desktop/src/workbench/connections.ts:63-80`
- 事实：`listChanged` 先 `commandReleases.splice(0).reverse()` 全撤，再按 N 条会话全量
  `commands.register`；而 `CommandRegistry.emit()`（`packages/workspace/src/command-registry.ts:42-47`）
  **每次注册都换一次快照并同步通知全部订阅者**。订阅者里有
  `createKeybindingCatalog`（`workbench/app-shell.tsx:181`）与
  `useCommandKeybindings` 的 `chordIndex`（`shell/commands/keybinding.ts:92`），两者都在
  回调里重建整张表 —— 一次列表变化 = 2N 次建表。
- 实测（复刻真实三段的微基准 `.audit/probe-commands.ts`）：
  | 会话数 | 一次列表变化 | 订阅者回调 | 键位表重建 |
  | --- | --- | --- | --- |
  | 10 | 1.13 ms | 20 | 20 |
  | 50 | 0.38 ms | 100 | 100 |
  | 200 | 1.02 ms | 400 | 400 |
  | 500 | 10.52 ms | 1000 | 1000 |
  | 1000 | 7.93 ms | 2000 | 2000 |
- 没动手的理由：修法有两处且都要再改公共契约 —— `register` 批量登记（一次 emit），
  以及 `chordIndex`/`catalog` 用「快照里的 shortcut 子集」当判据而不是整张快照。
  后者会碰 `app-shell.tsx` 的 `createKeybindingCatalog`（本任务范围内）但语义要重想
  （`shortcut` 是命令的字段，子集变了才需要重建）。数值在 500 条会话这个量级才到
  10 ms，且只在列表真的变化时发生 —— 不是「看起来更快」而是「量到才改」的边界，
  因此留报告。**这也不在「必查清单」的确认缺陷里，属性能优化项。**

### R5. 首帧关键路径上的 IPC 往返（实测）
在真实宿主里逐条量（`performance.now()` 包住 `window.poietica.*`）：
| 调用 | 实测 | 备注 |
| --- | --- | --- |
| `workbench_session_load` | 1.2 ms | `main.tsx:20` 首帧前必经，值这个价 |
| `host.homeDirectory()` | 1.1 ms | 后台 |
| `host.appVersion()` | 0.9 ms | 设置页按需 |
| `host.isMaximized()` | 0.6 ms | |
| `settings_get` | 3.5 ms | `mount.tsx:102` 首帧前必经 |
| `host.setTheme(preference)` | **81-123 ms**（首次）/ 1.6 ms（同值再调） | 见下 |

`setTheme` 第一次要等 Electron 重建 `nativeTheme` 并回读，**首帧前的 `mount.tsx:112`
会等它**，实测 81-123 ms 落在「React 首帧 → 窗口 present」之间。主进程侧同一步
`createWindowSurface`（`main.ts:195-204`）在窗口创建时已经落定过同一档主题
（ADR 0012/0007 的三层同步），也就是说这 80+ ms 里大部分是在**重复问一件已经知道的事**。
没动手的理由：`theme-runtime.ts:48-85` 的次序注释指出「宿主先解钉、渲染层再投影」是有意
的（反过来 matchMedia 会读到上一个偏好），改它要重新论证运行期切换的语义，
不是审计能顺手做的位移。仅报告数字。

首帧标记实测：`poietica:first-commit` 在 `domContentLoaded` 之后（reload 后实测
mark 6311 ms / DCL 5319 ms，dev 模式 250 个模块请求）。`main.tsx:20` 的
`await readWorkbenchSession()` 与 `mount.tsx:102` 的 `await settings.load()` 是首帧前
仅有的两处串行等待，两者都是「首帧的输入」（恢复的工作台、主题），值这个价，未改。

### R6. 窗口尺寸极端值：不塌，但 320px 宽时主区只剩 45px
CDP 实测（`emulate` 视口）：
| 视口 | 横向溢出 | 侧栏 | 主区 | 窗口控件 |
| --- | --- | --- | --- | --- |
| 800×600（`minWidth/minHeight`） | 无 | 267 | 525 | 可见 |
| 320×480（低于最小尺寸） | 无 | 267 | **45** | 可见（挤在主区里） |
| 2560×1440 | 无 | 267 | 2285 | 可见 |
`main.ts:255-256` 的 `minWidth: 800 / minHeight: 600` 让 320px 这一档只在
`emulate` 下才可能出现，真实窗口到不了。无布局崩塌（`docScroll === docClient`），
不需要改。

### R7. 无障碍与键盘可达性：本轮未发现缺陷
- 53 个可交互元素（button/a/input/textarea/role=button/tabindex）**全部**有
  `aria-label` 或文本名；`tabindex="-1"` 只有 1 个（设计系统内部）。
- 键盘实测：`Ctrl+B` 收/开侧栏（`data-sidebar-docked` 与列宽变量同步翻转）、
  `Ctrl+K` 开命令面板（`role=dialog` 出现，焦点**落在面板内的** `input[role=combobox]`）、
  `Escape` 关闭并把焦点交回 `body`。
- 命令面板的 `Dialog`（`shell/commands/command-palette.tsx:49-57`）走设计系统，
  `showHeader={false}` 但 `title="搜索"` 仍在（渲染成 `sr-only`），符合它自己的注释。
- 未验：焦点陷阱在 Tab 到最后一个元素后是否循环（命令面板由设计系统承载，
  不在本仓 desktop 侧）。

### R8. `element-picker-runtime.ts` 是 714 行的单文件
`apps/desktop/src/browser/element-picker-runtime.ts`：CSS（205-237 行）与注入面板的
DOM/状态机同住一个文件，且是一份**必须自成一包**的注入脚本（构建期 `bun build` 打成
IIFE）。按 AGENTS.md §4 的四条拆分判据逐条对照，它一条都不满足（没有第二个判别式主干、
没有两种寿命的状态、只服务一类读者、头注释一句话说得清）—— **不拆是对的**，
记在这里是为了让下一次审计不必重新数行数。

---

## 未覆盖

- 打包链路（`electron-builder.yml`、NSIS）与自动更新实际下载：需要签名与真实发布渠道，
  本机不可复现，未验。
- `apps/desktop/src/browser/element-picker-runtime.ts` 在真实外站页面上的拾取行为：
  需要内置浏览器打开一个真站点并手动拾取，本任务只做了静态阅读与宿主侧测试。
