# 用量页的两格真数：按模型的日账与句子数

## 背景

用量页的「消息数量」与「最常用模型」两格从落地起就是写死的 undefined（占位符
—），下面也只有热力图。要补上它们与「每日 Token 趋势图」，得先回答一个问题：
这两个数从哪来。

## 决定

- **句子数取准入账**：turn_admissions 每落一行就是用户发出去的一句话，插话也算
  （它同样过准入）。窗口按**时刻**切，不按日历格 —— 今天这一格还没过完，按格数
  等于少算半天。命令 usage_message_count(span)。
- **按模型的日账与合计同一次事务写**：token_model_days(day, model, tokens) 与
  token_days 并列，同一笔 token 进两张表，一张给合计、一张给趋势图。没带模型的
  那一笔只进合计 —— 编一个模型名比少画一条线更糟。命令 usage_model_days(span)。
- **模型名跟着用量报数走**：omp 的 session.model 在桥那一侧拼成 provider/id
  （与 selectors 那一格逐字相同），随 usage 帧上行，落进 token_model_days。
  这是**报表字段**，不是第二次统计：账本只按到达的那一份记，不自己反推模型。
- **趋势图不引图表库**：只有折线、网格、图例三样，用 SVG 自己画。装一个图表库换来的
  是它整套排版与主题，而这里要的是与设置页同一套语义色。

## 影响

- 迁移 0017 建 token_model_days；一条 shipped 的迁移永不修改。
- IPC 面新增只读命令 usage_model_days 与 usage_message_count。
- SessionUsageSnapshot / SessionUsage 各多一格 model：两处因此不再是 Copy。
- 按模型的账**从这次升级起**才有得记：升级前的 token 只有合计，趋势图因此画不出
  旧日子 —— 这是如实的缺席，不是 0。
- 存量 session_usage 行没有模型那一格，打开旧对话时趋势图不画它，等下一份报数。
