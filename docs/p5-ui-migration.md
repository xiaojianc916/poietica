# P5 conversation UI 迁移清单（逐文件裁定）

> 用途：09 页 §4 的迁移审查清单落到这一份表上。**每个迁移单元都要过一遍**：
> ① 它在 legacy 里解决什么问题；② 新架构里这个问题还在不在；③ 在的话由谁承担；
> ④ 有没有只为 Kimi / Rust / ledger / native-bridge / 已删功能存在的概念。
> 结局只有三种：**迁移**（保留形状、换数据来源）、**重写**（形状沿用、内部按新架构重做）、**删除**。
>
> 数据来源的四处替换（全表通用，不再逐行重复）：
> - `@poietica/contract/conversation` → `ui/agent/dto.ts`（载荷形状照抄，来源换成 engine 端口 + conversation 契约）
> - `@poietica/external-store` → `ui/components/primitives/external-store.ts`（legacy 那份接口的逐字迁移）
> - `@poietica/problem` → 本地上报（吉祥物是装饰件）
> - `@poietica/review` → `ui/components/semantics/review-port.ts` + `unified-diff.ts`（conversation 不 import review；P6 经 toolCallRenderers 接真）

## 1. 已裁定：删除

| legacy | 判据 |
| --- | --- |
| `src/transcript/kimi-attachment.ts` | 07 页 §5F 明文「删除」。它把 Kimi 客户端塞进正文的 `<attachment>` 提示滤掉；新架构的 prompt 由 engine-omp 直接给，不存在这段文本。**已删**，两处调用点（transcript-projector.ts:195/1257）已还原成原文。 |
| `src/transcript/{transcript-store,transcript-replica,transcript-sink,subagent-projection}.ts` | 07 页 §5F：副本逻辑「以 07 页的 TimelineReplica 为准重写，legacy 只参考」。它们建立在 legacy transcript 包的 `TranscriptStore`/`AgentDescriptor` 上，而新 `@poietica/transcript` 明确不迁 store（05 页 §12.1）。**待删**（等 `ui/stores/transcripts.ts` 落地后一起删）。 |
| `src/transcript/{omp-tool-view,tool-vocabulary,omp-tool-glyphs,transcript-projector}.ts` | 依赖 omp 事件形状的部分已在 engine-omp 的投影器里（P2 完成）。这四件是**纯展示映射**（工具标题/字形/意图/帧→行），按 07 页 §5F 应落 `ui/components/timeline/tools/`。**待搬**（当前在 ui/transcript/，位置不对，但内容保留）。 |

## 2. 已裁定：迁移（形状不动，换来源）

| legacy | 新位置 | 了什么 |
| --- | --- | --- |
| `src/surface/**`（127 个文件，含 38 个 CSS） | `ui/components/**` | 相对深度不变 → 组件内部相对 import 一条没改 |
| `src/agent/{address,config,goal,link,permission,question,run,session,thread,tool-call,toolkit,transcript,usage,failure}.ts` | `ui/agent/*` | 类型层；四个 DTO 落 `agent/dto.ts` |
| `src/timeline/{timeline-contract,presentation,timeline-queries,ordered-lookup,renderable,delegate-channel}.ts` | `ui/timeline/*` | 时间线投影；数据换成新 transcript 的 `TimelineState`（**待接**） |
| `src/composer/{drafts,attachment,prompt}.ts` | `ui/composer/*` | 草稿与附件的小工具 |
| `src/threads/{thread-order,thread-title,workspace-root}.ts` | `ui/threads/*` | 列表次序与分组 |
| `src/interjection/message-queue.ts` | `ui/interjection/*` | 队列看法；数据换成 `QueueSnapshot`（**待接**） |
| `vendor/aora-bot/**` | `features/conversation/vendor/**` | 吉祥物运行时（第三方 JS，副作用导入） |

## 3. 待逐个复核：疑似过时（下一批决定）

这些在 legacy 里成立，但要在新架构里**先找到承担者**再决定去留：

| legacy | 疑点 | 待查 |
| --- | --- | --- |
| `surface/threads/assistant-thread-list.tsx` 的 share 分支、`onShare` / `sharing` props | 09 页已把 export/share 移出产品范围 | 去掉分享入口（DOM 与其余不动） |
| `surface/composer/auxiliary-composer.tsx` | 辅助输入框属于「副会话/派发通道」那一套 | 08 页删除语义表里没有它；P5 的 07 §5E 组件清单也没有 → 大概率删除 |
| `surface/composer/swarm-toggle.tsx` | 老的多 agent 编队开关 | engine 端口没有对应能力 → 删除 |
| `surface/minimap/**`、`surface/mascot/**` | 07 页 §5E 的组件清单没点名 | 与基准截图核对后再定（外观相关，不轻易删） |
| `surface/todo/todo-panel.tsx`、`surface/goal/goal-bar.tsx` | 待办与目标在新架构里由 transcript 的 `todos` 与 `meta.goal` 承担 | 保留，改数据来源 |
| `surface/media/image-lightbox.tsx` | 图片灯箱；P5 的图片只有 `attachment.upsert` 内联的 data URL 一条来源 | 保留（`timeline.media` 已随 `media(fileId)` 一起删除，见 refactor-log 的 Q28 裁决；灯箱吃的就是内联 URL） |
| `models-settings.tsx` 的「从目录添加」与 agent-CLI 安装 | 数据模型是原生侧 catalog wire（kimi/vertexai/google-genai + 装机流程），新契约只有三种自定义 API 形态 | **已删**，页面按 07 页 §6B/§6E 重做（已配置的模型 / 供应商手风琴 / 默认） |

## 4. 装配（已落地）

1. **转录 store**：legacy 的 `transcript-store.ts` 保留（副本、队列、待答、乐观提交都在里面），它依赖的上游 `TranscriptStore` 用新包的 `applyOps/stateFromPage/pageFromState` 就地替掉（05 页 §12.1 不迁那个 store）。
2. **会话端口** `ui/stores/session-port.ts`：把 legacy `AgentSessionPort` 落在 conversation 契约的六个命名空间上；三处语义映射（epoch 由本层记住、promptId ↔ clientTurnId、withdraw 撤队首）写在文件头注。
3. **组合根** `ui/composition.tsx`：`TranscriptsContext`/`ComposerDraftsContext`/`AgentControlsContext`/`SessionControlsContext`/`DelegateChannelContext`/`AttachmentIntakeContext` 全部接上；两个表面（home / thread）都经过它。
4. 待办：`AssistantThreadList` 的 share 分支尚未摘掉（09 页已把分享移出产品范围）。

## 5. 记入 refactor-log 的偏差

- conversation 侧留了一份 `unified-diff.ts`（逐字迁自 review）：07 页 §0.2 规定 conversation 不 import review，P5 的工具卡片要能画出改动。P6 的 review 经 `toolCallRenderers` 接真后，这一层退成兜底。
- `AgentSessionUsage.breakdown` 在 P5 恒为 null：legacy 的构成明细由原生侧算，新引擎端口没有对应报数，屏幕退成只画总条（与 legacy「这一份报数没带构成」时的画法一致）。
