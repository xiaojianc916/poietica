# @poietica/feature-files

右坞「文件」：浏览当前对话所在工作区的文件，并在右坞标签里只读预览（对标 Codex 的文件面板）。

- **文件树**（`files.tree`，进启动器，Ctrl+Shift+E）：懒加载的目录树，尊重 `.gitignore` 的筛选（`files.search`），被忽略的条目淡一档仍列出。
  树本身是 design-system 的 `FileTree`，与审查的变更树同一份（缩进、引导线、Material 文件图标一致）。
- **查看器**（`files.viewer`，标签组，只能由代码打开）：一个文件一个右坞标签 —— 图标是 `FileTypeMark`（项目内联的 Material Icon Theme），
  标题是文件名，悬停是相对路径；按对话分账（与子代理那一组同一规则）。正文用审查同一份行带（`wholeFile` + `DiffBody`），Markdown 可切到正文排版，
  图片走资源协议 `poietica-asset://workspace-file/…`（字节不进 RPC）。只读：「用默认应用打开」交给系统，可执行类型只给「在资源管理器中显示」。
- **正文里的文件链接**：design-system 的正文把本地路径（链接或行内代码）认成 `poietica-file:` 链接；conversation 经 `fileReferenceOpeners`
  贡献点交给这里，先由 Core `files.locate` 解析并校验在工作区之内（字面 + 解开符号链接两道关），再开标签（带行号）或在树里定位目录。

子入口：

| 入口 | 内容 |
|---|---|
| `contract` | `files.list` / `files.read` / `files.locate` / `files.search` / `files.watch`，通知 `files.changed`；`imageMimeOf`、`workspaceFileUrl` |
| `core` | 路径边界（`paths.ts`）、解码（`decode.ts`）、目录 / 读取 / 搜索（`service.ts`）、声明式监听（`watch.ts`） |
| `host` | 图片资源协议：每次经 Core `files.locate` 校验，只发图片，SVG 带 CSP sandbox |
| `ui` | 树模型、标签账、打开策略、两格面板 |

监听是声明式的：界面把「当前工作区 ∪ 有标签开着的工作区」作为全集交给 `files.watch`，Core 重启后在 `onCoreReady` 里重发。
