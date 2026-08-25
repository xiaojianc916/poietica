# 0029. 插话：steer 与排队条

## 决定

队列的唯一事实在 kap 的 prompts 队列。本机不留副本，只留一个投影：
`prompt.queued` 落一条 `queued_prompt` 条目，`prompt.steered` / `prompt.completed` /
`prompt.aborted` 就地把它标成已离队。发送键的 `queued` 态与输入框上方那条队列都
从这一个投影读，没有第二条路径。

反方向新增两条命令通路：`steer`（把排队的几句并进在跑的那一轮，不中断它）与
`abortPrompt`（撤掉一条排队的话，不动在跑的那一轮）。它们与 `cancel` 分野明确：
`cancel` 停的是轮次，这两条动的是队列。

## 为什么

在此之前，运行中再提交一句只是静默入队：界面上没有任何东西说它在等，也没有任何
办法把它并进这一轮或撤掉它。协议早就有 `prompts:steer` 与 `prompts/{id}:abort`，
缺的只是命令面与投影。

## 后果

- `packages/ipc/src/generated/` 由 `bun run ipc:generate` 重新生成，两侧不手写对齐。
- `ChatStatus` 多一格 `queued`；它由应用层从 RunStatus 与队列长度收敛而成。
- `turn.rs` 的会话寻址收进 `held_session` 一处，三条命令共用。
