# 19. 分叉是协议动作，入口在每轮回复的操作区

日期：2026-08-12（修订）

## 状态

已接受。本修订取代初版的入口设计：初版把入口放在侧栏行菜单，而这个界面
预留的位置一直是每轮回复下的操作区（reply-actions 的第二颗按钮）。

## 背景

历史归 agent 所有（本程序不存对话内容），所以分叉只能是协议动作：ACP 的
session/fork 由 agent 带着完整上下文开出新会话，本地只复制一行索引。

上游的边界要说清楚：Kimi 引擎内部支持按轮分叉（ForkSessionPayload.turnIndex，
"Zero-based index of the user-visible turn to retain through. When omitted,
the complete session is copied"），但那条能力只通向它自家 VS Code 扩展的私有
桥；它的 ACP 门面调用 session.fork() 时不带任何参数，ACP 的 session/fork 请求
里也没有分叉点字段。经 ACP，分叉今天只有一种：整条。

## 决定

1. 入口只有一个：每轮回复下的操作区，复制按钮右边那颗。侧栏菜单不再有它。
2. 每轮都画按钮，只亮最后一轮：从最后一轮分叉恰好等于整条分叉，是今天经
   ACP 唯一成立的语义；中间轮禁用并写明「暂不支持从此轮分叉」。不在 IPC 上
   铺没有消费者的 turn 字段 —— 上游门面把分叉点带上那天，从 ReplyActionHost
   到 AgentForkThreadRequest 一条线加一个字段即可翻开。
3. 名字规则一处（thread-title.ts 的 forkNameOf）：源显示名加下一个序号，序号
   排在截断之后（'122345…(2)'），按 manual 落库 —— record_prompt 只在
   fallback 时改名，分叉行不会被下一句话重新命名。
4. 截断按显示宽度不按码元：Intl.Segmenter 分字素，UAX #11 宽字符记 2 列，上
   限 48 列（纯中文行为不变，英文容量翻倍）。像素级省略号仍归 CSS；侧栏行把
   结尾 (n) 钉在可见端。

## 后果

- agent 忙碌时分叉会被上游拒绝，失败落在会话列表的失败横幅上。
- 序号递增只对结尾是半角 (n) 的名字成立；其余名字一律从 (2) 起。
