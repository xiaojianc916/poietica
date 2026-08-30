/**
 * 一条对话的地址。
 *
 * 它是这一侧起的名字：协议只认会话号（KapSessionId），对话是客户端给会话套上
 * 的壳。两个地址各有归属，所以分开放 —— 这个模块谁也不依赖，于是谁都可以依赖
 * 它。此前它住在 run.ts 里，而 run.ts 要从 session.ts 取协议词汇，session.ts
 * 又要回头从 run.ts 取这个名字：import 图上因此有一个环。
 */
export type ThreadId = string
