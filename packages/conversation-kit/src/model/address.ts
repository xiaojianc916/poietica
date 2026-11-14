/**
 * 对话是客户端给会话套的壳：协议只认会话号，这个名字这一侧起。模块零依赖，
 * 放在这里是为了断开 run.ts ↔ session.ts 的引用环，别再挪回去。
 */
export type ThreadId = string
