# 0040. 运行来源、回复收尾与撤销锚点分别建模

## 状态

已接受。取代 ADR 0019 中按最后一轮决定分叉能力的判据。

## 决定

- 官方 transcript 是正文、来源和运行生命周期的唯一事实来源。
- projector 独占协议来源知识，产出用户发言或带来源标签的运行触发记录。
- TurnPage.run 缺席表示没有官方运行事实，不允许通过用户消息补推。
- presentation 按运行终态产生至多一组回复操作；用户消息仅用于问题导航。
- 撤销计数的单位为官方用户锚点，不是气泡、运行、帧或 promptIds 的数量。
- 只有完整已知后缀从撤销锚点开始时才提供计数；未知来源、标记和忙碌状态禁用分叉。
- UI 消费能力与禁用原因；原生按钮和 details 提供交互语义，不另建正文状态。
- 分叉能力投影不替代服务端的静止状态、压缩边界和 checkpoint 校验。

## 依据

- MoonshotAI/kimi-code: packages/transcript/src/model/turn.ts、model/frame.ts。
- MoonshotAI/kimi-code: packages/agent-core-v2/src/agent/contextMemory/conversationTime.ts。
- MoonshotAI/kimi-code: packages/agent-core-v2/src/agent/undo/undoService.ts。
- 长期回归：packages/conversation/src/transcript/transcript-projector.test.ts。
