# poietica-conversation

**我是什么**：会话领域。准入、轮次生命周期、投递记账、投影，一条管线。

**我拥有什么**：ConversationEvent 这个封闭事件集、TurnState 状态机、
DeliveryState 迁移表、ThreadView 投影，以及 ports 里那两个端口的形状。

**谁允许调用我**：适配环（poietica-ledger）与组合根。

**我不许知道什么**：IO、运行时、协议类型、SQL、Tauri。需要外界的东西一律
是 ports 里的 trait。
