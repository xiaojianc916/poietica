# Docs

```
docs/
├── architecture/   # 分层、依赖方向、原生边界、kap 客户端与数据布局
├── adr/            # 架构决策记录
├── rfcs/           # 提案（ADR 之前）
├── runbooks/       # 运维与发布流程
└── development/    # 本地开发环境准备
```

架构文档只做解释。可执行的事实来源是
`tools/architecture/rules.config.mjs`，由 `pnpm test:architecture` 强制执行；
两者冲突时以配置为准，并同步修正文档。
