# 0001. Unified failure coordinator

- Status: Accepted
- Date: 2026-07-24
- Scope: 完整的 renderer 失败架构（吸收旧 0005 的呈现层级与旧 0006 的功能降级）

## Decision

Poietica 使用一份 FailureIncident 模型和一个 FailureCoordinator。

FailureCoordinator 拥有：

- 可恢复操作失败；
- 功能降级；
- 文档隔离；
- 应用终局失败；
- 原生终局失败；
- 去重；
- 发生计数；
- 作用域解决；
- 订阅者通知。

Fatal runtime 只是一个 source adapter，不拥有状态。UI 组件是 coordinator 快照
的投影，不独立分类或存储失败。诊断信息在 incident 创建时生成一次。

## Invariants

- 第一个进入终局的 incident 保持为主要终局原因。
- 可恢复失败没有显式终局影响时不得升级为终局。
- 文档失败隔离在其文档作用域内。
- 功能降级在通知消失后仍持续；只有 owning integration 可以通过解决
  FailureCoordinator 里对应的 feature scope 来恢复它。
- 原生与 renderer 终局失败共用同一份 incident 与诊断模型。

## Presentation hierarchy

失败影响决定呈现范围：

- **可恢复失败** → 临时 toast。
- **功能降级** → 一次性临时通知，同时**owning 控件必须独立保留 disabled 或
  degraded 状态**（通知消失后仍不可用）。窗口最小化/最大化按钮走原生 disabled
  语义；关闭按钮即使 close-request 协调降级也保持可用。降级的呈现不用卡片、
  modal 或全局错误页——用克制的 disabled 不透明度加简短的原生 title。
- **文档终局** → 不用 toast 作为主要呈现。只把失败的文档编辑器替换成轻量的
  inline "不可用"状态；应用标题栏、tabs、侧边栏、其他文档保持可用。
- **应用终局与原生终局** → 统一的全窗口 fatal surface。

### Document isolation 的视觉规则

文档 unavailable 状态不是卡片、不是 dialog、不是全局错误页。

不得使用：大幅警告插图、卡片背景、抬升阴影、粗边框、全窗口遮罩、默认展开的
诊断栈。

使用：一枚克制的 20–24 px 图标、一行短标题、一行短作用域说明、轻量的文字
操作、一个不显眼的错误码。诊断信息按需拷贝，技术细节默认不在编辑器面里显示。

### 生命周期

关掉 toast 不解决文档隔离。文档隔离只在其 owning document session 从
workspace 里消失后才清除。

## Terminal presentation

React 与 pre-React 的终局渲染器共用一份纯 `TerminalFailureViewModel`。
ViewModel 拥有 title、description、summary、recovery 呈现、附加 incident
文本与格式化后的诊断。渲染器只拥有平台特定的元素创建、剪贴板状态与所选主
动作的执行。**两侧渲染器都不得自行分类失败影响或格式化诊断。**

## Removed parallel systems

- FailureRuntime（旧 0006 的事实源，已合并入 FailureCoordinator 的 feature
  scope）；
- FatalIncidentController；
- FatalIncident；
- 独立的 fatal state store；
- 独立的 non-terminal state store。
