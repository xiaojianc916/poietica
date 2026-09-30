# omp 模型接入层（pi-ai + pi-catalog）

> 来源：`PI_AI/src`、`PI_CAT/src`（18.3.0）；provider 唯一事实源是 pi-catalog 的 KDL 规则树。

## 1. 三层注册体系

- **传输 API（15 个 `KnownApi`）**（`PI_AI/src/providers/register-builtins.ts` + `PI_CAT/src/types.ts`）：`openai-completions`、`openai-responses`、`openrouter`、`openai-codex-responses`、`azure-openai-responses`、`anthropic-messages`、`bedrock-converse-stream`、`google-generative-ai`、`google-gemini-cli`、`google-vertex`、`ollama-chat`、`cursor-agent`、`gitlab-duo-agent`、`devin-agent`、`apple-foundation-models`。自定义 API 扩展点 `registerCustomApi()`（内置名保留不可覆盖）。
- **Catalog provider（82 个 `KnownProvider`）**：由 `PI_CAT/src/compat/rules/providers/<id>.kdl`（声明 default-model 的条目）生成，编译进 `rules.json`；运行时工厂表 `provider-models/descriptors.ts`。
- **Auth provider（91 份 auth KDL 契约）**：`PI_CAT/src/compat/rules/auth/<id>.kdl`；`PI_AI/src/registry/build.ts` → `registry.ts` 投影为 `ProviderDefinition`。
- **内置模型目录**：`PI_CAT/src/models.json`（生成物勿手编）——73 个 provider、**5510 个模型**，字段含 pricing、contextWindow/maxTokens、thinking、identity（class/family/revision）、compat（90+ 字段）、tokenizer（claude-v3/v47/v5/v5-sonnet、qwen3、deepseek-v3、kimi-k2、glm5 共 8 族）、webSearch、remoteCompaction、accountAccess。更新：`bun run gen:models`；一致性测试 `compat-compile/compat-parity` 证明引擎复现 models.json 全部值。

## 2. Provider 全清单（id | API | 鉴权）

### 2.1 第一方 / 大厂

| provider id | API | 鉴权 |
|---|---|---|
| `openai` | openai-responses（kindApis：embeddings/transcriptions/images） | `OPENAI_API_KEY`（env only） |
| `anthropic` | anthropic-messages | OAuth PKCE（Claude Pro/Max）或 `ANTHROPIC_API_KEY`；foundry hook（`ANTHROPIC_OAUTH_TOKEN` 优先 / `ANTHROPIC_FOUNDRY_API_KEY`） |
| `openai-codex` | openai-codex-responses（ChatGPT Plus/Pro） | OAuth PKCE 固定端口 1455 + `OPENAI_CODEX_OAUTH_TOKEN` |
| `openai-codex-device` | headless/device 变体 | OAuth custom（store-as openai-codex） |
| `google` | google-generative-ai | `GEMINI_API_KEY` |
| `google-vertex` | google-vertex（同 host 挂 anthropic/openai 行） | ADC（gcloud application-default / `GOOGLE_APPLICATION_CREDENTIALS`） |
| `google-gemini-cli` | google-gemini-cli | OAuth 端口 8085 |
| `google-antigravity` | google-gemini-cli 传输（Gemini 3/Claude/GPT-OSS） | OAuth 端口 51121 |
| `amazon-bedrock` | bedrock-converse-stream | AWS 凭据链；guardrailIdentifier/requestMetadata |
| `bedrock-mantle` | openai-responses | `AWS_BEARER_TOKEN_BEDROCK`（allows-missing-api-key） |
| `azure` | azure-openai-responses | `AZURE_OPENAI_API_KEY` |
| `apple` | apple-foundation-models（本机） | none |
| `mistral` | openai-completions | `MISTRAL_API_KEY` |
| `minimax` / `minimax-cn` | anthropic-messages | `MINIMAX_API_KEY` |
| `minimax-code(-cn)` | openai-completions | `MINIMAX_CODE(_CN)_API_KEY`（api-key login） |
| `moonshot` | openai-completions | `MOONSHOT_API_KEY` / `KIMI_API_KEY` |
| `kimi-code` | openai-completions（openai/anthropic 双格式） | device-code login |
| `deepseek` | openai-completions | `DEEPSEEK_API_KEY`（api-key login） |
| `xai` | openai-responses（kindApis image=xai-images, tts=xai-tts） | `XAI_API_KEY`（api-key login） |
| `xai-oauth` | openai-responses | device-code（SuperGrok / X Premium+） |
| `meta` | openai-responses | `MODEL_API_KEY`/`META_API_KEY` |
| `muse-code` | openai-responses | device-code |
| `stepfun` | openai-completions | `STEPFUN_API_KEY` |
| `qwen-portal` | openai-completions | `QWEN_OAUTH_TOKEN` / `QWEN_PORTAL_API_KEY` |
| `alibaba-coding-plan` | openai-completions | custom login hook |
| `alibaba-token-plan` | openai-completions（QwenCloud Token Plan） | custom hook（区域选择 + 可选 Cookie） |
| `xiaomi`（MiMo） | openai-completions | custom hook + `XIAOMI_API_KEY` |
| `xiaomi-token-plan-{sgp,ams,cn}` | openai-completions | 各自 env key |
| `zai` | anthropic-messages 主 + openai-completions | `ZAI_API_KEY`（api-key login）；`zai-coding-plan` OAuth（store-as zai） |
| `zhipu-coding-plan` | openai-completions | `ZHIPU_API_KEY` |
| `qianfan` | openai-completions | `QIANFAN_API_KEY` |

### 2.2 聚合网关 / 换商

`openrouter`（伪 API：默认 Responses，`PI_OPENROUTER_RESPONSES=0` 切 completions；kindApis embedding/image/rerank/video/tts/stt；OAuth PKCE 54549 或 key）、`vercel-ai-gateway`（`AI_GATEWAY_API_KEY`）、`cloudflare-ai-gateway`（多路由）、`litellm`、`kilo`、`zenmux`、`aimlapi`、`nanogpt`、`opencode-zen`、`opencode-go`、`yolo-auto`、`umans`、`commandcode`、`charm-hyper`、`firepass`、`cline-pass`、`wafer-serverless`、`coreweave`。

### 2.3 推理托管 / 开源 / 本地

`groq`、`cerebras`、`together`、`fireworks`、`deepinfra`、`novita`、`nvidia`、`huggingface`、`baseten`、`gmi-cloud`、`siliconflow(-cn)`、`venice`、`synthetic`（openai/anthropic 双格式）、`sakana`、`abliteration`、`aiand`、`singularityapi-dev/-tech`、`ollama`（openai-completions，allow-unauthenticated）、`ollama-cloud`（原生 ollama-chat）、`lm-studio`、`llama.cpp`（wire-compat-only）、`vllm`、`local`（local-inference，none）。

### 2.4 Agent 协议 / 特殊

`cursor`（cursor-agent：HTTP/2 + protobuf）、`devin`（OAuth 59653）、`github-copilot`（openai/anthropic 多路由 + premiumRequests 计量；OAuth device/PKCE 混合）、`gitlab-duo`（OAuth 8080）、`gitlab-duo-agent`（Workflow WebSocket 桥）、`typesafe`（System One judgments）、`stencil`（invite-only OAuth 54547）、搜索凭据类 `perplexity/tavily/kagi/exa/parallel`（api-key/custom login）、`web`（web-search grounding，免鉴权）。

`/login` 名单顺序由 `PI_CAT/src/compat/rules/auth/_order.kdl` 的 `login-order` 节点固定（约 96 id；无 login 流的按字母序排后）。

## 3. 能力矩阵

- **Streaming**：统一 `AssistantMessageEventStream`；共享看门狗 `streamFirstEventTimeoutMs`（默认 100s，env `PI_STREAM_FIRST_EVENT_TIMEOUT_MS`）与 `streamIdleTimeoutMs`（默认 120s；Anthropic/Bedrock 无 keepalive 主机 300s；别名 `PI_OPENAI_STREAM_IDLE_TIMEOUT_MS`）；compat 按模型下钻（GLM coding-plan、DeepSeek reasoning 有内建 floor）；`start` 合成事件不计为首个真实事件；Cursor 本地工具执行期间看门狗让位（`hasPendingLocalWork`）。
- **Thinking**：用户侧 6 档 `Effort`：minimal/low/medium/high/xhigh/max（`PI_CAT/src/effort.ts`）；5 种 wire 编码 `ThinkingControlMode`：
  - `effort`：OpenAI `reasoning_effort` / Responses `reasoning.effort`（`reasoningEffortMap`、`reasoningDisableMode` 9 种禁用编码：omit、lowest-effort、none-effort、openrouter-enabled-false、cline-enabled-false、venice-disable-thinking、zai-thinking-disabled、qwen-enable-thinking-false、qwen-template-false）；
  - `budget`：`thinkingBudget` tokens（Google budgetTokens / Bedrock budget）；per-effort 预算表 `ANTHROPIC_THINKING`/`GOOGLE_THINKING`/`BEDROCK_CLAUDE_THINKING`（Anthropic low=4096, high=16384, max=32768）；
  - `google-level`：`thinkingLevel: MINIMAL/LOW/MEDIUM/HIGH`；
  - `anthropic-adaptive`：`thinking:{type:"adaptive"}` + `output_config.effort`（低档 clamp，无 minimal）；
  - `anthropic-budget-effort`：`{type:"enabled", budget_tokens}`。
  附加：`effortMap`（wire 值重映射）、`effortRouting`（折叠变体按 effort 路由不同 wire id，如 Cursor `-low/-high`、Devin）、`suppressWhenOff`、`requiresEffort`、`thinkingBudgets` 覆盖、`disableReasoning`、`hideThinkingSummary`、`prefixBinding`；折叠变体（`-thinking`/`-low` 后缀塌缩）在 `PI_CAT/src/compat/collapse.ts`。
- **图片**：`input: ("text"|"image")[]`；非视觉模型 `vision-guard.ts` 分区占位 `[image omitted: model does not support vision]`；compat `stripImageInput`；`imageInputDecoder: "stb"`（本地后端拒 WebP；`OMP_NO_WEBP`）；工具结果图片可提升至兄弟 user 块（`requiresToolResultImageHoisting`）。
- **工具调用**：ToolChoice 跨 API 映射；compat：strict 模式、`toolSchemaFlavor`（moonshot-mfjs/grammar/none）、forced-tool-choice 与 reasoning 互斥降级、parallel tool calls、Mistral tool-id 归一化、OpenAI 40 字符 tool-call id 限制；OpenAI Responses 原生 computer-use 工具（`supportsComputerUse`）与 `apply_patch` freeform 变体；Cursor 本地 exec/MCP 桥（execHandlers）。
- **Prompt caching**：Anthropic `cache_control` ephemeral + `cacheRetention: none/short/long`（5m/1h）+ usage `cttl{ephemeral5m, ephemeral1h}` + **cache keep-warm**（`AnthropicCacheRefreshState`：5min TTL 提前 15s 刷新、上限 3 次、thinking 关闭时 `max_tokens:0` 重放）；OpenAI `promptCacheKey`（+ `x-grok-conv-id` session header）+ 显式 `prompt_cache_breakpoint`（30m TTL）+ `supportsLongPromptCacheRetention`（24h）+ Vercel `caching:"auto"`；Google 显式 `cachedContent`；Bedrock `promptCacheMode: none/automatic/explicit` + `cachePoint {type:"default", ttl:"5m"|"1h"}` + 最小 token/最大 checkpoint compat。
- **PDF**：统一内容模型只有 text/image 两种输入——pi-ai 统一接口无一等 PDF 输入类型（vendored OpenAI wire schema 文档注释提及 File inputs；实际 PDF 处理在 read/markit 层）。
- **多模态生成**：`generateImage()` 六传输（openai-images、openrouter-images、google-generative-ai、google-gemini-cli、openai-responses、openai-codex-responses）；TTS `openai-speech`/`xai-tts`；STT `openai-transcriptions`；Rerank `openrouter-rerank`；Video `openrouter-video`；judgment/typesafe。模型 kind：chat/tiny/image/tts/stt/search/judge/embedding/rerank/video。
- **WebSocket**：`preferWebsockets`（Model 与 SimpleStreamOptions 双侧）；OpenAI Codex WS transport（SSE 失败降级重试 `codexSseMaxAttempts`；WS 帧合成 SSE 形状）；GitLab Duo Workflow WS 动作桥；codex websocket 由 auth-gateway 统一处理。
- **Web 搜索 grounding**：`WebSearchGrounding = "gemini"|"anthropic"|"codex"|"xai"|"openrouter"`；usage 计 `server.webSearch/webFetch`。
- **Embedding**：`embed()` 仅 `openai-embeddings` 传输（openai、openrouter 目录行）。

## 4. 请求管线

分层（`PI_AI/src/stream.ts`）：
`stream()`：`resolveHeaders` → glyph codec（私有用 glyph 可逆 ASCII tokenization）→ thinking-loop guard → **provider in-flight 限额**（跨进程文件锁租约，心跳 5s/陈旧 30s；`providers.maxInFlightRequests` per-provider）→ `streamDispatch()`（custom API → gitlab-duo/kimi-code/synthetic 专用 handler → Vertex/Bedrock 原生鉴权 → providerDefinition.prepareModel/prepareRequest → per-API switch）。
`streamSimple()`：apiKey resolver 包装 → Anthropic cache-refresh 包装 → `stream()`。`complete()/completeSimple()` 再套 thinking-loop 重试（3 次，500ms→8s 退避）。
流出站统一过 **leaked-thinking healing**（非官方端点 `wrapLeakedThinkingStream`；官方 Anthropic/OpenAI/Codex host 免除——严格 URL/hostname 判定防 `api.openai.com.evil` 仿冒）。

### 重试层级（各层职责分离）
1. **Provider 级 transient**：`PROVIDER_MAX_RETRIES=10`；初始 0.5s 指数 2^n、上限 8s、25% 下抖动；仅首 token 前且未流出 replay-unsafe 内容；尊重 `retry-after(-ms)`；`maxRetryDelayMs` 默认 60s。可重试：408/429/5xx、socket 异常关闭、TLS bad record mac、流解析/中断；**usage/quota 明确排除**（归轮换层）。
2. **空响应重放**：`MAX_EMPTY_COMPLETION_RETRIES=2`、base 500ms；replay-safe 缓冲（首个 text/thinking/toolcall-delta 提交前可安全丢弃重发）。
3. **Oneshot 重试**：默认 3、base 500ms、单次上限 30s、纯退避天花板 8s、75–100% 抖动；尊重 header/文本 retry 提示（含 Z.ai/Zhipu 北京时区 reset 解析）；ContextOverflow/PayloadRejected/ContentBlocked 不重试。
4. **Auth a/b/c**：`AUTH_RETRY_MAX_ATTEMPTS=64`；普通 401 → 同账号强制刷新一次 → 换 sibling；403/usage-limit/账号策略 → 直接 sibling 轮换；typed token-refresh 错误仅重放一次。
5. 流看门狗超时 → `StreamTimeoutError` 本地 abort（`AbortSourceTracker` 区分 caller abort）。

### Usage / Cost（`PI_CAT/src/types.ts`）
`Usage`：input/output/cacheRead/cacheWrite/totalTokens + contextTokens、orchestration{}、premiumRequests（Copilot）、reasoningTokens、cttl{}（cache TTL 拆分）、server{webSearch, webFetch}、credits{cost, committedCost, acuCost}。
计价：`model.cost` 每百万 token 四费率；长上下文分档 `longContext{inputThreshold,…}`；时间分段 `timeBased{offPeakMultiplier, peakWindows}`（DeepSeek 峰谷、xAI SuperGrok 200K 档）；cache-write 按 TTL 拆分（1h 档 = 2× input 价）；`serviceTierCost`（flex/priority 乘数）。

### Stream 事件全集（`PI_AI/src/types.ts`）
`start`、`text_start/delta/end`、`thinking_start/delta/end`、`image_end`、`toolcall_start/delta/end`、`done`（reason: stop/length/toolUse）、`error`（aborted/error）。StopReason：`stop/length/toolUse/error/aborted`。诊断回调：`onPayload`、`onResponse`、`onSseEvent`。

## 5. pi-catalog 内部结构

- **KDL 规则树**（KDL v2，未知节点即编译错误；语法文档 `PI_CAT/src/compat/rules/README.md`）：
  - `taxonomy/*.kdl`：模型身份（class/family/revision/override/collapse/discovery）；
  - `classes/*.kdl`：20 个模型家族行为真值（anthropic/openai/gemini/glm/kimi/qwen/gpt-oss/minimax/…）；
  - `providers/*.kdl`：82 个 provider（default-model、env、discovery 接线、seed 行、部署契约）+ 专项（native-tools、output-limits、tool-free-history）；
  - `auth/*.kdl`：91 份鉴权契约；
  - `runtime/behavior.kdl`：responses 路由启发、api-routes、quota-tiers、model-limits、plan-requirement、pricing-peer、retry-reset-timezone。
  编译 `bun run gen:compat` → `src/compat/rules.json`（含 content-hash 缓存失效）。
- **运行时**：`model-manager.ts`（createModelManager；刷新策略 online/offline/online-if-uncached，缓存 TTL 2h，非权威 5min 重试；来源 bundled/cache/models.dev/provider）；`model-cache.ts`（SQLite models.db，schema v13，materialization-policy 哈希失效）；`discovery/`（openai-compatible、gemini、gemini-cli、codex、cursor、antigravity、gitlab-duo-workflow、typesafe、protobuf）；`identity/`（引用解析、方言、优先级、tokenizer 族）；`hosts.ts`（KNOWN_HOSTS URL 子串分类）。
- **动态发现**：provider 端点支持 `dynamic-models-authoritative`（动态目录整体取代静态行）；models.dev 作 fallback hook；seed 行 bundle 策略 always/fallback/empty。

## 6. OAuth 机制

- 4 种 login kind（`PI_AI/src/registry/engine/{oauth-code,device-code,api-key,refresh}.ts` 解释 KDL）：
  - **oauth-code**（授权码 + 可选 PKCE）：`generatePKCE()` 96 字节 verifier + SHA-256 challenge；`OAuthCallbackFlow` 本地回环回调 server（默认 300s 超时、端口回退、native-scheme 支持）；token 交换、credential 投影（dot-path/JWT claim）、userinfo 增强、after-exchange hook。固定端口：openai-codex 1455（禁端口回退）、anthropic 54545、openrouter 54549、devin 59653、google-antigravity 51121、google-gemini-cli 8085、gitlab-duo 8080、stencil 54547；无端口 paste-code：zai-coding-plan、gitlab-duo-agent。
  - **device-code**（RFC 8628）：kimi-code、muse-code、xai-oauth。
  - **custom hook**：github-copilot、cursor、perplexity、cloudflare-ai-gateway、kilo、xiaomi、alibaba-coding-plan、alibaba-token-plan、openai-codex-device。
  - **api-key "login"**：约 55 个 provider 粘贴式，可选三种校验（chat-completions / anthropic-messages / models-endpoint）。
- token refresh：KDL `refresh{}` 节点声明式（默认复用 login token 请求）；`OAUTH_REFRESH_SKEW_MS` 提前刷新。
- 扩展可 `registerOAuthProvider()` 注入自定义 OAuth provider（`omp login` 会加载）。
- 细节例：Anthropic client-id base64 混淆存储、authorize `https://claude.ai/oauth/authorize`、scopes `org:create_api_key user:profile user:inference user:sessions:claude_code`；OpenAI Codex scopes `openid profile email offline_access api.connectors.read api.connectors.invoke`。
- 多组织：KDL `org-scoped-identity #true`（同邮箱多组织凭据/用量分离）、`oauth-token-env`（专用 OAuth bearer env）；Codex `accountAccess` 按 ChatGPT account id 记录 entitlement（多账号发现时路由 account-gated 模型）。

## 7. 多账号 / 凭据轮换

- **AuthStorage**（`PI_AI/src/auth-storage.ts`；SQLite agent 目录 `agent.db`，`auth/sqlite-credential-store.ts`）命名空间：credentials（行存储/变更事件）、keys（级联：runtime → config models.yml → OAuth → login key → env → stored key）、oauth（login/access/刷新/账号列表）、sessions（session→credential 粘性 pin，`session:sticky:` 前缀；warm pin 可被 reserve 排序淘汰）、usage、health（模型池健康 + 单凭据探测）、limits、resets、blocks。
- **usage-aware 排序**（`auth/rank.ts` + `usage/registry.ts`）：20 个内置 usage fetcher——claude、openai-codex、gemini-cli、antigravity、kimi、minimax-code、muse-code、zai、github-copilot、cursor、synthetic、xai-oauth、devin、charm-hyper、ollama、ollama-cloud、cline-pass、umans、opencode-go、alibaba-token-plan；`CredentialRankingStrategy`（planGate、primary/secondary 双窗口、scopeLimits/blockScope 按模型族隔离退避、healableBlockScopes 429 过期复位愈合、hasPriorityBoost、stickyWarmMs）。
- **轮换语义**（`auth/health.ts` LimitsApi.rotate + `auth-retry.ts` withAuth/withOAuthAccess）：usage-limit → `markReached` 临时 block（默认 60s，取 usage report 真实 reset；scope 化退避键 `provider\0scope`）；模型级授权拒绝（Codex ChatGPT account / Cursor plan）→ 仅 block 该模型；账号策略拒绝 → block 账号；硬 401 → 凭据 suspect + block；sticky 保留以便复位后自动回归；attempted bearer/credential 身份去重防循环。
- **auth-broker**（`PI_AI/src/auth-broker/`）：集中式凭据服务器（持有 refresh token，不出客户端；bearer allow-list）；REST `GET /v1/snapshot`（+SSE 增量）、`POST /v1/credentials/{refresh,disable,upload}`、`/v1/usage`（按 installId 归因的 ClientUsageReport）、`/v1/blocks`；后台 `AuthBrokerRefresher` 周期刷新；`omp auth-broker migrate --include-env` 迁移 env key。
- **auth-gateway**（`PI_AI/src/auth-gateway/`）：本地 HTTP 网关，接受外来 wire（`POST /v1/chat/completions`、`/v1/messages`、`/v1/responses`、`/v1/pi/stream`）+ 模态路由（images/speech/transcriptions/embeddings/rerank/video/systemone），内部走 `streamSimple()` 复用 broker 支撑的轮换与 usage ledger（`dispatch.ts`：broker-backed ApiKeyResolver、per-credential usage 记账、`invalidateCredentialMatching`）；`Model.transport="pi-native"` 可把单模型流式分发整体重定向到 gateway（容器化 robomp 场景）。

## 8. models.yml 完整格式（`CA/src/config/models-config.ts` + models-config-schema-bundle.ts）

文件：`~/.omp/agent/models.yml`（`models.yaml` 兼容读；legacy `models.json` 自动迁移）。

```yaml
providers:
  my-gateway:                      # 自定义 provider id（任意名）
    baseUrl: "https://gw.example.com/v1"   # 定义 models 时必填
    apiKey: "ANTHROPIC_API_KEY"    # env 名 / "!command ..."（shell 取值，缓存+30s 失败退避）/ 字面量
    api: "anthropic-messages"      # Api 枚举见下
    auth: "apiKey"                 # apiKey | none | oauth
    authHeader: false              # true → 自动派生 Authorization: Bearer
    headers: { X-Custom: "$VAR" }  # 值同样支持 env/!command
    transport: "pi-native"         # 可选：经 auth-gateway /v1/pi/stream
    disableStrictTools: false
    guardrailIdentifier: ""        # Bedrock Guardrail id/ARN + guardrailVersion + guardrailTrace
    requestMetadata: {}            # Bedrock invocation-log tags (max 16)
    remoteCompaction: { enabled, api, endpoint, model, v2StreamingEnabled, v2Endpoint, streamingEndpoint }
    discovery:                     # 动态模型发现
      type: "ollama"               # ollama | llama.cpp | lm-studio | openai-models-list | proxy | litellm | apple-foundation-models
      timeoutMs: 5000
      injectV1: true               # 仅 openai-models-list
    compat:                        # OpenAI/Bedrock 兼容位（约 45 个）
      supportsStore: false
      thinkingFormat: "openai"     # openai | openrouter | zai | qwen | qwen-chat-template
      reasoningEffortMap: { low: "low", high: "high" }
      whenThinking: { ... }        # thinking 开启时的覆盖层
      promptCacheMode: "explicit"  # Bedrock
    models:
      - id: "my-model"
        name: "My Model"
        api: "openai-completions"  # 可覆盖 provider 级；无则报错
        baseUrl: "..."
        reasoning: true
        thinking:
          mode: "effort"           # effort | budget | google-level | anthropic-adaptive | anthropic-budget-effort
          efforts: [minimal, low, medium, high]   # 或 legacy levels / minLevel+maxLevel
          defaultLevel: "medium"
          effortMap: { xhigh: "high" }
          supportsDisplay: true
          requiresEffort: false
        input: ["text", "image"]
        tokenizer: "claude-v5"     # claude-v3|v47|v5|v5-sonnet|qwen3|deepseek-v3|kimi-k2|glm5
        supportsTools: true
        cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 }
        premiumMultiplier: 1
        contextWindow: 200000
        maxContextWindow: 200000   # ≥ contextWindow
        maxTokens: 64000
        omitMaxOutputTokens: false
        preferWebsockets: false
        headers: {}
        contextPromotionTarget: ""
        compactionModel: ""
        remoteCompaction: { ... }
    modelOverrides:                # 对 bundled 模型的稀疏补丁
      gpt-5.4: { contextWindow: 1000000, cost: { ... } }
```

- **Api 枚举**：`openai-completions | openai-responses | openai-codex-responses | azure-openai-responses | anthropic-messages | bedrock-converse-stream | google-generative-ai | google-gemini-cli | google-vertex | openrouter-decisions | typesafe`。
- **校验**（`validateProviderConfiguration`）：定义 models 必须 baseUrl；apiKey 必填除非 `auth: none|oauth`；零 models 时至少给出 baseUrl/headers/compat/apiKey/auth:none/disableStrictTools/guardrailIdentifier/requestMetadata/remoteCompaction/modelOverrides/discovery 之一；provider 级 discovery（非 proxy）必须配 `api`；每个 model 必须能解析出 `api`。
- **useDefaults**：未指定字段继承 bundled 同 id 模型 reference（cost/input/contextWindow 128000/maxTokens 16384/reasoning false；`gpt-5.4` 特例 1M context）；显式 cost 永远覆盖目录价。
- **模型角色**（config.yml `modelRoles`，非 models.yml）：chat 10 角色 default/smol(Fast)/slow(Thinking)/vision/plan(Architect)/commit/tiny/memory/task(Subtask)/advisor + kind 5 角色 image/web/speech/dictation/judge（`CA/src/config/model-roles.ts`）；selector 前缀 `@role`（canonical）、`pi/role`（legacy）、`*`；角色值可单个模型或数组（role chain）。
- **fallback chains** 在 config.yml `retry.fallbackChains`（按 role / provider/model / provider/* / 前缀 wildcard；支持 `:low/:high/:max/:off` thinking 后缀）；未配置用内置 `CA/src/priority.json`。
- **多账号轮换**不在 models.yml——其 `apiKey` 注册为 config 层 key override（高于 stored credentials、低于 CLI `--api-key`）；轮换由 AuthStorage 完成（§7）。
- **热重载**：ModelRegistry 每次静态重载前比对 models.yml mtime，变了才重解析并同步清掉 config 层 apiKey override 再重灌（`model-registry.ts`）；discovery 缓存早于 config mtime 判 stale。
- **Path-scoped 条目**（settings 层）：`enabledModels/enabledProviders/disabledProviders` 数组条目可为 `{path|paths|pathPrefix|pathPrefixes: [...], values|items|models|providers: [...]}` 按 cwd 前缀展开。
