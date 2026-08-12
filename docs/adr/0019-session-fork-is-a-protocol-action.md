# 19. 会话分叉是一个协议动作

日期：2026-08-12

## 状态

已接受

## 背景

对话内容归 agent 所有，本地库只是索引。「带着完整上下文另起一条对话」因此无法
在本地实现：本地没有历史可复制。ACP 为这件事提供了 UNSTABLE 的 session/fork
（RFD session-fork）：请求与 session/load 同参，答复与 session/new 同形，能力
由 agent 在 initialize 的 sessionCapabilities.fork 里声明。Kimi Code 的
acp-server 已实现并声明该能力；Codex 以 codex fork / /fork 提供同语义的用户
功能：分出新对话，源对话原样不动，人落在新分支里。

## 决定

- 分叉走 ACP session/fork，能力经握手协商（Handshake.can_fork_session），与
  装载、删除同一扇门。schema 的 unstable_session_fork 特性门在工作区依赖上
  打开；类型不存在与协议不支持都在编译期或握手期暴露，不做运行时猜测。
- 源会话必须原样变活（必要时 session/load，号不变），变不活就失败；分叉绝不
  改写源对话的持有关系，也绝不静默降级成新建空会话 —— 这正是
  addressing::session_for 的兜底对分叉不适用的原因。
- 新行由一条 INSERT … SELECT … RETURNING 落库：标题、来历、目录、轮数随行
  复制，号与主人成对（迁移 0012 的触发器），源不存在当场报错。
- 分叉答复不携带历史；打开分叉出的对话走 agent_open_thread → session/load
  重放。取历史只有一条管线。

## 后果

侧栏行菜单获得「分叉对话」，点击后新对话自动打开。agent 未声明能力或对话没有
可分叉的会话时，动作明确失败，不做本地模拟。
