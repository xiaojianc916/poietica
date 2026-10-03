# 工具字形映射

折叠行左侧那一枚图标画成什么，由本文件描述的那一套判据决定。

**正本在代码里，本文是它的说明与快照。** 唯一的权威实现是
[`packages/conversation/src/transcript/omp-tool-glyphs.ts`](../../packages/conversation/src/transcript/omp-tool-glyphs.ts)；
本文抄录的表若与之不符，以代码为准，并回来修本文。快照日期 2026-10-03。

## 1. 要解决的问题

折叠行原先只有 `ToolKind` 一条判据，十一档。十一档不够用，两个地方漏：

**其一，二十个工具挤在同一枚图标上。** 54 个真实工具名里有 20 个的 `ToolKind`
是 `other`（`ask` / `yield` / `checkpoint` / `tts` / `generate_image` / `wait` …），
旧映射把它们一律画成图层图标。屏幕上「等待后台结果」「合成语音」「生成图片」
长得一模一样。

**其二，`read` / `write` 是传输工具，名字不说明它在干什么。** omp 的
`XDEV_TRANSPORT_TOOLS` 恰好就是这两个：可挂载的工具全部收进
`write xd://<工具>`，一切内部资源全部经 `read <scheme>://…` 到达。

```
read skill://ponytail      装载技能          ← 名字只说 read
read src/app.ts            读一个文件        ← 名字也说 read
write xd://lsp             跑 LSP 诊断       ← 名字只说 write
write src/out.ts           写一个文件        ← 名字也说 write
```

同一个名字，两件事。**名字里没有这个信息，地址里有。**

## 2. 判据的形状

三层，自上而下第一个命中的说了算：

```
toolGlyphOf(name, scheme)

  ① scheme 为空，或 name 不是传输工具
        → GLYPHS[name] ?? 'plugin'            认名字；认不出 = 外来工具

  ② scheme 是「一份东西」（RESOURCE_SCHEMES）
        → GLYPHS[name] ?? 'read'              动词说了算（read / write）

  ③ 其余 scheme（scheme 本身就是那件事）
        → SCHEME_GLYPHS[scheme] ?? GLYPHS[name] ?? 'plugin'
```

**为什么 ① 要先判「不是传输工具」。** 地址只对传输工具有意义。
`bash` 调用的 `args` 里出现 `path` 不代表它在读那个路径；让 scheme 改写
非传输工具的字形，等于凭空发明语义。

**② 与 ③ 的分界是一条真实存在的性质**，不是审美：

- **「一种东西」（③）**：scheme 本身描述的就是那件事 —— `skill` 是技能、
  `xd` 是设备、`memory` 是记忆。读它还是写它都是这件事，字形相同。
- **「一份东西」（②）**：scheme 只说碰的是哪一类资源，没说在干什么 ——
  `local` 是本机文件、`ssh` 是远端文件、`vault` 是密钥库。**动词决定字形。**

这条分界的判据来自 omp 自己的 `ProtocolHandler.immutable`
（`CA/src/internal-urls/types.ts`）：`local` / `ssh` / `vault` / `history` 是
`immutable: false`（可写），`skill` / `rule` / `memory` / `artifact` / `omp` /
`security` / `xd` / `mcp` / `agent` / `proc` / `issue` / `pr` 是 `true`（只读）。

若不这样分，`write local://PLAN.md` 会画成书 —— 明明在写。

## 3. 数据从哪来

| 格子 | 来源 | 说明 |
| --- | --- | --- |
| `name` | 帧的 `name` | omp 自己报出的工具名，原样 |
| `scheme` | `details.meta.source.value` 优先，退回 `input.path` | 见下 |
| `invokedTool` | 视图的 `invokedTool`，退回帧的 `name` | 真正在跑的那一个 |

### scheme：优先信 omp 盖的章

`read` 走内部 URL 时，omp 会调 `OutputMetaBuilder.sourceInternal(url)`
（`CA/src/tools/output-meta.ts:360`），在产出里留下：

```json
"details": { "meta": { "source": { "type": "internal", "value": "skill://ponytail" } } }
```

**这是跑完之后的事实，比入参可靠**（omp 可能重定向或展开路径）。调用还在飞的
时候没有产出，退回入参 `args.path` 上的 scheme。

```ts
function schemeOf(tool, input, output) {
  if (tool !== 'read' && tool !== 'write') return ''
  const source = detailsOf(output)?.meta?.source
  if (source?.type === 'internal') return schemeFrom(source.value)
  return schemeFrom(input?.path)
}
```

实测覆盖（本机 1500+ 次真实调用）：`skill://` 5 次、`xd://` 5 次、
`agent://` 6 次、`omp://` 2 次、`memory://` 1 次、`https://` 13 次（落
`url` 型，不是 `internal`）。

### invokedTool：名字之外还要认「真正在跑的那一个」

`title` 与 `invokedTool` 平时同值，三处例外：

**① `write xd://<工具>` —— 委派。** omp 把可挂载工具收进 `write`，一次
`write xd://lsp` 其实是在跑 LSP。产出里有 `details.xdev.tool`，按被调的那个
工具画；否则永远显示成「写入 xd://lsp」。

```ts
invokedTool: tool              // lsp
headline: `xd://${tool} · ${invoked.headline}`
```

**② `eval` 调 browser / computer prelude。** 这两者不是顶层工具，是注入 eval
内核的作用域对象（omp 的 `CA/src/tools/browser.ts:192` 与 `CA/src/tools/computer.ts`；
`CA/` = pi-coding-agent 包根，下同）的 `createBrowserPrelude` /
`createComputerPrelude`。模型写 `browser.open(...)`，产出里留
`details.statusEvents = [{ op, detail }]`。

**这条在真实数据里是最大的一处错**：字面工具名 `browser` 在会话里出现
**0 次**，而 74 次浏览器动作全部是 `eval` + `statusEvents`，旧映射一律画成终端。

```ts
...(ops.length === 1 ? { invokedTool: ops[0] } : {})
```

只在恰好一个 prelude 时改写：一次 eval 里混着 `browser` 与 `computer` 时，
没有哪一枚图标能代表它，宁可退回 `eval`。

**③ `title` 不能被 `invokedTool` 取代。** 回放的历史会话里，调用号会退化成
工具名（桥取不到真号时写的就是 `ask`），`askIndexes` 靠
`item.title === toolCallId` 认领答复。所以：

- `title` = 帧上的名字，**身份**
- `invokedTool` = 真正在跑的，**字形**

两者混用会让「提问的答复折回发起它的那次调用」认错行。

### MCP：不猜边界，用 omp 给的那一对

MCP 工具名由 `createMCPToolName` 铸成（`CA/src/mcp/tool-bridge.ts:458`），它会剥掉重复的
服务器前缀、按 64 字符上限加哈希后缀 —— **名字里的下划线不是分隔符**：

```
mcp__chrome_devtools_list_pages
       └── server = "chrome-devtools"（自带下划线）
```

按下划线逐个拆会得到 `"chrome · devtools_list_pages"`，错。真答案在产出的
`details` 里（`{ serverName, mcpToolName }`），实测：

```json
"details": { "serverName": "chrome-devtools", "mcpToolName": "list_pages" }
```

拿到就用，拿不到**只报名字本身，不猜边界**（`mcp__chrome_devtools_list_pages`）。

## 4. 名字 → 字形

54 条，与 `omp-tool-view.ts` 的 `HANDLERS` 同一批名字（键集合完全一致，
有测试守着）。认不出的名字一律 `plugin`（unplug：从外面来的工具）。

| 字形 | 图标 | 名字 |
| --- | --- | --- |
| `bug` | `Bug` | debug, security_scan |
| `clock` | `RotateCwFadingClock` | wait |
| `code` | `SquareDashedBottomCode` | lsp |
| `computer` | `Computer` | browser, computer, puppeteer |
| `delegate` | `ScanSearch` | hub, task, vibe_kill, vibe_list, vibe_send, vibe_spawn, vibe_wait |
| `device` | `RotateCcwSquare` | propose, reject, report_issue, report_tool_issue, resolve |
| `execute` | `SquareTerminal` | bash, eval, js, notebook, python |
| `fetch` | `Globe` | fetch, web_search |
| `github` | `GithubMark`（品牌标记，实心） | checkpoint, github, rewind |
| `goal` | `Target` | goal |
| `image` | `Image` | generate_image |
| `learning` | `BrainCircuit` | learn |
| `memory` | `Brain` | memory_edit, recall, reflect, retain |
| `other` | `Layers` | context_notes, new_context, think |
| `plugin` | `Unplug` | 表外的一切（MCP、扩展、比我们新的 omp 工具） |
| `question` | `CircleQuestionMark` | ask |
| `read` | `BookOpenText` | read |
| `search` | `Search` | ast_grep, find, glob, grep, search |
| `skill` | `Zap` | manage_skill |
| `speech` | `Mic` | tts |
| `todo` | `ListTodo` | todo |
| `write` | `Pencil` | apply_patch, ast_edit, edit, write |
| `yield` | `CircleDotDashed` | yield |

字形共 23 档，类别（`ToolKind`）11 档。**两张表并存不是冗余**：类别管并组
（相邻同类合成一组）与兜底措辞，字形管画哪一枚图标，是两件事。

## 5. 地址 → 字形

### 直接表（12 条，scheme 本身就是那件事）

| scheme | 字形 | 为什么 |
| --- | --- | --- |
| `agent` | `delegate` | 子代理的产出 |
| `conflict` | `write` | 冲突改写 |
| `http` / `https` | `fetch` | 网络 |
| `issue` / `pr` | `github` | 品牌标记 |
| `mcp` | `plugin` | 外来工具 |
| `memory` | `memory` | 记忆 |
| `proc` | `execute` | 后台进程 |
| `security` | `bug` | 安全扫描产物 |
| `skill` | `skill` | 技能 |
| `xd` | `device` | 设备 |

### 资源表（7 条，动词决定字形）

`artifact`、`history`、`local`、`omp`、`rule`、`ssh`、`vault`
—— 读画 `read`（书），写画 `write`（铅笔）。

### 覆盖面

omp 的 `InternalUrlRouter` 注册 **16 个 scheme**（闭集），全部有落点：

```
omp agent artifact memory local vault skill rule
security mcp issue pr history proc ssh xd
```

另有 3 个虽未注册但 `read` 会遇到的：`conflict`（`conflict-detect.ts`）、
`http` / `https`（走 `url` 型 source，不是 internal）。

两张表**无重叠**（同一 scheme 不会既在直接表又在资源表），有测试守着。

表外的 scheme（宿主自注册的 `db://` 之类）退回名字：`SCHEME_GLYPHS[s] ??
GLYPHS[name] ?? 'plugin'` —— 退化到名字，而不是宣告它是外来工具，否则一次
`write` 会被说成插件。

## 6. 数据流

```
omp 帧 (name, input, output)
  │
  ├─ transcript-projector.toolFrameOf
  │    invokedTool ← view.invokedTool || frame.name
  │    scheme      ← view.scheme
  │    title       ← frame.name            （身份，不改）
  │
  └─ ToolGlyphIcon { name, scheme }
       └─ toolGlyphOf(name, scheme) → ToolGlyph
            └─ switch（单一分发点，default 走 never 穷尽检查）
```

三个调用点都把它传下去：

- `tool-call-card.tsx` —— 单条折叠行（三处布局）
- `tool-group-card.tsx` —— 组头取第一个成员的 `{ name, scheme }`

## 7. 测试守的契约

[`tool-glyph.test.tsx`](../../packages/conversation/src/__tests__/tool-glyph.test.tsx)，
60 条用例 / 74 处断言。守的是**表本身** —— 表错了屏幕上只能看出一枚不对的图标，
看不出是哪一行错的，所以逐条钉死：

1. 54 条名字 → 字形（含大小写不敏感）
2. 19 条传输工具 + scheme → 字形（覆盖两张表全部条目）
3. 没有地址时传输工具仍按名字给
4. 地址只改传输工具，别的工具名字说了算（`bash` + `skill` 仍是终端）
5. 表外 scheme 不把一次写入说成外来工具
6. 同一份资源，读与写画各自的动词（7 条资源 scheme × 读写）

## 8. 改这里的时候

**加一个工具名**：`GLYPHS` 加一行，`tool-glyph.test.tsx` 的名字表加一行。
若该工具在 `omp-tool-view.ts` 有 `HANDLERS` 条目，两处键集合必须仍然一致。

**omp 新增一个 scheme**：查 `CA/src/internal-urls/router.ts:49-65` 注册表，按下节判据归入
直接表或资源表。

**判断归哪张表**：只有一条判据 —— **这个 scheme 本身是不是「那件事」**。

- 是「那件事」→ 直接表（`skill` / `xd` / `memory` / `security` / `mcp` /
  `issue` / `pr` / `proc` / `agent`）
- 只是「一份东西」→ 资源表（`local` / `ssh` / `vault` / `rule` /
  `artifact` / `omp` / `history`）

`immutable` 是**佐证而非判据**：可写的四个（`local` / `ssh` / `vault` /
`history`）必然只是「一份东西」，所以必然在资源表；但反过来不成立 ——
`rule` / `artifact` / `omp` 只读，却仍是「一份东西」，也在资源表。

拿 `immutable` 当判据会归错：它回答「现在能不能写」，而字形要回答
「这是什么」。`write rule://` 若某天被允许，按「那件事」归类仍然正确，
按「能不能写」归类就会当场错位。

## 9. 已知的待定项

两处按语义选的映射，不是数据逼出来的，尚未定夺：

1. **`read agent://RustCrates` → `delegate`（子代理图标）。** 真实会话里这 6 次
   是读**子代理的产出全文**（"Reading full rust scout output"），不是派发子代理。
   画 ModelIcon 可能让人误读成正在派发。可改为书（"读一份产出"）。
2. **`ssh://` 是否要独立图标。** 目前与本地文件同形（都是书/铅笔）。
