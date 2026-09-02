/*
 * 这个包的唯一出口。
 *
 * 这台软件只接一家 agent，所以这里交出的是那一家本身，不是一张按 id 定址的名单：
 * 「用哪一家」不是运行时状态，它在编译期就已经确定。
 */

export type { AgentDescriptor } from './agent-descriptor'
export type {
  AgentConfigOptionValue,
  AgentProfile,
  AgentProfileResolution,
} from './agent-profile'
export { parseAgentProfile, resolveAgentProfile } from './agent-profile'
export { kimiCode as agent } from './kimi/descriptor'
