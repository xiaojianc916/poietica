export function migrateEntrySkills(m) {
  const capabilities = 'packages/agent/src/session/agent-capability-store.ts'
  m.replace(capabilities, `  AgentCapabilityPort,\n  PermissionPosturePort,`, `  AgentCapabilityPort,\n  AgentSkill,\n  AgentSkillPort,\n  PermissionPosturePort,`)
  m.replace(capabilities, `  readonly controls: readonly SessionConfigControl[]\n  readonly failure: string | undefined`, `  readonly controls: readonly SessionConfigControl[]\n  readonly failure: string | undefined\n  readonly skills: readonly AgentSkill[]\n  readonly skillsFailure: string | undefined`)
  m.replace(capabilities, `const EMPTY: AgentControls = { controls: NO_CONTROLS, failure: undefined }`, `const EMPTY: AgentControls = {\n  controls: NO_CONTROLS,\n  failure: undefined,\n  skills: [],\n  skillsFailure: undefined,\n}`)
  m.replace(capabilities, `export interface AgentCapabilityOptions {\n  /** 批准方式`, `export interface AgentCapabilityOptions {\n  readonly skills?: AgentSkillPort | undefined\n  /** 批准方式`)
  m.replace(capabilities, `  readonly #posture: PermissionPosturePort | undefined`, `  readonly #posture: PermissionPosturePort | undefined\n\n  readonly #skills: AgentSkillPort | undefined`)
  m.replace(capabilities, `  #asked = false`, `  #asked = false\n\n  #skillsAsked = false`)
  m.replace(capabilities, `  constructor({ posture, report }: AgentCapabilityOptions = {}) {\n    this.#posture = posture`, `  constructor({ posture, report, skills }: AgentCapabilityOptions = {}) {\n    this.#posture = posture\n    this.#skills = skills`)
  m.replace(capabilities, `    this.#asked = false\n    this.#alignedTo = undefined`, `    this.#asked = false\n    this.#skillsAsked = false\n    this.#alignedTo = undefined`)
  m.replace(capabilities, `    this.#load()\n\n    return () => {`, `    this.#load()\n    this.#loadSkills()\n\n    return () => {`)
  m.replace(capabilities, `  refresh = (): void => {\n    this.#asked = false\n    this.#load()`, `  refresh = (): void => {\n    this.#asked = false\n    this.#skillsAsked = false\n    this.#load()\n    this.#loadSkills()`)
  m.replace(capabilities, `    this.#commit({ controls: table, failure: undefined })`, `    this.#commit({ ...this.#held, controls: table, failure: undefined })`)
  m.replace(capabilities, `  /* 读一次整张表。没有端口就没有产地；问过了就不再问 —— 重读走 refresh。 */\n  #load(): void {`, `  #loadSkills(): void {\n    const source = this.#skills\n    if (source === undefined || this.#skillsAsked) return\n    this.#skillsAsked = true\n    void source.list().then(\n      (skills) => {\n        if (this.#skills === source) {\n          this.#commit({ ...this.#held, skills, skillsFailure: undefined })\n        }\n      },\n      (cause: unknown) => {\n        this.#skillsAsked = false\n        this.#report?.readFailed(cause)\n        this.#commit({ ...this.#held, skillsFailure: describeFailure(cause) })\n      },\n    )\n  }\n\n  /* 读一次整张表。没有端口就没有产地；问过了就不再问 —— 重读走 refresh。 */\n  #load(): void {`)
  m.replace(capabilities, `    this.#commit({ controls: this.#held.controls, failure: describeFailure(cause) })`, `    this.#commit({ ...this.#held, failure: describeFailure(cause) })`)
  m.replace(capabilities, `    if (next.controls === this.#held.controls && next.failure === this.#held.failure) {`, `    if (\n      next.controls === this.#held.controls &&\n      next.failure === this.#held.failure &&\n      next.skills === this.#held.skills &&\n      next.skillsFailure === this.#held.skillsFailure\n    ) {`)

  m.replace('apps/desktop/src/shell/app-shell.tsx', `      new AgentCapabilityStore({\n        posture: runtime.agent.permissionPosture,`, `      new AgentCapabilityStore({\n        posture: runtime.agent.permissionPosture,\n        skills: runtime.agent.skills,`)

  const conversation = 'apps/desktop/src/workbench/conversation-surface.tsx'
  m.replace(conversation, `  const { controls: known, failure: knownFailure, retry, selectControl } = useAgentControls()`, `  const { controls: known, failure: knownFailure, retry, selectControl, skills: knownSkills } =\n    useAgentControls()`)
  m.replace(conversation, `      git={git}\n      identify={onIdentify}`, `      git={git}\n      globalSkills={knownSkills}\n      identify={onIdentify}`)

  const surface = 'packages/agent-ui/src/surface/assistant-surface.tsx'
  m.replace(surface, `  AgentSessionPort,\n  SessionConfigControl,`, `  AgentSessionPort,\n  AgentSkill,\n  SessionConfigControl,`)
  m.replace(surface, `  readonly usage?: SessionUsage | undefined`, `  readonly usage?: SessionUsage | undefined\n  readonly globalSkills?: readonly AgentSkill[] | undefined`)
  m.replace(surface, `  git,\n  identify,`, `  git,\n  globalSkills = [],\n  identify,`)
  m.replace(surface, `  const skills = useThreadSkills(endpoint)`, `  const skills = useThreadSkills(endpoint) ?? globalSkills`)
  m.replace(surface, `  const activateSkill = useSkillActivation(endpoint)`, `  const activate = useSkillActivation()\n  const activateSkill = useCallback(\n    (name: string, args: string) => {\n      if (endpoint !== null) {\n        activate(endpoint, name, args)\n        return\n      }\n      if (identify !== undefined) {\n        void identify().then((threadId) => {\n          if (threadId !== null) activate(threadId, name, args)\n        })\n      }\n    },\n    [activate, endpoint, identify],\n  )`)

  const context = 'packages/agent-ui/src/session/session-controls-context.ts'
  m.replace(context, `export function useSkillActivation(threadId: string | null): (name: string, args: string) => void {`, `export function useSkillActivation(): (threadId: string, name: string, args: string) => void {`)
  m.replace(context, `    (name: string, args: string) => {\n      if (store !== null && threadId !== null) {\n        store.activateSkill(threadId, name, args)\n      }\n    },\n    [store, threadId],`, `    (threadId: string, name: string, args: string) => {\n      store?.activateSkill(threadId, name, args)\n    },\n    [store],`)

  const sessionStore = 'packages/agent/src/session/session-controls-store.ts'
  m.replace(sessionStore, `    if (port === undefined || sessionId === undefined) {\n      return\n    }\n\n    void port.activate(sessionId, name, args).catch((reason: unknown) => {\n      this.#report?.changeFailed(reason)\n    })`, `    if (port === undefined || sessionId === undefined) {\n      const reason = new Error('技能激活前，会话还没有建立。')\n      this.#report?.changeFailed(reason)\n      this.#transcripts?.note(threadId, describeFailure(reason))\n      return\n    }\n\n    void port.activate(sessionId, name, args).catch((reason: unknown) => {\n      this.#report?.changeFailed(reason)\n      this.#transcripts?.note(threadId, describeFailure(reason))\n    })`)
}
