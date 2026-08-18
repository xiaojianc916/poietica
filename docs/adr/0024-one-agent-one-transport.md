# 0024. 一家 agent，一条传输

Status: accepted
Supersedes: 0021, 0022, 0023

## 背景

0021 定下「未来形态是纯 DeepSeek agent」，0022 退成两条传输并存，0023 如实记下
SDK 那条线是 harness 能力的一个子集：停不了一轮、装载不了旧会话、删不掉也分叉
不了会话、没有会话级选择器、带图的一句话直接拒发。

产品要的是纯 Kimi Code。那条线因此既不是未来形态，也不再有第二家要接。

## 裁决

ACP 是唯一的 agent 传输，Kimi Code 是唯一的一家。deepseek-harness 那条线整条
删除：SDK 线协议的手写定型与驱动器、时间线上的那条方言、帧契约上的
harness_event、档案上的 transport、原生侧的传输枚举与按传输分路。

DeepSeek 作为模型厂商留在 provider 预设里（packages/agent-catalog/src/
provider-presets.ts）。那是 Kimi Code 自己的 provider 目录，与本条无关。

## 后果

- 通用层不再有传输判别式，dial 与 outfit 的分路一并消失。
- RunFrame 从七格收到六格，投影只剩 ACP 一种方言。
- 0023 记下的那些缺口不再是产品缺口：ACP 声明什么，握手就铸什么凭证。
- 要再接第二家，接的是 ACP 的第二个实现，不是第二条协议。
