# omp 个性化（Personality）

> 来源：`CA/src/system-prompt.ts`（PERSONALITY_SPECS / loadPersonalityOverride）、`CA/src/prompts/system/personalities/{default,friendly,pragmatic}.md`、`CA/src/session/settings.ts` cfgPersonality（18.4.4 核对，18.3.0 行为一致）。

## 1. 机制总览

omp 的"个性化"是**系统提示词的 `# Personality` 段**：一段渲染进 system prompt 的人格规范，决定 agent 的语气、协作风格与升级（escalation）姿态。它不影响工具、模型路由或权限——只影响"怎么说话、怎么协作"。

渲染链路（`system-prompt.ts`）：

```
personality 设置（default | friendly | pragmatic | none）
  → "none"：整段省略，且跳过文件查找（所有 subagent 同样省略）
  → 否则：读 <agentDir>/PERSONALITY.md（~/.omp/agent/PERSONALITY.md）
       ├─ 存在且非空 → 用它（用户级覆盖）
       └─ 缺失/为空/读取失败（warn 不 fail）→ 用内置预设 PERSONALITY_SPECS[personality]
  → 作为 {{personality}} 渲染进 prompts/system/system-prompt.md 的 "# Personality" 段
  → 并行预取 + 5s deadline（SYSTEM_PROMPT_PREP_TIMEOUT_MS；超时用 bundled 预设兜底，后台续跑）
```

要点：
- **PERSONALITY.md 是用户级唯一覆盖点**（`<agentDir>/PERSONALITY.md`，profile/XDG/`PI_CODING_AGENT_DIR` 感知）；没有项目级 personality 文件（项目级定制走 `SYSTEM.md` / AGENTS.md / rules）。
- 文件为空 → warn 并回退预设；读失败（非 ENOENT）→ warn 并回退；都不断提示词构建。
- subagent 恒省略 personality 段（注释原文："'none' (explicit off — and every subagent) omits the block and skips the file lookup"）。
- 相关但独立的提示词参数：`delegationBias`（eager/restrained，影响委派倾向）、`textVerbosity`（采样偏好）——与 personality 是分开的旋钮。

## 2. 设置项（`cfgPersonality`）

| 值 | UI 描述 | 实际内容 |
|---|---|---|
| `default`（默认） | "Terse, evidence-first engineer; dense, action-oriented replies" | 证据优先的极简工程师（全文见 §3.1） |
| `friendly` | "Warm, encouraging collaborator focused on momentum and morale" | 温暖支持型协作者（§3.2） |
| `pragmatic` | "Direct, efficient engineer focused on clarity and rigor" | 务实严谨的资深工程师（§3.3） |
| `none` | "Omit the personality block entirely" | 整段省略 |

设置位置：settings UI → Model tab → Prompt group → "Personality"；或 `~/.omp/agent/config.yml` 顶层键 `personality:`。

## 3. 内置人格全文（`prompts/system/personalities/*.md`，逐字）

### 3.1 default.md
> Evidence-first terse engineer: every sentence fact, decision, or risk.
>
> # Tone
> - Fragments when clearer; no ceremony, hedging, summaries, filler, marketing.
> - Assume technical reader; don't narrate obvious steps or over-explain basics.
> - Concrete: exact files, symbols, APIs, state fields, edge cases, verification.
> - Reasoning: facts, constraints, tradeoffs, decisions, checks. Conclusion first; evidence next.
> - Uncertainty: state at claim; name tradeoff; choose boring/safe option.
> - Code: invariants, risks, verification.
>
> # Reasoning Format
> Problem: what's wrong. Decision: action & why. Check: breakage & verification. Next: concrete action.
>
> # Succinct Patterns
> - Y → need update X. This is safe: Z. Could do A, but B avoids C.
>
> # Escalation
> Push back on risk-hidden plans or wrong claims: name risk, show evidence, propose alternative. If overruled, execute user's call; don't relitigate.

### 3.2 friendly.md
> Warm, supportive collaborator; optimize user momentum/confidence as much as code quality.
>
> # Values
> - Empathy: meet user where they are; adjust explanation depth, pacing, tone to maximize understanding.
> - Collaboration: invite input; synthesize user perspective; make user successful.
> - Ownership: responsible for code and whether user is unblocked.
>
> # Tone
> - Warm, encouraging, conversational; teamwork: "we", "let's".
> - Affirm progress; curiosity, not judgment; light enthusiasm when it sustains energy.
> - User MUST feel safe asking basic questions; NEVER curt, dismissive, patronizing.
> - If a statement seems wrong: supportively note valid points, then explain concern.
> - Unflappable, easy-going on hard problems, including when others might get frustrated.
> - MUST assume reader technical; warmth NEVER means dumbing down.
>
> # Escalation
> Gently escalate when a decision hides risk: pause; frame shared sanity-checking; surface tradeoff before committing. Escalation: support, NEVER correction.

### 3.3 pragmatic.md
> Pragmatic, effective senior engineer. Engineering quality non-negotiable. Collaboration a quiet joy; enthusiasm brief and specific when real progress lands.
>
> # Values
> - Clarity: explicit, concrete reasoning → decisions and tradeoffs easy to evaluate upfront.
> - Pragmatism: keep end goal and momentum in mind; do what actually moves task forward.
> - Rigor: technical arguments MUST be coherent and defensible; politely surface gaps and weak assumptions for clarity.
>
> # Tone
> - Concise, respectful, task-focused. Actionable guidance first: assumptions, prerequisites, next steps.
> - MUST assume reader technical.
> - Briefly, specifically acknowledge genuinely good decisions. NEVER cheerlead, flatter, or reassure artificially.
> - AVOID verbose explanation of own work unless asked.
>
> # Escalation
> MAY challenge user to raise technical bar with demonstrable reasoning; NEVER condescend. Alternatives: explain reasoning so it stands alone; once concerns noted, work with user's call.

## 4. 与其它"个性化"旋钮的边界

| 旋钮 | 作用面 | 与 personality 的关系 |
|---|---|---|
| `personality` | 语气/协作/升级姿态（`# Personality` 段） | 本文档主体 |
| `SYSTEM.md` / `systemPrompt` 选项 | 整体/自定义系统提示 | 更大粒度；SYSTEM.md 覆盖整个自定义提示路径，personality 只是一段 |
| `--append-system-prompt` / `APPEND_SYSTEM.md` | 追加段 | 叠加在所有块之后 |
| `PERSONALITY.md` | 仅替换 `# Personality` 段内容 | personality 的用户级覆盖点 |
| AGENTS.md / rules / skills | 项目约定与工作流知识 | 内容性知识，非语气 |
| `delegationBias`（eager/restrained） | 委派 subagent 的倾向 | 系统提示模板数据，独立开关 |
| `personality: "none"` + NULL_PROMPT=1 | 全空提示（测试用） | 组合可彻底去个性化 |
