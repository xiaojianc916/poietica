# 「每周」覆盖每一个星期

## Decision

`packages/automation` 的常见日程里，`weekly` 原本只有周一一种可能：`scheduleFor('weekly')` 写死
`dayOfWeek=1`，`CLOCK_CRON` 的日字段只认 `*`、`1-5`、`1`。识别端因此把 `0 16 * * 5` 判成
`custom`，`describeSchedule` 会把 crontab 原文糊到界面上。

现在日字段扩到 `[0-7]`，`CommonSchedule` 多一格 `weekday`（0 是周日，cron 的 7 折进 0），
`scheduleFor(kind, time, weekday = 1)` 多一个可选参数。编辑器在 `weekly` 时多一个星期日选择器。

顺带删掉 `AUTOMATION_CATEGORIES` 与 `AutomationCategory`：模板区不再分类，这两个导出没有消费者。

## Consequences

模板可以写「每周五 16:00」这类日程，界面显示人话而不是 crontab。

星期选择器不是可选项：`scheduleFor` 的默认值仍是周一，缺了它，用户在编辑器里改一次时间就会
把「周五」悄悄改成「周一」。

`weekly` 的语义由「每周一」变成「每周 X」，是包公开面的破坏性变更。`packages/automation` 目前
只有应用内的消费者，所以一次换干净，不留兼容层。
