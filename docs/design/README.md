# 设计决策记录

一篇记录一个**已经拍板**的设计规则。它不是方案、不是讨论稿；讨论过程留在
`docs/refactor-log.md` 的待决问题里，结论落在这里。

## 什么时候写

- 新增一条视觉规则（字号、间距、圆角、颜色角色、组件行为）。
- 改变 design-system 组件的公开 API 或语义。
- 批准一个例外（业务耦合、第三方控件、暂时不迁移的存量）。
- 解决两个组件/两种写法的角色冲突。

## 模板

```markdown
# 标题

## 背景

出现了什么问题；为什么现有规则不够用。只写事实与现象，不写方案。

## 规范

可执行的规则，逐条编号。写「必须 / 不得 / 优先」，不写「建议尽量」。

## 实现位置

涉及的源码文件与入口；数值指向 tokens，不抄第二份。

## 影响面

哪些功能、页面、组件会受影响。

## 验收

怎么证明规则被遵守：测试、闸门、人工检查点。
```

## 索引

| 记录                                                 | 内容                                       |
| ---------------------------------------------------- | ------------------------------------------ |
| [control-surface-roles.md](control-surface-roles.md) | 分段控件 / 视图切换 / 页签三种角色         |
| [overlay-registration.md](overlay-registration.md)   | 浮层必须登记，作用域变量挂在 Portal 内容根 |
| [feature-css-boundary.md](feature-css-boundary.md)   | 功能 CSS 只做布局；颜色与主题分支进令牌    |
| [settings-primitives.md](settings-primitives.md)     | 设置页只用 Settings 原语与 DS 控件         |
| [ui-asset-map.md](ui-asset-map.md)                   | 控件与富界面的归属表、当前缺口             |
