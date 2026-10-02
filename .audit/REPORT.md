# Poietica 全量审计报告（Chrome-DevTools MCP 驱动真实 Electron 宿主）

时间：2026-10-02 01:11 → 02:55（Asia/Shanghai）
范围：全仓（packages 17 个、crates 16 个、apps/desktop、tests、tools）
宿主：`bun run dev` → electron-vite → 真实 Electron 44（http://localhost:1420，CDP 127.0.0.1:9222）
**未做任何 git add / commit / stash** —— 最终审查由人来做。

---

## 0. 先说一件基础设施缺陷：Chrome-DevTools MCP 一直没连上真宿主

审查开始时，MCP 的配置是：

```yaml
args: [-y, chrome-devtools-mcp@latest, "--browserUrl http://127.0.0.1:1420"]
```

两个问题叠在一起，结果是 MCP **从来没有**连上 Poietica，而是在驱动它自己起的那个 Chrome：

1. **端口选错了**：1420 是 Vite 的渲染层 dev server，不是 CDP 端点。CDP 在 9222
   （Electron 要带 `--remote-debugging-port=9222` 才有）。
2. **argv 形状错了**（这条更隐蔽）：`--browserUrl http://...` 写成了**一个** argv 元素。
   chrome-devtools-mcp 用 yargs 解析，单 token 形式它不认。实测：
   ```
   ONE TOKEN : browserUrl= undefined      ← 参数静默丢失
   TWO TOKENS: browserUrl= "http://127.0.0.1:9222"
   ```
   参数丢了于是 `browserUrl` 为 undefined，`BrowserManager.#initBrowser()` 走 `#launch()`
   分支，自己起一个 Chrome —— **不报错、不警告**，看起来一切正常。

已修（C:\Users\陈小建\.dsh\profiles\desktop\cordis.patch.yml）：拆成两个 argv 元素并指向 9222，
Electron 侧用 `REMOTE_DEBUGGING_PORT=9222` 启动。修完 `list_pages` 直接显示
`Poietica (http://localhost:1420/)`，`evaluate_script` 能读到 `window.poietica`（真 preload 桥）。

**这条值得记住**：在这之前所有"用 MCP 看 Poietica"的结论，看的都不是 Poietica。

---

## 1. 最终门禁

| 命令 | 结果 |
| --- | --- |
| `bun run check` | **exit 0**（biome + 架构闸门 + 38 个 workspace 的 typecheck/test + rustfmt + clippy -D warnings + cargo test + ipc:check） |
| `bun run check:web` | 38 successful / 38 total |
| `bun run check:rust` | 全绿 |
| `bun run test:architecture` | 20 工作区、16 crate |
| `cargo fmt --all -- --check` | exit 0 |
| biome | 729 files clean |
| 测试总数 | @poietica/conversation 437、@poietica/desktop **112**（原 56 —— electron/ 下 40 个用例此前根本没进门禁） |

---

## 2. 修掉的缺陷（按严重度）

### 2.1 图片附件预览在真宿主里 100% 失败（功能性，最重）

- **症状**：往对话里贴一张图，托盘里永远只有一个占位块。
- **根因**（两条各自独立的分叉）：
  - Rust 正本 `crates/asset/src/delivery.rs:13` 在 Windows 上返回
    `http://poietica-asset.localhost/asset/<sessionToken>/<contentHash>`
    —— 那是 **Tauri/WebView2 时代**的绕法（注释里就写着"WebView2 走不了自定义 scheme"）。
    但 ADR 0028 已把宿主换成 Electron，而 `electron/main.ts:756` 只注册了
    `protocol.handle('poietica-asset', …)`，**没有任何东西应答那个 .localhost 的 http 源**。
    渲染层 `<img src>` → `net::ERR_CONNECTION_REFUSED`。
  - TS 侧 `asset-protocol.ts:70` 只认 `poietica-asset://blob/<hash>`，而**全仓没有任何地方
    产出过这个形状**（grep 无命中）—— 是死分支。
- **实测**（真实 Electron，真 hash）：
  | 地址 | 前 | 后 |
  | --- | --- | --- |
  | `poietica-asset://asset/<s>/<hash>` fetch | 400 | **200** |
  | 同上 `<img>` | onerror | **onload 8×8** |
  | 同上 `Range: bytes=0-7` | 400 | **206 / bytes 0-7/78** |
  | `poietica-asset://blob/<hash>` | 200（死形状） | **400**（已删） |
- **改法**：Rust 三平台统一返回自定义 scheme（删 `cfg!(windows)` 与 `.localhost` 常量）；
  TS `filePath()` 改认正本形状并把摘要判据从 8–128 收紧到 64 位（对齐 `is_content_hash`）。
  两侧同一次改完，不留兼容层。

### 2.2 每一个资产都被报成 text/plain（正确性）

- **根因**：`asset-protocol.ts` 的 `contentType()` 按**扩展名**判类型，而落盘正本是
  `<dataRoot>/attachments/<hash 前两位>/<hash>` —— **文件名就是 64 位 sha256，没有后缀**。
  `path.slice(lastIndexOf('.') + 1)` 拿到的永远是整串哈希，switch 全落 default。
  那张扩展名表对经这条协议取出的**每一个**字节都是死代码。
- **实测**：真 PNG / GIF / JPEG 取回来全是 `text/plain`（`<img>` 恰好靠内容嗅探蒙对，
  那是运气不是正确性）。
- **改法**：换成按文件头嗅探，与正本 `crates/asset/src/formats.rs` 的 `FORMATS` 同表同序，
  判不出回 `application/octet-stream`；**只读前 12 字节**，不整份进内存。
- **实测（后）**：png → `image/png`、gif → `image/gif`、jpeg → `image/jpeg`。

### 2.3 目录标记跨对话串号 + 永不释放（正确性 + 内存）

- **位置**：`packages/conversation/src/transcript/transcript-projector.ts:1019`
- **根因**：模块级 `Map<turnId, TurnMark>`，**只写不删**。而 turnId 在每条对话里都从 `t1`
  重新编 —— 于是 A 对话的题面与回复会被发给 B。开过的对话越多，常驻内存越大，
  没有任何回收时机。
- **实测**：MCP 真宿主上两条对话各自 `outlineOf` 后 `b[0] === a[0]` 为 **true**（B 拿到 A 的正文）。
- **改法**：换 `WeakMap<TranscriptTurn, …>`（与同文件 `TURN_PROJECTIONS`/`WRAPPED_PAGES` 同形态），
  既认归属又有界；同一次把矛盾注释改对（AGENTS.md §6）。
- **副作用与补偿**：换身份键后流式轮每帧换新 turn 对象，`reply` 要整轮重拼，实测
  **回退 5.3×**（0.0212 → 0.1128 ms）——加逐段 `STEP_REPLIES` memo 补回。

### 2.4 人答过的授权从来不写回账（正确性，最重的一条后端缺陷）

- **位置**：`crates/agent-client/src/session/bridge.rs:1776`
- **根因**：`record_permission_resolved` 在生产代码里只有 `record_pending_cancelled` 一个
  调用方，而收摊只处理**还挂着**的请求 —— 于是每一帧 `permission_requested` 都没有终局。
  按 ADR 0002「那份日志才是权威」去读，读到的永远是"没人答过"。
- **证据**：把修复单独回退，新回归测试 FAILED（`must be filed as resolved: Elapsed`）。

### 2.5 跨轮丢帧账溢到下一轮（正确性）

- **位置**：`crates/agent-client/src/recorder.rs:160`
- **根因**：`lost` 只在 `settle_pending_end` 清零，两轮之间掉的帧会把**跑得好好的**一轮
  报成 `RunFailed: dropped 1 frames`。修复前测试 FAILED。

### 2.6 开发期元素拾取静默失效（功能性）

- **根因**：`dist-electron/element-picker.js` 只有 `electron:build` 会打，而 `electron:dev`
  不跑它；更关键的是**主进程每次构建都会清空 dist-electron**（实测：改一次 `electron/main.ts`，
  先打好的文件就被删）。于是 `loadPickerScript()` 落进 catch、缓存 null，
  `host.ts` 只 warn 一句 —— 拾取起不来，且不报错。
- **改法**：新增 `apps/desktop/vite-plugins/element-picker-script.ts`，挂在主进程构建的
  `closeBundle` 上（与那次清空同序：清空 → 写 main.cjs → 重打拾取脚本），
  内部调 `bun run electron:picker`（命令只有一份正本）。
- **实测**：删掉 element-picker.js → `electron-vite build` → **文件自己回来了**。
- 顺带删掉死配置 `electron:dev:with-picker`（与 electron:dev 一字不差，全仓零引用）。

### 2.7 electron/ 下 40 个用例没进门禁

- `apps/desktop/package.json:7` 是 `bun test src`，而 `electron/` 下有 3 个测试文件
  （浏览器标签模型、更新相位、原生库路径）。**宿主侧一半的自检从来没被 `bun run check` 跑到过**。
- 改成 `bun test src electron`：56 → 112 个用例进门禁。

### 2.8 拖动面板时逐帧重复下发可见性

- `electron/browser/host.ts` 的 `layout()` 无条件 `setVisible`，而它是 rAF 帧频上报的落点。
- 实测 5 标签 × 60 帧：**300 次 → 0 次**（可见性没翻转）。已加回归测试。

### 2.9 工具链：checkin 的 bench 脚本是坏的

- `tests/benchmark/reads.bench.ts` 的假端口早于 `subscribeQueue`/`subscribePromptDropped`/
  `readQueue` 三个方法，一跑就 `TypeError` —— `bun run bench:reads` 自诞生起就没成功过。
  补齐端口后可用（现在报 1 次整份正文 / 0 次重新取回）。

---

## 3. 性能优化（都有前后测量）

| 项 | 前 | 后 | 倍率 |
| --- | --- | --- | --- |
| 每帧整轮重投影（200 轮语料） | 0.8356 ms | 0.2508 ms | **3.3×** |
| 条目身份 churn（每帧新建对象） | 241401 | 31 | **7800×** |
| 幽灵行收割（200 行，WAL+synchronous=FULL） | 323.06 ms | 7.85 ms | **41×** |
| 会话列表变化的命令重注册（1000 条会话） | 5.74 ms / 4000 回调 | 0.09 ms / 4 回调 | **64×** |
| 拖动时 setVisible 调用（5 标签×60 帧） | 300 | 0 | — |
| `Frame::Response` 的整份 data.clone() | 每次打开对话白复制一整页（可达数 MB） | 移动 | — |

- **条目身份 churn 那条最值钱**：它才是 `TimelineRow`/`TimelineSeat` 的 `memo` 真正能生效的前提
  —— 此前可见行 100% 每帧重建。
- **命令重注册**：`CommandRegistry` 加了 `registerAll`（一批只换一次快照、只通知一次），
  `connections.ts` 改用它。登记同样的命令逐条做与批量做语义完全一样，区别只是中间态算不算数。
- **没有改**：`appendAtOffset` 看着像 O(n²)，实测单条 append 成本与轮宽/步数**无关**
  （flat），不是问题，未动。

---

## 4. 模拟/测试覆盖（Chrome-DevTools MCP 驱动真宿主）

| 场景 | 结果 |
| --- | --- |
| 12 个设置页逐页进入 | 11/12 标题吻合（MCP 页标题为"精选"，组件一致，非缺陷） |
| 命令面板（Ctrl+K / 搜索） | 列表、快捷操作、Ctrl+N 编号正常 |
| 辅助面板四个启动器 | 全部可切换，`aside` 内容随之变化 |
| 输入框：多行、Shift+Enter 换行、清空、发送键使能 | 全部正常 |
| 三个下拉菜单（批准方式 / 模型档位 / 添加内容） | 全部展开且条目正确 |
| 五个窗口尺寸（800×600 → 2560×1400） | 零横向/纵向溢出，无离屏元素 |
| 键盘 Tab 遍历 22 个可聚焦元素 | 焦点环 **22/22** 全部可见 |
| 20 次会话切换（堆内存） | +4 MB 并稳定 —— **无泄漏** |
| 长对话滚动 400 帧 | p50 6ms / p99 9ms / max 12ms，**零长帧** |
| 控制台（全流程） | **0 error / 0 warning** |
| 网络（250 个请求） | 全部 200，无 4xx |
| 性能 trace / CLS | CLS **0.0166**（Good 阈值 ≤0.1），无根因可优化 |

---

## 5. 仅报告、未改（需要人决策）

1. **三张休眠表**：`thread_projection` / `kap_cursors` / `session_cursors` 全仓零读者零写者。
   删要开新迁移（迁移只追加），故未动。
2. **`LinkState` 整条链是死的**：`Event` 里没有 link 事件，`SessionEvent::Link`/`note_link`
   永不执行。要接必须先给桥加一帧 —— 在那之前它看起来可用但是空转。
3. **`book.rs` 的 `ids()`/`current_prompt()`、`session/mod.rs` 的 `SessionEntry`** 零调用方。
4. **`automation-runtime/src/scheduler.rs:74`**：取消后 `select!` 仍会多跑一次完整
   `schedule()` 对账，与"先停收活"的顺序不一致。
5. **`#publish` 子代理帧会唤醒主频道订阅者**（`transcript-store.ts:838`）：每条子代理帧都重建
   该对话主频道快照并通知主频道订阅者。要动 `#held` 的读写语义，测试面较大。
6. **`setTheme` 首帧前 81–123 ms**（`mount.tsx:112` 会等它）：主进程创建窗口时已经落定过
   同一档主题（ADR 0012/0007 的三层同步），这 80+ ms 大部分在重复问一件已经知道的事。
   改它要重新论证运行期切换的语义，不是审计能顺手做的位移。
7. **`projectTranscript` 的 `sealedCache`/`outlineCache` 是模块级单点**：多会话交替投影会让
   引用稳定化互相打断（只影响 memo 命中率，不影响正确性）。
8. **打包链路（electron-builder / NSIS）与自动更新实际下载**：需要签名与真实发布渠道，
   本机不可复现，**未验**。
9. **`element-picker-runtime.ts` 在真实外站页面上的拾取行为**：需要真站点手动拾取，
   本轮只做了静态阅读与宿主侧测试，**未验**。
10. **`.audit/` 下三个分报告**（conversation.md / desktop.md / rust.md）保留了各自更细的
    证据与推理链，本文件是汇总。
