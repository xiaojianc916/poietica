# @oh-my-pi/pi-coding-agent 18.5.0 — exact SDK API reference

Extracted read-only from the shipped declarations and sources. `PKGROOT` = `node_modules/.bun/@oh-my-pi+pi-coding-agent@18.5.0+219b93cc7c15e9fb/node_modules/@oh-my-pi/pi-coding-agent`; `AIROOT` = `.../@oh-my-pi+pi-ai@18.5.0/node_modules/@oh-my-pi/pi-ai`; `UTILSROOT` = `.../@oh-my-pi+pi-utils@18.5.0/...`; `TUIROOT` = `.../@oh-my-pi+pi-tui@18.5.0/...`; `COREROOT` = `.../@oh-my-pi+pi-agent-core@18.5.0/...`.
Every `// from:` path is relative to PKGROOT unless the header names another root; `:N` / `:N-M` are line ranges in that file. JSDoc and blank lines are elided; wrapped signatures are joined onto one line with the text unchanged.
Export map: `.` -> `src/index.ts` (types `dist/types/index.d.ts`); `./*` -> `src/*.ts` (types `dist/types/*.d.ts`); explicit keys per top-level directory. **No `./cli` key** — `.../cli` resolves through `./*`. pi-utils / pi-tui / pi-ai resolve `worker-host`, `theme`, `overlays/*`, `providers/mock` through their own `./*` wildcards.

## A. Root export — '@oh-my-pi/pi-coding-agent'

### A.1 createAgentSession

```ts
// from: dist/types/sdk.d.ts:570
export declare function createAgentSession(options?: CreateAgentSessionOptions): Promise<CreateAgentSessionResult>;
```
```ts
// from: dist/types/sdk.d.ts:362-381
export interface CreateAgentSessionResult { session: AgentSession; extensionsResult: LoadExtensionsResult; setToolUIContext: (uiContext: ExtensionUIContext, hasUI: boolean) => void; mcpManager?: MCPManager; modelFallbackMessage?: string; lspServers?: LspStartupServerInfo[]; startBackgroundModelDiscovery?: () => Promise<void>; eventBus: EventBus; subagentEventBus?: EventBus; }
```
```ts
// from: dist/types/sdk.d.ts:36-360 (all fields, types verbatim)
export interface CreateAgentSessionOptions { cwd?: string; additionalDirectories?: string[]; agentDir?: string; spawns?: string; inheritedSessionAgents?: readonly AgentDefinition[]; authStorage?: AuthStorage; modelRegistry?: ModelRegistry; getApiKey?: AgentOptions["getApiKey"]; credentialSourceSessionId?: string; model?: Model; rebindModelAfterDiscovery?: boolean; deferRetryFallbackValidation?: boolean; modelPattern?: string | string[]; modelPatternAuthFallback?: string; modelPatternFallbackRole?: string; modelPatternDefaultFallbackChain?: string[]; thinkingLevel?: ConfiguredThinkingLevel; thinkingLevelCeiling?: Effort; openAIServiceTier?: ServiceTier | null; cacheWarming?: boolean; resolveServiceTierByFamily?: (model: Model | undefined) => ServiceTierByFamily; scopedModels?: Array<{ model: Model; thinkingLevel?: ThinkingLevel; }>; prewalk?: Prewalk; deferredPrewalk?: { target: string; patterns: string[]; }; onPrewalkWarning?: (warning: string) => void; planYolo?: PlanYolo; systemPrompt?: string | string[] | ((defaultPrompt: string[]) => string | string[]); systemPromptTemplate?: string; customSystemPrompt?: string; appendSystemPrompt?: string; titleSystemPrompt?: string; providerSessionId?: string; providerPromptCacheKey?: string; providerPromptCacheKeySource?: "explicit" | "fork"; deadline?: number; customTools?: (CustomTool | ToolDefinition)[]; extensions?: ExtensionFactory[]; additionalExtensionPaths?: string[]; disableExtensionDiscovery?: boolean; extensionRoots?: () => EffectiveExtensionRoots; preloadedExtensions?: LoadExtensionsResult; preloadedExtensionPaths?: string[]; preloadedPreparedExtensions?: readonly PreparedExtension[]; preloadedCustomToolPaths?: ToolPathWithSource[]; eventBus?: EventBus; subagentEventBus?: EventBus; skills?: Skill[]; rules?: Rule[]; contextFiles?: Array<{ path: string; content: string; }>; workspaceTree?: WorkspaceTree; promptTemplates?: PromptTemplate[]; slashCommands?: FileSlashCommand[]; enableMCP?: boolean; mcpManager?: MCPManager; enableLsp?: boolean; lspReadOnly?: boolean; enableIrc?: boolean; skipPythonPreflight?: boolean; toolNames?: string[]; restrictToolNames?: boolean; allowRestrictedCustomTools?: boolean; outputSchema?: unknown; outputSchemaMode?: StructuredSubagentSchemaMode; requireYieldTool?: boolean; bindProcessState?: boolean; taskDepth?: number; parentHindsightSessionState?: HindsightSessionState; parentMnemopiSessionState?: MnemopiSessionState; agentId?: string; agentDisplayName?: string; agentName?: string; agentRegistry?: AgentRegistry; expectedAgentRef?: AgentRef | null; parentTaskPrefix?: string; parentAgentId?: string; sessionManager?: SessionManager; localProtocolOptions?: LocalProtocolOptions; settings?: Settings; settingsManager?: Settings | Promise<Settings>; hasUI?: boolean; interactivePrompts?: boolean; settingsApproval?: boolean; deferUsageReserveConfirmation?: boolean; telemetry?: AgentTelemetryConfig; onFirstChatDispatch?: () => void; autoApprove?: boolean; }
```

Also exported by that file: `discoverExtensions:419`, `discoverSessionExtensionPaths:434`, `loadSessionExtensions:444`, `loadCliExtensionProviders:457`, `resolvePrewalkTarget:459`, `discoverContextFiles:478`, `discoverPromptTemplates:486`, `discoverSlashCommands:490`, `discoverCustomTSCommands:494`, `discoverMCPServers:499`, `buildSystemPrompt:525`, `customToolToDefinition:526`, `createAutoLearnCaptureRunner:538`, `resolveDialect:383`.

### A.2 Settings (class)

```ts
// from: dist/types/config/settings.d.ts:92-398 (members, verbatim; wrapped signatures joined)
 static init(options?: SettingsOptions): Promise<Settings>;
 static loadReadOnly(options?: SettingsOptions): Promise<Settings>;
 static loadIsolated(options?: SettingsOptions): Promise<Settings>;
 static isolated(overrides?: Readonly<Record<string, unknown>>, options?: { storage?: AgentStorage | null; }): Settings;
 overlay(overrides?: Readonly<Record<string, unknown>>): Settings;
 overlayLayers(): OverlayLayers;
 restoreOverlay(layers: OverlayLayers): Settings;
 static get instance(): Settings;
 static get current(): Promise<Settings> | null;
 rawValue(setting: AnySetting): unknown;
 isConfigured(setting: AnySetting): boolean;
 getProvenance(setting: AnySetting): SettingProvenance;
 writeValue(setting: AnySetting, value: unknown, layer: "global" | "override"): void;
 unsetGlobalValue(setting: AnySetting): void;
 writeEntry(setting: AnySetting, key: string, value: unknown): void;
 writeMember(setting: AnySetting, item: string, { member }: { member: boolean; }): void;
 pinDefaultValue(setting: AnySetting): void;
 clearOverrideValue(setting: AnySetting): void;
 onEffectiveChange(sources: readonly AnySetting[], listener: SettingChangeListener): () => void;
 flush(): Promise<void>;
 reloadFromDisk(): Promise<void>;
 reloadForCwd(cwd: string): Promise<void>;
 getStorage(): AgentStorage | null;
 getCwd(): string;
 getAgentDir(): string;
 getModelRole(role: ModelRole | string): string | undefined;
 getModelRoles(): ReadOnlyDict<string>;
```

```ts
// from: dist/types/config/settings.d.ts:19-46
export type SettingProvenance = "env" | "runtime" | "overlay" | "project" | "global" | "default";
export interface RawSettings { [key: string]: unknown; }
export interface SettingsOptions { cwd?: string; agentDir?: string; inMemory?: boolean; readOnly?: boolean; overrides?: Readonly<Record<string, unknown>>; configFiles?: string[]; }
interface OwnLayers { global: RawSettings; project: RawSettings; configOverlay: RawSettings; overrides: RawSettings; }
export type OverlayLayers = Readonly<Pick<OwnLayers, "global" | "overrides">>;
```

Also on the class: `cancelPendingSaves:225`, `startWatching:234`, `stopWatching:236`, `cloneForCwd:249`, `get revision:287`, `getGlobalSettings:297`, `getProjectSettings:304`, `getPlansDirectory:305`, `getShellConfig:309`, `extensionsSourceLevel:321`, `setModelRole:336`, `isProjectModelRoleRuntimeOverrideActive:344`, `setProjectModelRole:348`, `clearProjectModelRole:352`, `getGlobalModelRole:360`, `getProjectModelRole:364`, `getModelRoleProvenance:376`, `getModelRoleSource:380`, `getOwnedModelPreset:389`, `overrideModelRoles:397`. Module level: `SettingProvenance:19`, `OverlayLayers:46`, `withActiveSettings:407`, `isSettingsInitialized:408`, `findScopedSettings:417`, `settings:435`.

**The settings handle** behind get / set / override / unset / clearOverride / isConfigured / isCredential is the registry handle, not `Settings`:

```ts
// from: dist/types/config/registry.d.ts:224-344 (members, verbatim; wrapped signatures joined)
 get isCredential(): boolean;
 envValue(): T | undefined;
 get(scope: ScopeLike): T;
 layered(scope: ScopeLike): T;
 parse(text: string): T;
 accepts(value: unknown): boolean;
 set(scope: ScopeLike, value: T): void;
 override(scope: ScopeLike, value: T): void;
 unset(scope: ScopeLike): void;
 clearOverride(scope: ScopeLike): void;
 isConfigured(scope: ScopeLike): boolean;
 provenance(scope: ScopeLike): SettingProvenance;
```

```ts
// from: dist/types/config/registry.d.ts:334-344, :157, :340-342
export type AnySetting = Setting<unknown>;
export declare function register<const D extends SettingDefinition>(definition: D): Setting<DefinitionValue<D>, D["id"]>;
export declare function lookup(id: string): AnySetting | undefined;
export declare function all(): readonly AnySetting[];
export declare function register<const D extends SettingDefinition>(definition: D): Setting<DefinitionValue<D>, D["id"]>;
export declare function lookup(id: string): AnySetting | undefined;
```

`disableProvider` / `initializeWithSettings` live in the capability registry, re-exported verbatim by the discovery entry; they are NOT in `dist/types/config` and NOT re-exported by the package root (grep `discovery` over dist/types/index.d.ts: 0 matches). Import specifier: `@oh-my-pi/pi-coding-agent/capability` or `/discovery`.

```ts
// from: dist/types/capability/index.d.ts:37-67
export declare function initializeWithSettings(activeSettings: Settings): () => void;
export declare function disableProvider(providerId: string): void;
export declare function enableProvider(providerId: string): void;
export declare function isProviderEnabled(providerId: string): boolean;
export declare function getDisabledProviders(): string[];
export declare function setDisabledProviders(providerIds: string[]): void;
export declare function getEnabledProviders(): string[];
export declare function setEnabledProviders(providerIds: string[]): void;
```

### A.3 ModelRegistry

```ts
// from: dist/types/config/model-registry.d.ts:38-345 (members, verbatim; wrapped signatures joined)
 readonly authStorage: AuthStorage;
 constructor(authStorage: AuthStorage, modelsPath?: string, options?: { /** * Gateway mode: ignore local `models.yml` entirely (provider overrides, * config API keys, custom models, custom discovery). A broker-backed * gateway serves only bundled + broker-discovered catalog metadata and * must never apply client-side credential or routing overrides. */ ignoreLocalModelConfig?: boolean; /** Settings source for availability and context-window policies. */ settings?: Settings; /** Model discovery cache database. Defaults beside an explicit models config. */ cacheDbPath?: string; fetch?: FetchImpl; });
 refresh(strategy?: ModelRefreshStrategy, options?: ModelRegistryRefreshOptions): Promise<void>;
 hydrateCredentialScopedModelCaches(): Promise<void>;
 refreshInBackground(strategy?: ModelRefreshStrategy): void;
 awaitBackgroundRefresh(): Promise<void>;
 refreshIfStale(): Promise<boolean>;
 awaitInitialBackgroundRefresh(signal?: AbortSignal): Promise<void>;
 getAll(kind?: ModelKind | "all"): Model<Api>[];
 getAvailable(kind?: ModelKind | "all"): Model<Api>[];
 hasConfiguredAuth(model: Model<Api>): boolean;
 hasProvider(providerId: string): boolean;
 find(provider: string, modelId: string): Model<Api> | undefined;
 getProviderModels(provider: string): Model<Api>[];
 resolver(provider: string, options?: ApiKeyResolverOptions): ApiKeyResolver;
 resolver(model: ApiKeyResolverModel, sessionId?: string): ApiKeyResolver;
 registerProvider(providerName: string, config: ProviderConfigInput, sourceId?: string): void;
```

```ts
// from: dist/types/config/model-registry.d.ts:22-36
export interface ModelRegistryRefreshOptions { refreshCommandCredentials?: boolean; }
export type ResolvedRequestAuth = { ok: true; apiKey?: string; headers?: Record<string, string>; env?: Record<string, string>; } | { ok: false; error: string; };
```

Also declared: `reapplyModelPolicies:82`, `refreshProvider:125`, `refreshDiscoverableProviders:132`, `hasLazyRuntimeMetadata:140`, `refreshSelectedModelMetadata:150`, `refreshRuntimeProviders:160`, `getError:164`, `getAvailableForProviders:178`, `hasConcreteAuth:216`, `hasCommandBackedApiKey:223`, `getDiscoverableProviders:224`, `getDiscoveryProviderId:226`, `getProviderDiscoveryState:237`, `isProviderDiscoveryPending:245`, `getProviderBaseUrl:271`, `getProviderHeaders:276`, `resolveModelHeaders:278`, `getApiKey:280`, `getApiKeyAndHeaders:284`, `getApiKeyForProvider:292`, `getApiKeyWithCredentialForProvider:293`, `resolver:301/:302`, `isUsingOAuth:306`, `clearSourceRegistrations:310`, `unregisterProvider:314`, `syncExtensionSources:318`, `suppressSelector:331`, `isSelectorSuppressed:335`, `clearSuppressedSelector:339`, `clearSuppressedSelectors:344`. `ModelRefreshStrategy` comes from `@oh-my-pi/pi-catalog/model-manager`; `ModelKind` from `@oh-my-pi/pi-catalog/types`.

### A.4 discoverAuthStorage + AuthStorage + credentials

```ts
// from: dist/types/sdk.d.ts:415 (discoverAuthStorage)
export declare function discoverAuthStorage(agentDir?: string, options?: Omit<DiscoverAuthStorageOptions, "agentDir" | "configValueResolver"> & Omit<EffectiveSettingsScope, "agentDir">): Promise<AuthStorage>;
```
```ts
// from: dist/types/session/auth-storage.d.ts:1-7 (pure re-export of the pi-ai surface)
export type { ApiKeyCredential, AuthCredential, AuthCredentialEntry, AuthCredentialStore, AuthStorageData, AuthStorageOptions, CredentialOrigin, CredentialOriginKind, OAuthAccountIdentity, OAuthAccountSummary, OAuthCredential, ResetCreditAccountStatus, ResetCreditRedeemOutcome, ResetCreditTarget, StoredAuthCredential, } from "@oh-my-pi/pi-ai";
export { AuthStorage, REMOTE_REFRESH_SENTINEL, SqliteAuthCredentialStore } from "@oh-my-pi/pi-ai";
export type { SnapshotResponse } from "@oh-my-pi/pi-ai/auth-broker/types";
```
```ts
// from: AIROOT/dist/types/auth-storage.d.ts:14-70
export declare class AuthStorage { #private; constructor(store: AuthCredentialStore, options?: AuthStorageOptions); get credentials(): CredentialsApi; get keys(): KeysApi; get oauth(): OAuthApi; get sessions(): SessionsApi; get usage(): UsageApi; get health(): HealthApi; get limits(): LimitsApi; get resets(): ResetsApi; get blocks(): BlocksApi; setAccountPolicies(config: { accountPolicies: AuthAccountPolicies; defaultReservePct: number; }): void; replaceStore(store: AuthCredentialStore, options?: { sourceLabel?: string; }): Promise<void>; static create(dbPath: string, options?: AuthStorageOptions): Promise<AuthStorage>; close(): void; getApiKey(provider: string, sessionId?: string, options?: AuthApiKeyOptions): Promise<string | undefined>; reload(): Promise<void>; }
```

```ts
// from: AIROOT/dist/types/auth/types.d.ts (CredentialsApi):689-799 (members, verbatim; wrapped signatures joined)
 readonly generation: number;
 onGeneration(listener: (generation: number) => void): () => void;
 onDisabled(listener: (event: CredentialDisabledEvent) => void | Promise<void>): () => void;
 reload(): Promise<void>;
 poll(): Promise<boolean>;
 revalidate(): Promise<void>;
 get(provider: string): AuthCredential | undefined;
 all(): AuthStorageData;
 list(provider?: string): StoredAuthCredential[];
 has(provider: string): boolean;
 hasOAuth(provider: string): boolean;
 getOAuth(provider: string): OAuthCredential | undefined;
 set(provider: string, credential: AuthCredentialEntry): Promise<void>;
 upsert(provider: string, credential: AuthCredential): Promise<AuthCredentialSnapshotEntry[]>;
 remove(provider: string): Promise<void>;
 removeById(provider: string, credentialId: number): Promise<boolean>;
 disable(id: number, disabledCause: string): Promise<boolean>;
 listDisabled(provider?: string, signal?: AbortSignal): Promise<DisabledCredentialSummary[]>;
 snapshot(): AuthCredentialSnapshot;
```

```ts
// from: AIROOT/dist/types/auth/types.d.ts (KeysApi):801-904 (members, verbatim; wrapped signatures joined)
 get(provider: string, sessionId?: string, options?: AuthApiKeyOptions): Promise<string | undefined>;
 getWithCredential(provider: string, sessionId?: string, options?: AuthApiKeyOptions): Promise<ResolvedApiKey | undefined>;
 peek(provider: string): Promise<string | undefined>;
 source(provider: string, options?: AuthSourceOptions): AuthSource | undefined;
 keyless(provider: string): boolean;
 describe(provider: string, sessionId?: string): string | undefined;
 setRuntime(provider: string, apiKey: string): void;
 removeRuntime(provider: string): void;
 setConfig(provider: string, apiKeyConfig: string, options?: { fallback?: boolean; }): void;
 removeConfig(provider: string): void;
 clearConfig(): void;
 setResolver(resolver: (config: string) => Promise<string | undefined>): void;
 resolver(provider: string, options?: { sessionId?: string; baseUrl?: string; modelId?: string; }): ApiKeyResolver;
```

```ts
// from: AIROOT/dist/types/auth/types.d.ts:20
export type AuthCredentialEntry = AuthCredential | AuthCredential[];
```

### A.5 SessionManager

```ts
// from: dist/types/session/session-manager.d.ts:106-589 (members, verbatim; wrapped signatures joined)
 setSessionFile(sessionFile: string): Promise<void>;
 newSession(options?: NewSessionOptions): Promise<string | undefined>;
 ensureOnDisk(): Promise<void>;
 flush(): Promise<void>;
 flushSync(): void;
 close(): Promise<void>;
 getCwd(): string;
 getRecordedCwd(): string | undefined;
 getAdditionalDirectories(): string[];
 getSessionDir(): string;
 getSessionId(): string;
 getSessionFile(): string | undefined;
 isSessionOnDisk(): boolean;
 getArtifactsDir(): string | null;
 appendMessage(message: Message | CustomMessage | HookMessage | BashExecutionMessage | PythonExecutionMessage | FileMentionMessage): string;
 appendThinkingLevelChange(thinkingLevel?: string, configured?: string): string;
 appendModelChange(model: string, role?: string, resolvedModelIsFallback?: boolean): string;
 appendCompaction<T = unknown>(summary: string, shortSummary: string | undefined, firstKeptEntryId: string, tokensBefore: number, options?: { details?: T; fromExtension?: boolean; preserveData?: Record<string, unknown>; method?: CompactionMethod; providerReplayThroughEntryId?: string; tokensAfter?: number; }): string;
 appendCustomEntry(customType: string, data?: unknown): string;
 rewriteEntries(): Promise<void>;
 appendCustomMessageEntry<T = unknown>(customType: string | undefined, content: string | (TextContent | ImageContent)[] | undefined, display: boolean | undefined, details?: T, attribution?: MessageAttribution | undefined, timestamp?: number): string;
 getLeafId(): string | null;
 getLeafEntry(): SessionEntry | undefined;
 getEntry(id: string): SessionEntry | undefined;
 getChildren(parentId: string): SessionEntry[];
 getBranch(fromId?: string): SessionEntry[];
 buildSessionContext(options?: BuildSessionContextOptions): SessionContext;
 getHeader(): SessionHeader | null;
 getEntries(): SessionEntry[];
 getTree(): SessionTreeNode[];
 createBranchedSession(leafId: string, options?: { copyArtifacts?: boolean; }): string | undefined;
 static getDefaultSessionDir(cwd: string, agentDir?: string, storage?: SessionStorage): string;
 static create(cwd: string, sessionDir?: string, storage?: SessionStorage): SessionManager;
 static createEmptySessionFile(cwd: string, storage?: SessionStorage): string;
 static forkFrom(sourcePath: string, cwd: string, sessionDir?: string, storage?: SessionStorage, options?: { copyArtifacts?: boolean; suppressBreadcrumb?: boolean; sessionFile?: string; resetInheritedCost?: boolean; repairInterruptedTail?: boolean; }): Promise<SessionManager>;
 static open(filePath: string, sessionDir?: string, storage?: SessionStorage, options?: { initialCwd?: string; parentSession?: string; suppressBreadcrumb?: boolean; throwIfMissing?: boolean; }): Promise<SessionManager>;
 static peekSessionInit(filePath: string, storage?: SessionStorage): Promise<{ cwd: string; init: PersistedSessionInit | null; } | null>;
 static continueRecent(cwd: string, sessionDir?: string, storage?: SessionStorage): Promise<SessionManager>;
 static inMemory(cwd?: string, storage?: SessionStorage): SessionManager;
 static list(cwd: string, sessionDir?: string, storage?: SessionStorage): Promise<SessionInfo[]>;
 static listAll(storage?: SessionStorage): Promise<SessionInfo[]>;
 static listForPicker(cwd: string, sessionDir?: string, storage?: SessionStorage): Promise<SessionInfo[]>;
 static listAllForPicker(storage?: SessionStorage): Promise<SessionInfo[]>;
```

```ts
// from: dist/types/session/session-manager.d.ts:13, :28
export declare function mintSessionId(): string;
export type ReadonlySessionManager = Pick<SessionManager, "getCwd" | "getRecordedCwd" | "getSessionDir" | "getSessionId" | "getSessionFile" | "getSessionName" | "getArtifactsDir" | "getArtifactManager" | "allocateArtifactPath" | "saveArtifact" | "getArtifactPath" | "getLeafId" | "getLeafEntry" | "getEntry" | "getLabel" | "getBranch" | "getHeader" | "getEntries" | "getTree" | "getUsageStatistics" | "putBlob" | "putBlobSync">;
```

```ts
// from: dist/types/session/session-listing.d.ts:16-39
export type SessionStatus = "complete" | "interrupted" | "aborted" | "error" | "pending" | "unknown";
export interface SessionInfo { path: string; id: string; cwd: string; title?: string; parentSessionPath?: string; created: Date; modified: Date; messageCount: number; assistantTurns?: number; size: number; firstMessage: string; allMessagesText: string; status?: SessionStatus; }
```

The session file / messages surface is the trio `getSessionFile(): string | undefined` / `getSessionDir(): string` / `getSessionId(): string`, plus the tree readers (`getHeader` / `getEntries` / `getLeafId` / `getLeafEntry` / `getEntry` / `getChildren` / `getBranch` / `getTree` / `buildSessionContext`) and the writers (`appendMessage` / `appendCustomMessageEntry` / `appendCustomEntry` / `appendModelChange` / `appendThinkingLevelChange` / `appendCompaction` / `rewriteEntries` / `flush`).

### A.6 The session object returned by createAgentSession

Class `AgentSession` (dist/types/session/agent-session.d.ts:103). The block below is verbatim, in declaration order, for every member the adapter needs (subscribe / prompt / steer / followUp / abort / dispose / setModel / setThinkingLevel / queues / context usage / model / messages / skills / session file + id); the class declares more, listed by name after the block. `#private` members are excluded, and `initializeExtensions` / `setToolUIContext` are NOT methods here (see A.7).

```ts
// from: dist/types/session/agent-session.d.ts:103-1483 (all adapter-relevant members, in declaration order;
// wrapped signatures joined onto one line; `#private` members and unrelated methods omitted)
 readonly settings: Settings;
 get preparedExtensions(): readonly PreparedExtension[] | undefined;
 get extensionPaths(): readonly string[] | undefined;
 get modelRegistry(): ModelRegistry;
 subscribe(listener: AgentSessionEventListener): () => void;
 activeToolExecutionUpdates(): readonly Extract<AgentSessionEvent, { type: "tool_execution_update"; }>[];
 subscribeRunState(listener: (state: "running" | "idle") => void): () => void;
 get isDisposed(): boolean;
 beginDispose(): void;
 dispose(options?: AgentSessionDisposeOptions): Promise<void>;
 get state(): AgentState;
 get model(): Model | undefined;
 get thinkingLevel(): ThinkingLevel | undefined;
 get isStreaming(): boolean;
 waitForIdle(): Promise<void>;
 get messages(): AgentMessage[];
 buildDisplaySessionContext(): SessionContext;
 get steeringMode(): "all" | "one-at-a-time";
 get followUpMode(): "all" | "one-at-a-time";
 get sessionFile(): string | undefined;
 get sessionId(): string;
 prompt(text: string, options?: PromptOptions): Promise<boolean>;
 promptCustomMessage<T = unknown>(message: Pick<CustomMessage<T>, "customType" | "content" | "display" | "details" | "attribution">, options?: Pick<PromptOptions, "streamingBehavior" | "toolChoice" | "onPromptAdmitted"> & { queueChipText?: string; queueOnly?: boolean; }): Promise<boolean>;
 steer(text: string, images?: ImageContent[], options?: SteerOptions): Promise<void>;
 followUp(text: string, images?: ImageContent[], options?: FollowUpOptions): Promise<void>;
 sendCustomMessage<T = unknown>(message: CustomMessagePayload<T>, options?: { triggerTurn?: boolean; deliverAs?: "steer" | "followUp" | "nextTurn" | "aside"; queueChipText?: string; acceptTerminalEmptyStop?: boolean; }): Promise<boolean>;
 sendUserMessage(content: string | (TextContent | ImageContent)[], options?: SendUserMessageOptions): Promise<void>;
 clearQueue(options?: { forInterrupt?: boolean; }): { steering: RestoredQueuedMessage[]; followUp: RestoredQueuedMessage[]; };
 get queuedMessageCount(): number;
 getQueuedMessages(): { steering: readonly string[]; followUp: readonly string[]; };
 removeQueuedMessage(text: string, queue: "steering" | "followUp"): boolean;
 promoteQueuedMessage(text: string): boolean;
 popLastQueuedMessage(): RestoredQueuedMessage | undefined;
 get skillsSettings(): SkillsSettings | undefined;
 get skills(): readonly Skill[];
 setPromptDropped(handler: ((prompt: DroppedPrompt) => void) | undefined): void;
 abort(options?: { goalReason?: "interrupted" | "internal"; reason?: string; /** Internal `/compact` startup keeps the manual-compaction marker alive while aborting the active turn. */ preserveCompaction?: boolean; }): Promise<void>;
 newSession(options?: NewSessionOptions): Promise<boolean>;
 setSessionName(name: string, source?: "auto" | "user", trigger?: SessionNameTrigger): Promise<boolean>;
 setModel(model: Model, role?: string, options?: { selector?: string; thinkingLevel?: ThinkingLevel; persist?: boolean; }): Promise<{ switched: boolean; }>;
 setThinkingLevel(level: ConfiguredThinkingLevel | undefined, persist?: boolean): void;
 setSteeringMode(mode: "all" | "one-at-a-time", persist?: boolean): void;
 setFollowUpMode(mode: "all" | "one-at-a-time", persist?: boolean): void;
 buildAskReanswerContext(uiContext: ExtensionUIContext): AgentToolContext;
 getSessionStats(): SessionStats;
 getContextBreakdown(options?: { contextWindow?: number; pendingMessages?: AgentMessage[]; }): ContextUsageBreakdown | undefined;
 getContextUsage(options?: { contextWindow?: number; }): ContextUsage | undefined;
 hasExtensionHandlers(eventType: string): boolean;
 get extensionRunner(): ExtensionRunner | undefined;
```

More public members of the same class (names + line numbers): `constructor:143`, `addDisposer:145`, `get asyncJobManager:148`, `getAgentId:149`, `hasPendingAsyncWork:224`, `getAsyncJobSnapshot:206`, `inspectAsyncJob:214`, `cancelAsyncJob:216`, `settleAsyncWork:237`, `emitNotice:254`, `runStartedAt:287`, `startCacheWarming:299`, `lastPromptTokens:301`, `freshSession:328`, `resetSessionContext:347`, `get servingModel:357`, `setUsageFallbackConfirmer:359`, `configuredThinkingLevel:363`, `isAutoThinking:365`, `autoResolvedThinkingLevel:367`, `serviceTierByFamily:369`, `isAborting:372`, `getLastAssistantMessage:400`, `systemPrompt:402`, `getActiveToolNames:408`, `getEnabledToolNames:410`, `getToolByName:416`, `getAllToolNames:450`, `getAllToolInfos:452`, `refreshSkills:462`, `refreshSkillsAndCommands:468`, `setActiveToolsByName:485`, `refreshMCPTools:515`, `isCompacting:519`, `dropImages:523`, `shake:527`, `compact:532`, `abortCompaction:534`, `autoCompactionEnabled:542`, `setAutoCompactionEnabled:540`, `setModelTemporary:919`, `cycleModel:923`, `applyRoleModel:927`, `cycleRoleModels:929`, `getAvailableModels:931`, `cycleThinkingLevel:935`, `getAvailableEffortSelectors:937`, `getAvailableThinkingLevels:990`, `setInterruptMode:1008`, `interruptMode:575`, `handoff:1030`, `fork:897`, `moveSession:901`, `switchSession:1139`, `branch:1154`, `exportToHtml:1303`, `formatSessionAsText:1326`, `dumpSessionArchiveToTmpDir:1341`, `listCurrentProviderOAuthAccounts:1282`, `pinCurrentProviderOAuthAccount:1287`, `executeBash:1050`, `executePython:1072`, `getSessionAgents:809`, `getTodoPhases:814`, `get titleSystemPrompt:845`, `setTitleSystemPrompt:850`.

```ts
// from: dist/types/session/agent-session.d.ts:86-96 (PromptDroppedError, SessionBusyError)
export declare class PromptDroppedError extends Error { constructor(); }
export declare class SessionBusyError extends Error { constructor(action: string); }
```

`initializeExtensions` and `setToolUIContext` are NOT AgentSession methods — `setToolUIContext` is a field of `CreateAgentSessionResult` (sdk.d.ts:368) and `initializeExtensions` is the free function in A.7.

```ts
// from: dist/types/session/agent-session-types.d.ts:350-432 (PromptOptions, DroppedPrompt, FollowUp/Steer/SendUserMessage options, HandoffResult)
export interface PromptOptions { expandPromptTemplates?: boolean; runCommands?: boolean; throwOnDrop?: boolean; images?: ImageContent[]; streamingBehavior?: "steer" | "followUp" | "aside"; toolChoice?: ToolChoice; synthetic?: boolean; userInitiated?: boolean; attribution?: MessageAttribution; skipCompactionCheck?: boolean; solutionSpace?: string; onPromptAdmitted?: () => void; }
export interface DroppedPrompt { text: string; images?: ImageContent[]; }
export interface FollowUpOptions { synthetic?: boolean; expandPromptTemplates?: boolean; attribution?: MessageAttribution; }
export interface SteerOptions { attribution?: MessageAttribution; }
export interface SendUserMessageOptions { deliverAs?: "steer" | "followUp" | "aside"; attribution?: MessageAttribution; }
export interface HandoffResult { document: string; savedPath?: string; }
export interface SessionHandoffOptions { autoTriggered?: boolean; signal?: AbortSignal;
```

```ts
// from: dist/types/session/agent-session-types.d.ts:455-513 (ContextUsageBreakdown, SessionStats, FreshSessionResult, RestoredQueuedMessage)
export interface ContextUsageBreakdown { contextWindow: number; anchored: boolean; usedTokens: number; systemPromptTokens: number; systemToolsTokens: number; systemContextTokens: number; skillsTokens: number; messagesTokens: number; }
export interface SessionStats { sessionFile: string | undefined; sessionId: string; userMessages: number; assistantMessages: number; toolCalls: number; toolResults: number; totalMessages: number; tokens: { input: number; output: number; reasoning: number; cacheRead: number; cacheWrite: number; total: number; }; premiumRequests: number; cost: number; credits?: { cost: number; committedCost: number; acuCost: number; }; routedModels?: Record<string, number>; contextUsage?: ContextUsage; }
export interface SessionOAuthAccountList { provider: string; accounts: OAuthAccountSummary[]; }
export interface FreshSessionResult { previousSessionId: string; sessionId: string; closedProviderSessions: number; }
export interface ResetSessionContextResult { droppedCount: number; }
export type RestoredQueuedMessage = { text: string; images?: ImageContent[]; };
```

```ts
// from: dist/types/session/agent-session-types.d.ts:34-49 (AgentSessionDisposeOptions)
export interface AgentSessionDisposeOptions { mnemopiConsolidateTimeoutMs?: number; drainTimeoutMs?: number; reason?: postmortem.Reason; }
```

```ts
// from: TUIROOT/dist/types/status-line/types.d.ts:8-15 (ContextUsage)
export interface ContextUsage { tokens: number; contextWindow: number; percent: number; }
```
```ts
// from: COREROOT/dist/types/thinking.d.ts:1-18 (ThinkingLevel)
import { Effort } from "@oh-my-pi/pi-catalog/effort";
export declare const ThinkingLevel: { readonly Inherit: "inherit"; readonly Off: "off"; readonly Minimal: Effort.Minimal; readonly Low: Effort.Low; readonly Medium: Effort.Medium; readonly High: Effort.High; readonly XHigh: Effort.XHigh; readonly Max: Effort.Max; };
export type ThinkingLevel = (typeof ThinkingLevel)[keyof typeof ThinkingLevel];
export type ResolvedThinkingLevel = Exclude<ThinkingLevel, "inherit">;
```
```ts
// from: TUIROOT/dist/types/render/render-utils.d.ts:14 (ConfiguredThinkingLevel)
export type ConfiguredThinkingLevel = ThinkingLevel | "auto";
```

`Effort` is declared in `node_modules/@oh-my-pi/pi-catalog/dist/types/effort.d.ts` as `export declare const enum Effort { Minimal = "minimal", Low = "low", Medium = "medium", High = "high", XHigh = "xhigh", Max = "max" }`.

### A.7 initializeExtensions + setToolUIContext + ensureThemeSync

```ts
// from: dist/types/modes/runtime-init.d.ts:1-43 — import specifier "@oh-my-pi/pi-coding-agent/modes/runtime-init"
import type { ExtensionError, ExtensionMode, ExtensionUIContext } from "../extensibility/extensions/types.js";
import type { AgentSession } from "../session/agent-session.js";
export type ExtensionSendAction = "extension_send" | "extension_send_user";
export interface InitializeExtensionsOptions { reportSendError: (action: ExtensionSendAction, error: Error) => void; reportRuntimeError: (error: ExtensionError) => void; onShutdown?: () => void; mode?: ExtensionMode; uiContext?: ExtensionUIContext; markAgentInvokingMessage?: () => void; trackAgentInvokingMessage?: (task: Promise<unknown>) => void; trackExtensionSend?: (task: Promise<unknown>) => void; filterActiveTools?: (toolNames: string[]) => string[]; wrapSessionChange?: <T extends { cancelled: boolean; }>(change: () => Promise<T>, options: { detachesRun: boolean; }) => Promise<T>; }
export declare function initializeExtensions(session: AgentSession, options: InitializeExtensionsOptions): Promise<void>;
```

`initializeExtensions` is NOT re-exported from `dist/types/index.d.ts`, and `dist/types/modes/index.d.ts` does not re-export it either (grep `runtime-init` over that file: 0 matches). `setToolUIContext` exists only as a callback value (no exported free function):

```ts
// from: dist/types/sdk.d.ts:368
 setToolUIContext: (uiContext: ExtensionUIContext, hasUI: boolean) => void;
```
```ts
// from: dist/types/main.d.ts:30 (member of AcpSessionHandle)
 setToolUIContext: (uiContext: ExtensionUIContext, hasUI: boolean) => void;
```
```ts
// from: dist/types/main.d.ts:32 (member of AcpSessionFactoryOptions, inside the options object)
 setToolUIContext: (uiContext: ExtensionUIContext, hasUI: boolean) => void;
```
```ts
// from: dist/types/modes/interactive-mode.d.ts:494
 setToolUIContext(uiContext: ExtensionUIContext, hasUI: boolean): void;
```
```ts
// from: dist/types/modes/types.d.ts:257
 setToolUIContext(uiContext: ExtensionUIContext, hasUI: boolean): void;
```
```ts
// from: dist/types/modes/acp/acp-mode.d.ts:8
 setToolUIContext: (uiContext: ExtensionUIContext, hasUI: boolean) => void;
```

`ensureThemeSync`: **NOT FOUND** in @oh-my-pi/pi-coding-agent (searched the whole package including `src/` and `dist/cli.js`). It is a pi-tui export, and the coding-agent root re-exports that module (`dist/types/index.d.ts:20` = `export * from "@oh-my-pi/pi-tui/theme"`):

```ts
// from: TUIROOT/dist/types/theme/theme.d.ts:26 — import specifier "@oh-my-pi/pi-tui/theme"
export declare function ensureThemeSync(): void;
```

### A.8 exportFromFile

```ts
// from: dist/types/export/html/index.d.ts:8-48 — import specifier "@oh-my-pi/pi-coding-agent/export/html"
export declare function resolveBundledHtmlAssetPath(assetPath: string, moduleDir?: string): string;
export declare function getTemplate(): string;
export interface ExportOptions { outputPath?: string; palette?: "web" | "theme"; themeName?: string; themeNames?: ExportThemeNames; includeSubSessions?: boolean; }
export declare function generateThemeVars(palette?: "web" | "theme" | (string & {}), themeName?: string): Promise<string>;
export declare function generateThemeStyles(palette: "web" | "theme", themeNames?: ExportThemeNames, legacyThemeName?: string): Promise<string>;
export interface SessionData { header: SessionHeader | null; entries: SessionEntry[]; leafId: string | null; systemPrompt?: string; tools?: { name: string; description: string; }[]; subSessions?: Record<string, SubSession>; }
export declare function buildSessionData(sm: SessionManager, state?: AgentState): SessionData;
export declare function exportSessionToHtml(sm: SessionManager, state?: AgentState, options?: ExportOptions | string): Promise<string>;
export declare function exportFromFile(inputPath: string, options?: ExportOptions | string): Promise<string>;
```

`exportFromFile` is not re-exported from the package root (no `./export/*` entry in dist/types/index.d.ts).

### A.9 discoverSkills

```ts
// from: dist/types/sdk.d.ts:470-473
export declare function discoverSkills(cwd?: string, _agentDir?: string, settings?: SkillsSettings & Pick<LoadSkillsOptions, "disabledExtensions">): Promise<{ skills: Skill[]; warnings: SkillWarning[]; }>;
```
```ts
// from: dist/types/extensibility/skills.d.ts:6-33, :76
export interface Skill { name: string; description: string; filePath: string; baseDir: string; source: string; hide?: boolean; containRoot?: string; _source?: SourceMeta; }
export interface SkillWarning { skillPath: string; message: string; }
export interface LoadSkillsResult { skills: Skill[]; warnings: SkillWarning[]; }
export declare function loadSkills(options?: LoadSkillsOptions): Promise<LoadSkillsResult>;
```

### A.10 loadAllMCPConfigs

```ts
// from: dist/types/mcp/config.d.ts:9-35 — import specifier "@oh-my-pi/pi-coding-agent/mcp/config"
export interface LoadMCPConfigsOptions { enableProjectConfig?: boolean; filterExa?: boolean; filterBrowser?: boolean; extensionRoots?: EffectiveExtensionRoots; }
export interface LoadMCPConfigsResult { configs: Record<string, MCPServerConfig>; exaApiKeys: string[]; sources: Record<string, SourceMeta>; }
export declare function loadAllMCPConfigs(cwd: string, options?: LoadMCPConfigsOptions): Promise<LoadMCPConfigsResult>;
```

Same file: `isExaMCPServer:39`, `extractExaApiKey:43`, `filterExaMCPServers:59`, `validateServerConfig:63`, `shouldFilterBrowserMCPForPrelude:71`, `isBrowserMCPServer:75`, `filterBrowserMCPServers:87`, `ExaFilterResult:45`, `BrowserMCPPreludeFilterOptions:64`, `BrowserFilterResult:77`.

### A.11 mcp/config-writer

```ts
// from: dist/types/mcp/config-writer.d.ts:1-101 — import specifier "@oh-my-pi/pi-coding-agent/mcp/config-writer"
import { type MCPConfigFile, type MCPServerConfig } from "./types.js";
export declare function readMCPConfigFile(filePath: string): Promise<MCPConfigFile>;
export declare function writeMCPConfigFile(filePath: string, config: MCPConfigFile): Promise<void>;
export declare function validateServerName(name: string): string | undefined;
export declare function addMCPServer(filePath: string, name: string, config: MCPServerConfig): Promise<void>;
export declare function updateMCPServer(filePath: string, name: string, config: MCPServerConfig): Promise<void>;
export declare function removeMCPServer(filePath: string, name: string): Promise<void>;
export declare function getMCPServer(filePath: string, name: string): Promise<MCPServerConfig | undefined>;
export declare function listMCPServers(filePath: string): Promise<string[]>;
export declare function readDisabledServers(filePath: string): Promise<string[]>;
export declare function setServerDisabled(filePath: string, name: string, disabled: boolean): Promise<void>;
export declare function readEnabledServers(filePath: string): Promise<string[]>;
export declare function setServerForceEnabled(filePath: string, name: string, force: boolean): Promise<void>;
export interface SetMcpServerEnabledOptions { userPath: string; projectPath: string; sourcePath?: string; name: string; enabled: boolean; }
export declare function setMcpServerEnabled(options: SetMcpServerEnabledOptions): Promise<void>;
```
```ts
// from: dist/types/mcp/types.d.ts:104-134
export interface MCPHttpServerConfig extends MCPServerConfigBase { type: "http"; url: string; headers?: Record<string, string>; headerPolicy?: "origin-locked"; }
export interface MCPSseServerConfig extends MCPServerConfigBase { type: "sse"; url: string; headers?: Record<string, string>; headerPolicy?: "origin-locked"; }
export type MCPServerConfig = MCPStdioServerConfig | MCPHttpServerConfig | MCPSseServerConfig;
export declare const MCP_CONFIG_SCHEMA_URL = "https://raw.githubusercontent.com/can1357/oh-my-pi/main/packages/coding-agent/src/config/mcp-schema.json";
export interface MCPConfigFile { $schema?: string; mcpServers?: Record<string, MCPServerConfig>; disabledServers?: string[]; enabledServers?: string[]; }
```

### A.12 extensibility/plugins — manager, installer, marketplace

```ts
// from: dist/types/extensibility/plugins/index.d.ts (entire file) — import specifier ".../extensibility/plugins"
export * from "./doctor.js";
export * from "./git-url.js";
export * from "./loader.js";
export * from "./manager.js";
export * from "./marketplace/index.js";
export * from "./parser.js";
export type * from "./types.js";
```
```ts
// from: dist/types/extensibility/plugins/manager.d.ts:2-105 (members, verbatim; wrapped signatures joined)
 constructor(cwd?: string);
 install(specString: string, options?: InstallOptions): Promise<InstalledPlugin>;
 upgrade(name: string): Promise<{ from: string | undefined; plugin: InstalledPlugin; changed: boolean; }>;
 uninstall(name: string): Promise<void>;
 getPlugin(name: string, options?: { path?: string; }): Promise<InstalledPlugin | undefined>;
 list(): Promise<InstalledPlugin[]>;
 link(localPath: string): Promise<InstalledPlugin>;
 setEnabled(name: string, enabled: boolean): Promise<void>;
 getEnabledFeatures(name: string): Promise<string[] | null>;
 setEnabledFeatures(name: string, features: string[] | null): Promise<void>;
 getPluginSettings(name: string): Promise<Record<string, unknown>>;
 setPluginSetting(name: string, key: string, value: unknown): Promise<void>;
 deletePluginSetting(name: string, key: string): Promise<void>;
 doctor(options?: DoctorOptions): Promise<DoctorCheck[]>;
```
```ts
// from: dist/types/extensibility/plugins/installer.d.ts (entire file)
import type { InstalledPlugin } from "./types.js";
export declare function installPlugin(packageName: string): Promise<InstalledPlugin>;
export declare function uninstallPlugin(name: string): Promise<void>;
export declare function listPlugins(): Promise<InstalledPlugin[]>;
export declare function linkPlugin(localPath: string): Promise<void>;
```
```ts
// from: dist/types/extensibility/plugins/marketplace/index.d.ts (entire file) — import specifier ".../plugins/marketplace"
export * from "./cache.js";
export * from "./fetcher.js";
export * from "./manager.js";
export * from "./registry.js";
export * from "./source-resolver.js";
export * from "./types.js";
```
```ts
// from: dist/types/extensibility/plugins/marketplace/manager.d.ts:9-64 (members, verbatim; wrapped signatures joined)
 marketplacesRegistryPath: string;
 installedRegistryPath: string;
 marketplacesCacheDir: string;
 pluginsCacheDir: string;
 constructor(options: MarketplaceManagerOptions);
 addMarketplace(source: string): Promise<MarketplaceRegistryEntry>;
 removeMarketplace(name: string): Promise<void>;
 updateMarketplace(name: string): Promise<MarketplaceRegistryEntry>;
 updateAllMarketplaces(): Promise<MarketplaceRegistryEntry[]>;
 listMarketplaces(): Promise<MarketplaceRegistryEntry[]>;
 listAvailablePlugins(marketplace?: string): Promise<MarketplacePluginEntry[]>;
 getPluginInfo(name: string, marketplace: string): Promise<MarketplacePluginEntry | null>;
 validateInstallPlugin(name: string, marketplace: string, options?: { force?: boolean; scope?: "user" | "project"; }): Promise<void>;
 installPlugin(name: string, marketplace: string, options?: { force?: boolean; scope?: "user" | "project"; }): Promise<InstalledPluginEntry>;
 uninstallPlugin(pluginId: string, scope?: "user" | "project", options?: { dryRun?: boolean; }): Promise<void>;
 listInstalledPlugins(): Promise<InstalledPluginSummary[]>;
 setPluginEnabled(pluginId: string, enabled: boolean, scope?: "user" | "project"): Promise<void>;
 refreshStaleMarketplaces(): Promise<void>;
 checkForUpdates(): Promise<Array<{ pluginId: string; scope: "user" | "project"; from: string; to: string; }>>;
 upgradePlugin(pluginId: string, scope?: "user" | "project"): Promise<InstalledPluginEntry>;
 upgradePluginAcrossScopes(pluginId: string): Promise<InstalledPluginEntry[]>;
 upgradeAllPlugins(): Promise<Array<{ pluginId: string; scope: "user" | "project"; from: string; to: string; }>>;
```
```ts
// from: dist/types/extensibility/plugins/types.d.ts:1-155
export interface PluginFeature { description?: string; default?: boolean; extensions?: string[]; tools?: string[]; hooks?: string[]; commands?: string[]; }
export interface PluginManifest { name?: string; version: string; description?: string; tools?: string; hooks?: string; extensions?: string[]; commands?: string[]; features?: Record<string, PluginFeature>; settings?: Record<string, PluginSettingSchema>; }
export type PluginSettingType = "string" | "number" | "boolean" | "enum";
interface PluginSettingBase { type: PluginSettingType; description?: string; secret?: boolean; env?: string; }
export interface StringSetting extends PluginSettingBase { type: "string"; default?: string; }
export interface NumberSetting extends PluginSettingBase { type: "number"; default?: number; min?: number; max?: number; step?: number; }
export interface BooleanSetting extends PluginSettingBase { type: "boolean"; default?: boolean; }
export interface EnumSetting extends PluginSettingBase { type: "enum"; values: string[]; default?: string; }
export type PluginSettingSchema = StringSetting | NumberSetting | BooleanSetting | EnumSetting;
export interface InstalledPlugin { name: string; version: string; path: string; manifest: PluginManifest; enabledFeatures: string[] | null; enabled: boolean; }
export interface PluginRuntimeState { version: string; enabledFeatures: string[] | null; enabled: boolean; }
export interface PluginRuntimeConfig { plugins: Record<string, PluginRuntimeState>; settings: Record<string, Record<string, unknown>>; }
export interface ProjectPluginOverrides { disabled?: string[]; features?: Record<string, string[]>; settings?: Record<string, Record<string, unknown>>; }
export interface DoctorCheck { name: string; status: "ok" | "warning" | "error"; message: string; fixed?: boolean; }
export interface InstallOptions { force?: boolean; dryRun?: boolean; preserveState?: Pick<PluginRuntimeState, "enabled" | "enabledFeatures">; }
export interface DoctorOptions { fix?: boolean; }
export {};
```

### A.13 AgentSessionEvent — every variant

```ts
// from: dist/types/session/agent-session-events.d.ts:12-115 (the whole union, verbatim)
export type AgentSessionEvent = Exclude<AgentEvent, { type: "agent_end"; }> | (Extract<AgentEvent, { type: "agent_end"; }> & { isTerminal?: boolean; yielded?: boolean; awaitingAsyncWork?: boolean; }) | { type: "auto_compaction_start"; reason: "threshold" | "overflow" | "idle" | "incomplete"; action: "context-full" | "remote" | "handoff" | "shake" | "snapcompact"; } | { type: "auto_compaction_end"; action: "context-full" | "remote" | "handoff" | "shake" | "snapcompact"; result: CompactionResult | undefined; aborted: boolean; willRetry: boolean; errorMessage?: string; skipped?: boolean; } | { type: "auto_retry_start"; attempt: number; maxAttempts: number; delayMs: number; errorMessage: string; errorId?: number; } | { type: "auto_retry_end"; success: boolean; attempt: number; finalError?: string; retryErrors?: RetryErrorUpdate[]; } | ({ type: "cache_warming_start"; } & CacheWarmingRefreshStart) | ({ type: "cache_warming_end"; } & CacheWarmingRefreshEnd) | { type: "retry_fallback_applied"; from: string; to: string; role: string; reason?: string; } | { type: "retry_fallback_succeeded"; model: string; role: string; } | { type: "model_changed"; } | { type: "config_warnings_changed"; } | { type: "advisor_cost_changed"; } | { type: "advisor_yielded"; } | { type: "ttsr_triggered"; rules: Rule[]; } | { type: "todo_reminder"; todos: TodoItem[]; attempt: number; maxAttempts: number; } | { type: "todo_auto_clear"; } | { type: "irc_message"; message: CustomMessage; } | { type: "notice"; level: "info" | "warning" | "error"; message: string; source?: string; } | { type: "thinking_level_changed"; thinkingLevel: ThinkingLevel | undefined; configured?: ConfiguredThinkingLevel; resolved?: Effort; } | { type: "goal_updated"; goal: Goal | null; state?: GoalModeState; } | { type: "queue_update"; steering: string[]; followUp: string[]; };
export type AgentSessionEventListener = (event: AgentSessionEvent) => void;
```

The first arm (`Exclude<AgentEvent, { type: "agent_end" }>`) expands to these pi-agent-core variants:

```ts
// from: COREROOT/dist/types/types.d.ts:1082-1129
export type AgentEvent = { type: "agent_start"; } | { type: "agent_end"; messages: AgentMessage[]; telemetry?: AgentRunSummary; coverage?: AgentRunCoverage; } | { type: "turn_start"; } | { type: "turn_end"; message: AgentMessage; toolResults: ToolResultMessage[]; } | { type: "message_start"; message: AgentMessage; } | { type: "message_update"; message: AgentMessage; assistantMessageEvent: AssistantMessageEvent; } | { type: "message_end"; message: AgentMessage; } | { type: "tool_execution_start"; toolCallId: string; toolName: string; args: any; intent?: string; } | { type: "tool_execution_update"; toolCallId: string; toolName: string; args: any; partialResult: any; } | { type: "tool_stream_update"; toolCallId: string; toolName: string; update: unknown; } | { type: "tool_execution_end"; toolCallId: string; toolName: string; result: any; isError?: boolean; };
```

```ts
// from: dist/types/session/cache-warmer.d.ts:22-38 (payloads of the cache_warming_* arms)
export type CacheWarmingMode = "off" | "streaming" | "idle";
export declare const CACHE_WARMING_MODES: readonly ["off", "streaming", "idle"];
export interface CacheWarmingRefreshStart { phase: "streaming" | "idle"; provider: string; model: string; }
export interface CacheWarmingRefreshEnd extends CacheWarmingRefreshStart { outcome: "hit" | "miss" | "error" | "aborted"; usage?: Usage; warmingStopReason?: string; }
```
```ts
// from: dist/types/extensibility/shared-events.d.ts:215-229 (RetryErrorUpdate, used by auto_retry_end)
export interface RetryErrorUpdate { entryId: string; persistenceKey?: string; note: string; retryRecovery: AssistantRetryRecovery; }
export interface AutoRetryEndEvent { type: "auto_retry_end"; success: boolean; attempt: number; finalError?: string; retryErrors?: RetryErrorUpdate[]; }
```

### A.14 ToolDefinition accepted by pi.registerTool inside an extension

```ts
// from: dist/types/extensibility/extensions/types.d.ts:461-519
export interface ToolDefinition<TParams extends TSchema = TSchema, TDetails = unknown> { name: string; label: string; description: string; parameters: TParams; hidden?: boolean; defaultInactive?: boolean; loadMode?: ToolLoadMode; deferrable?: boolean; readsSkillUris?: boolean; approval?: ToolApproval; strict?: boolean; mcpServerName?: string; mcpToolName?: string; legacyName?: string; shellEnv?: ToolShellEnvironmentHook; sourcePath?: string; execute(toolCallId: string, params: Static<TParams>, signal: AbortSignal | undefined, onUpdate: AgentToolUpdateCallback<TDetails> | undefined, ctx: ExtensionContext): Promise<AgentToolResult<TDetails>>; onSession?: (event: ToolSessionEvent, ctx: ExtensionContext) => void | Promise<void>; renderCall?: (args: Static<TParams>, options: ToolRenderResultOptions, theme: Theme) => Component; renderResult?: (result: AgentToolResult<TDetails>, options: ToolRenderResultOptions, theme: Theme, args?: Static<TParams>) => Component; describeCall?: (args: Static<TParams>, options: ToolRenderResultOptions) => NativeToolView | undefined; describeResult?: (result: AgentToolResult<TDetails>, options: ToolRenderResultOptions, args?: Static<TParams>) => NativeToolView | undefined; }
```

```ts
// from: dist/types/extensibility/extensions/types.d.ts:972 (registerTool)
 registerTool<TParams extends TSchema = TSchema, TDetails = unknown>(tool: ToolDefinition<TParams, TDetails>): void;
```
```ts
// from: dist/types/extensibility/extensions/types.d.ts (ExtensionAPI members):912-1157 (members, verbatim; wrapped signatures joined)
 logger: typeof PiLogger;
 typebox: typeof TypeBox;
 arktype: typeof ArkType;
 zod: typeof zod;
 pi: typeof PiCodingAgent;
 registerTool<TParams extends TSchema = TSchema, TDetails = unknown>(tool: ToolDefinition<TParams, TDetails>): void;
 registerFileWriteFallback(handler: FileWriteFallbackHandler): void;
```

```ts
// from: dist/types/extensibility/extensions/types.d.ts:923-970 (the ExtensionAPI on(...) overload set, verbatim)

 on(event: "resources_discover", handler: ExtensionHandler<ResourcesDiscoverEvent, ResourcesDiscoverResult>): void;
 on(event: "session_start", handler: ExtensionHandler<SessionStartEvent>): void;
 on(event: "session_before_switch", handler: ExtensionHandler<SessionBeforeSwitchEvent, SessionBeforeSwitchResult>): void;
 on(event: "session_switch", handler: ExtensionHandler<SessionSwitchEvent>): void;
 on(event: "session_before_branch", handler: ExtensionHandler<SessionBeforeBranchEvent, SessionBeforeBranchResult>): void;
 on(event: "session_branch", handler: ExtensionHandler<SessionBranchEvent>): void;
 on(event: "session_before_compact", handler: ExtensionHandler<SessionBeforeCompactEvent, SessionBeforeCompactResult>): void;
 on(event: "session.compacting", handler: ExtensionHandler<SessionCompactingEvent, SessionCompactingResult>): void;
 on(event: "cache_warming_decision", handler: ExtensionHandler<CacheWarmingDecisionEvent, CacheWarmingDecisionEventResult>): void;
 on(event: "session_compact", handler: ExtensionHandler<SessionCompactEvent>): void;
 on(event: "session_shutdown", handler: ExtensionHandler<SessionShutdownEvent>): void;
 on(event: "session_before_tree", handler: ExtensionHandler<SessionBeforeTreeEvent, SessionBeforeTreeResult>): void;
 on(event: "session_tree", handler: ExtensionHandler<SessionTreeEvent>): void;
 on(event: "context", handler: ExtensionHandler<ContextEvent, ContextEventResult>): void;
 on(event: "before_provider_request", handler: ExtensionHandler<BeforeProviderRequestEvent, BeforeProviderRequestEventResult>): void;
 on(event: "after_provider_response", handler: ExtensionHandler<AfterProviderResponseEvent>): void;
 on(event: "before_agent_start", handler: ExtensionHandler<BeforeAgentStartEvent, BeforeAgentStartEventResult>): void;
 on(event: "before_subagent_spawn", handler: ExtensionHandler<BeforeSubagentSpawnEvent, BeforeSubagentSpawnEventResult>): void;
 on(event: "agent_start", handler: ExtensionHandler<AgentStartEvent>): void;
 on(event: "agent_end", handler: ExtensionHandler<AgentEndEvent>): void;
 on(event: "session_stop", handler: ExtensionHandler<SessionStopEvent, SessionStopEventResult>): void;
 on(event: "turn_start", handler: ExtensionHandler<TurnStartEvent>): void;
 on(event: "turn_end", handler: ExtensionHandler<TurnEndEvent>): void;
 on(event: "message_start", handler: ExtensionHandler<MessageStartEvent>): void;
 on(event: "message_update", handler: ExtensionHandler<MessageUpdateEvent>): void;
 on(event: "message_end", handler: ExtensionHandler<MessageEndEvent>): void;
 on(event: "assistant_message", handler: ExtensionHandler<AssistantMessageRewriteEvent, AssistantMessageRewriteResult>): void;
 on(event: "tool_execution_start", handler: ExtensionHandler<ToolExecutionStartEvent>): void;
 on(event: "tool_execution_update", handler: ExtensionHandler<ToolExecutionUpdateEvent>): void;
 on(event: "tool_execution_end", handler: ExtensionHandler<ToolExecutionEndEvent>): void;
 on(event: "auto_compaction_start", handler: ExtensionHandler<AutoCompactionStartEvent>): void;
 on(event: "auto_compaction_end", handler: ExtensionHandler<AutoCompactionEndEvent>): void;
 on(event: "auto_retry_start", handler: ExtensionHandler<AutoRetryStartEvent>): void;
 on(event: "auto_retry_end", handler: ExtensionHandler<AutoRetryEndEvent>): void;
 on(event: "retry_fallback_applied", handler: ExtensionHandler<RetryFallbackAppliedEvent>): void;
 on(event: "retry_fallback_succeeded", handler: ExtensionHandler<RetryFallbackSucceededEvent>): void;
 on(event: "ttsr_triggered", handler: ExtensionHandler<TtsrTriggeredEvent>): void;
 on(event: "todo_reminder", handler: ExtensionHandler<TodoReminderEvent>): void;
 on(event: "goal_updated", handler: ExtensionHandler<GoalUpdatedEvent>): void;
 on(event: "credential_disabled", handler: ExtensionHandler<CredentialDisabledEvent>): void;
 on(event: "input", handler: ExtensionHandler<InputEvent, InputEventResult>): void;
 on(event: "tool_approval_requested", handler: ExtensionHandler<ToolApprovalRequestedEvent>): void;
 on(event: "tool_approval_resolved", handler: ExtensionHandler<ToolApprovalResolvedEvent>): void;
 on(event: "tool_call", handler: ExtensionHandler<ToolCallEvent, ToolCallEventResult>): void;
 on(event: "tool_result", handler: ExtensionHandler<ToolResultEvent, ToolResultEventResult>): void;
 on(event: "user_bash", handler: ExtensionHandler<UserBashEvent, UserBashEventResult>): void;
 on(event: "user_python", handler: ExtensionHandler<UserPythonEvent, UserPythonEventResult>): void;
 on(event: "mcp_notification", handler: ExtensionHandler<McpNotificationEvent>): void;
```
```ts
// from: dist/types/extensibility/extensions/types.d.ts:904 (ExtensionHandler), :1238 (ExtensionFactory)
export type ExtensionHandler<E, R = undefined> = (event: E, ctx: ExtensionContext) => Promise<R | void> | R | void;
export type ExtensionFactory = (pi: ExtensionAPI) => void | Promise<void>;
```

```ts
// from: COREROOT/dist/types/types.d.ts:888-940 (AgentToolResult, update callback, ToolTier/ToolLoadMode/ToolApproval)
export interface AgentToolResult<T = any, _TInput = unknown> { content: (TextContent | ImageContent)[]; details?: T; isError?: boolean; providerMetadata?: ToolResultProviderMetadata; useless?: boolean; }
export type AgentToolUpdateCallback<T = any, TInput = unknown> = (partialResult: AgentToolResult<T, TInput>) => void;
export interface RenderResultOptions { expanded: boolean; isPartial: boolean; spinnerFrame?: number; }
export type ToolTier = "read" | "write" | "exec";
export type ToolLoadMode = "essential" | "discoverable";
export type ToolApprovalDecision = ToolTier | { tier: ToolTier; reason?: string; override?: boolean; policy?: "allow" | "deny" | "prompt"; policyKey?: string; };
export type ToolApproval = ToolApprovalDecision | ((args: unknown) => ToolApprovalDecision);
```

```ts
// from: dist/types/extensibility/extensions/types.d.ts:438-460, :529-545 (render options, tool session event, ToolInfo, SourceInfo)
export interface ToolRenderResultOptions { expanded: boolean; isPartial: boolean; spinnerFrame?: number; }
export interface ToolSessionEvent { reason: "start" | "switch" | "branch" | "tree" | "shutdown"; previousSessionFile: string | undefined; }
export interface ToolShellEnvironmentContext { command: string; cwd: string; env: Record<string, string | undefined>; }
export type ToolShellEnvironmentHook = (context: ToolShellEnvironmentContext) => Record<string, string> | undefined;
export interface SourceInfo { path: string; source: string; scope: SourceScope; origin: SourceOrigin; baseDir?: string; }
export interface ToolInfo { name: string; description: string; parameters: TSchema; promptGuidelines?: string[]; sourceInfo: SourceInfo; }
```

```ts
// from: dist/types/extensibility/extensions/runner.d.ts:210-211 (getUIContext / hasUI)
 getUIContext(): ExtensionUIContext;
 hasUI(): boolean;
```

## B. '@oh-my-pi/pi-utils/worker-host'

```ts
// from: UTILSROOT/dist/types/worker-host.d.ts:1-51 (complete module)
export declare const WORKER_HOST_SELECTOR_PREFIX = "__omp_worker_";
export declare function isWorkerHostSelector(value: string | undefined): value is string;
export declare function declareWorkerHostEntry(): void;
export declare function workerHostEntry(): string | null;
export interface WorkerInbox { bind(handler: (message: unknown) => void): () => void; }
interface MessageListenerPort { on(event: "message", listener: (value: unknown) => void): unknown; }
export declare function installWorkerInbox(port: MessageListenerPort): WorkerInbox;
export declare function consumeWorkerInbox(): WorkerInbox | null;
export {};
```

`parentPort`: **NOT FOUND**. The module exports no such symbol — grep for `parentPort` over `UTILSROOT/dist/types/worker-host.d.ts` and `UTILSROOT/src/worker-host.ts` matched only doc comments and the un-exported `MessageListenerPort` interface. Full export list of `UTILSROOT/src/worker-host.ts`: `WORKER_HOST_SELECTOR_PREFIX:4`, `isWorkerHostSelector:7`, `declareWorkerHostEntry:22`, `workerHostEntry:27`, `WorkerInbox:52`, `installWorkerInbox:70`, `consumeWorkerInbox:96`.

## C. '@oh-my-pi/pi-utils/dirs'

```ts
// from: UTILSROOT/dist/types/dirs.d.ts (the nine requested helpers, with their source lines)
export declare const VERSION: string;
export declare function getBaseConfigRoot(): string;
export declare function getConfigRootDir(): string;
export declare function getAgentDir(): string;
export declare function getLogsDir(): string;
export declare function getPluginsDir(home?: string): string;
export declare function getWorktreesDir(): string;
export declare function getPythonEnvDir(): string;
export declare function getBrowserRelayDir(): string;
export declare function getNativesDir(): string;
export declare function getSessionsDir(agentDir?: string): string;
```

## D. '@oh-my-pi/pi-coding-agent/cli'

```ts
// from: dist/types/cli.d.ts:1-3 (entire file); runtime module PKGROOT/src/cli.ts; bin is {"omp": "dist/cli.js"}
#!/usr/bin/env bun
export declare function runCli(argv: string[]): Promise<void>;
```

## E. '@oh-my-pi/pi-tui/theme' — the theme singleton API

```ts
// from: TUIROOT/dist/types/theme/theme.d.ts:1-143 (complete module)
import type { Terminal } from "../terminal.js";
import { type ThemeColor } from "./schema.js";
import type { SymbolPreset } from "./symbols.js";
import type { Theme } from "./theme-class.js";
export { getAvailableThemes, getAvailableThemesWithPaths, getThemeByName, type ThemeInfo } from "./loader.js";
export { isValidThemeColor, type ThemeBg, type ThemeColor } from "./schema.js";
export { getAvailableSymbolPresets, isValidSymbolPreset, type SpinnerType, type SymbolKey, type SymbolPreset, } from "./symbols.js";
export { Theme } from "./theme-class.js";
export { createHighlightStream, getEditorTheme, getMarkdownTheme, getSelectListTheme, getSettingsListTheme, getSymbolTheme, highlightCode, setMarkdownMermaidRendering, warmHighlighter, } from "./tui-adapters.js";
export declare var theme: Theme;
type ThemeBinding = (value: Theme) => void;
export declare function bindTheme(binding: ThemeBinding): () => void;
export declare function getCurrentThemeName(): string | undefined;
export declare function fgOrPlain(color: ThemeColor, text: string, styledText?: string): string;
export interface ThemeChangeEvent { ephemeral?: boolean; }
export declare function initThemeSync(symbolPreset?: SymbolPreset, colorBlindMode?: boolean, darkTheme?: string, lightTheme?: string): void;
export declare function ensureThemeSync(): void;
export declare function ensureTheme(): Promise<void>;
export declare function initTheme(enableWatcher?: boolean, symbolPreset?: SymbolPreset, colorBlindMode?: boolean, darkTheme?: string, lightTheme?: string): Promise<void>;
export declare function setTheme(name: string, enableWatcher?: boolean): Promise<{ success: boolean; error?: string; }>;
export declare function previewTheme(name: string, event?: ThemeChangeEvent): Promise<{ success: boolean; error?: string; }>;
export declare function enableAutoTheme(event?: ThemeChangeEvent): void;
export declare function setAutoThemeMapping(mode: "dark" | "light", themeName: string): void;
export declare function onTerminalAppearanceChange(mode: "dark" | "light", event?: ThemeChangeEvent): void;
export declare function setThemeInstance(themeInstance: Theme): void;
export declare function setSymbolPreset(preset: SymbolPreset): Promise<void>;
export declare function getSymbolPresetOverride(): SymbolPreset | undefined;
export declare function setNativeSymbolPreset(preset: SymbolPreset | undefined): boolean;
export declare function setColorBlindMode(enabled: boolean): Promise<void>;
export declare function getColorBlindMode(): boolean;
export declare function onThemeChange(callback: (event: ThemeChangeEvent) => void): () => void;
export declare function getThemeEpoch(): number;
type MacOSAppearanceReprobeTerminal = Pick<Terminal, "appearance" | "onAppearanceChange" | "onAppearanceReport" | "onPrivateModeReport" | "refreshAppearance">;
export declare function startMacOSAppearanceReprobeFallback(terminal: MacOSAppearanceReprobeTerminal): () => void;
export declare function stopThemeWatcher(): void;
export declare function getResolvedThemeColors(themeName?: string): Promise<Record<string, string>>;
export type NativeThemeVariant = Record<string, string>;
export interface NativeThemePalette { dark?: NativeThemeVariant; light?: NativeThemeVariant; name: { dark?: string; light?: string; }; }
export declare function getNativeThemePaletteKey(): string;
export declare function getNativeThemePalette(): NativeThemePalette;
export declare function isLightTheme(themeName?: string): boolean;
export declare function getThemeExportColors(themeName?: string): Promise<{ pageBg?: string; cardBg?: string; infoBg?: string; }>;
```

```ts
// from: TUIROOT/dist/types/theme/theme-class.d.ts (the Theme instance the singleton is bound to):6-300 (members, verbatim; wrapped signatures joined)
 get isLight(): boolean;
 get accentSurfaceLuminance(): number | undefined;
 getColorHex(color: ThemeColor): string;
 getBgHex(color: ThemeBg): string;
 getAllThemeColorHexes(): string[];
 getMajorThemeColorHexes(): string[];
 getAccentColorHex(): string;
 get sessionAccentInputs(): SessionAccentTheme;
 fg(color: ThemeColor, text: string): string;
 fgResolved(color: ThemeColor, text: string): string;
 bg(color: ThemeBg, text: string): string;
 bgFill(color: ThemeBg, text: string): string;
 fgOnBg(color: ThemeColor, background: ThemeBg, text: string): string;
 bold(text: string): string;
 italic(text: string): string;
 underline(text: string): string;
 strikethrough(text: string): string;
 inverse(text: string): string;
 getFgAnsi(color: ThemeColor): string;
 getBgAnsi(color: ThemeBg): string;
 getFgOnBgAnsi(color: ThemeColor, background: ThemeBg): string;
 getContrastFgAnsi(fillColor: ThemeColor): string;
 getColorMode(): ColorMode;
 getThinkingBorderColor(level: string): (str: string) => string;
 getBashModeBorderColor(): (str: string) => string;
 getPythonModeBorderColor(): (str: string) => string;
 symbol(key: SymbolKey): string;
 styledSymbol(key: SymbolKey, color: ThemeColor): string;
 getSymbolPreset(): SymbolPreset;
 get status(): { success: string; error: string; warning: string; info: string; pending: string; disabled: string; enabled: string; running: string; shadowed: string; aborted: string; done: string; };
 get nav(): { cursor: string; selected: string; expand: string; collapse: string; back: string; };
 get tree(): { branch: string; last: string; vertical: string; horizontal: string; hook: string; };
 get progress(): { filled: string; empty: string; };
 get boxRound(): { topLeft: string; topRight: string; bottomLeft: string; bottomRight: string; horizontal: string; vertical: string; cross: string; teeDown: string; teeUp: string; teeRight: string; teeLeft: string; };
 get boxDotted(): { horizontal: string; vertical: string; };
 get boxSharp(): { topLeft: string; topRight: string; bottomLeft: string; bottomRight: string; horizontal: string; vertical: string; cross: string; teeDown: string; teeUp: string; teeRight: string; teeLeft: string; };
 get sep(): { powerline: string; powerlineThin: string; powerlineLeft: string; powerlineRight: string; powerlineThinLeft: string; powerlineThinRight: string; powerlineCapLeft: string; block: string; space: string; asciiLeft: string; asciiRight: string; dot: string; slash: string; pipe: string; };
 get icon(): { model: string; plan: string; prewalk: string; goal: string; pause: string; loop: string; folder: string; worktree: string; scratchFolder: string; file: string; git: string; branch: string; pr: string; pin: string; tokens: string; context: string; cost: string; subscription: string; advisor: string; advisorClosed: string; time: string; omp: string; ghost: string; agents: string; job: string; cache: string; cacheMiss: string; input: string; output: string; throughput: string; host: string; session: string; package: string; warning: string; rewind: string; auto: string; fast: string; extensionSkill: string; extensionTool: string; extensionSlashCommand: string; extensionMcp: string; extensionRule: string; extensionHook: string; extensionPrompt: string; extensionContextFile: string; extensionInstruction: string; vimNormal: string; vimInsert: string; vimVisual: string; vimVisualLine: string; mic: string; camera: string; };
 get cmd(): Record<SlashCommandIconName, string>;
 get thinking(): { minimal: string; low: string; medium: string; high: string; xhigh: string; max: string; autoPending: string; };
 get checkbox(): { checked: string; unchecked: string; };
 get radio(): { selected: string; unselected: string; };
 get format(): { bullet: string; dash: string; bracketLeft: string; bracketRight: string; };
 get md(): { quoteBorder: string; hrChar: string; bullet: string; colorSwatch: string; };
 get spinnerFrames(): string[];
 getSpinnerFrames(type?: SpinnerType): string[];
 getLangIcon(lang: string | undefined): string;
 getLangIconStyled(lang: string | undefined): string;
```

## F. '@oh-my-pi/pi-tui/overlays/session-observer-registry'

```ts
// from: TUIROOT/dist/types/overlays/session-observer-registry.d.ts:1-77 (complete module)
import type { AgentProgress, AgentSource } from "../tools/task.js";
export declare const TASK_SUBAGENT_PROGRESS_CHANNEL = "task:subagent:progress";
export declare const TASK_SUBAGENT_LIFECYCLE_CHANNEL = "task:subagent:lifecycle";
export interface SubagentProgressPayload { index: number; agent: string; agentSource: AgentSource; task: string; parentToolCallId?: string; assignment?: string; progress: AgentProgress; sessionFile?: string; detached?: boolean; }
export interface SubagentLifecyclePayload { id: string; agent: string; agentSource: AgentSource; description?: string; status: "started" | "completed" | "failed" | "aborted"; sessionFile?: string; parentToolCallId?: string; index: number; detached?: boolean; }
export interface EventBusLike { on(channel: string, listener: (data: unknown) => void): () => void; }
export interface ObservableSession { id: string; kind: "main" | "subagent"; label: string; agent?: string; description?: string; status: "active" | "completed" | "failed" | "aborted"; sessionFile?: string; parentToolCallId?: string; detached?: boolean; index?: number; lastUpdate: number; progress?: AgentProgress; }
export type SessionObserverChangeKind = "main" | "reset" | "lifecycle" | "progress";
export declare class SessionObserverRegistry { #private; onChange(cb: (kind: SessionObserverChangeKind) => void): () => void; setMainSession(sessionFile?: string): void; getSession(id: string): ObservableSession | undefined; getSessions(): ObservableSession[]; getActiveSubagentCount(): number; resetSessions(): void; dispose(): void; subscribeToEventBus(eventBus: EventBusLike, subagentEventBus: EventBusLike): void; }
```

## G. '@oh-my-pi/pi-ai/providers/mock'

```ts
// from: AIROOT/dist/types/providers/mock.d.ts:44-184 (complete module)
import type { AnthropicFallbackCreditHandle, Api, Context, Model, SimpleStreamOptions, StopDetails, StopReason, Usage } from "../types.js";
import { AssistantMessageEventStream } from "../utils/event-stream.js";
export declare const MOCK_API: "mock";
export type MockApi = typeof MOCK_API;
export type MockContent = string | { type: "text"; text: string; } | { type: "thinking"; thinking: string; thinkingSignature?: string; } | { type: "toolCall"; id?: string; name: string; arguments: Record<string, unknown> | string; };
export interface MockResponse { content?: ReadonlyArray<MockContent>; stopReason?: StopReason; stopDetails?: StopDetails | null; fallbackCreditHandle?: AnthropicFallbackCreditHandle; errorMessage?: string; usage?: Partial<Omit<Usage, "cost">> & { cost?: Partial<Usage["cost"]>; }; responseId?: string; throw?: string | Error; delayMs?: number; responseHeaders?: Readonly<Record<string, string>>; responseStatus?: number; responseRequestId?: string; }
export type MockHandler = MockResponse | ((context: Context, options?: SimpleStreamOptions) => MockResponse | Promise<MockResponse>);
export type MockResponseSource = Iterable<MockHandler> | AsyncIterable<MockHandler>;
export interface MockCall { readonly context: Context; readonly options?: SimpleStreamOptions; }
export interface MockModelOptions { id?: string; provider?: string; baseUrl?: string; responses?: MockResponseSource; handler?: MockHandler; cost?: Model["cost"]; contextWindow?: number; maxTokens?: number; reasoning?: boolean; }
export declare class MockModel implements Model<MockApi> { readonly id: string; readonly name: string; readonly api: MockApi; readonly provider: string; readonly baseUrl: string; readonly reasoning: boolean; readonly input: ("text" | "image")[]; readonly cost: Model["cost"]; readonly contextWindow: number; readonly maxTokens: number; readonly compat: undefined; readonly identity: Model["identity"]; readonly calls: MockCall[]; iterator?: Iterator<MockHandler> | AsyncIterator<MockHandler>; exhausted: boolean; readonly extras: MockHandler[]; fallback?: MockHandler; toolCallCounter: number; constructor(options?: MockModelOptions); get model(): this; stream: (_model: Model<Api>, context: Context, options?: SimpleStreamOptions) => AssistantMessageEventStream; push(response: MockHandler): void; reset(): void; }
export declare function isMockModel(model: Model<Api>): model is MockModel;
export declare function createMockModel(options?: MockModelOptions): MockModel;
export declare function streamMock(model: Model<Api>, context: Context, options?: SimpleStreamOptions): AssistantMessageEventStream;
export declare function registerMockApi(sourceId?: string): void;
```

## H. '@oh-my-pi/pi-coding-agent/extensibility/extensions/types'

```ts
// from: dist/types/extensibility/extensions/types.d.ts:55-64
export interface ExtensionUISelectOption { label: string; description?: string; }
export type ExtensionUISelectItem = string | ExtensionUISelectOption;
import type { ExtensionAskDialogQuestion, ExtensionAskDialogResult, ExtensionAskDialogSubmitResult } from "@oh-my-pi/pi-tui/overlays/ask-dialog";
export type { ExtensionAskDialogOption, ExtensionAskDialogQuestion, ExtensionAskDialogResultItem, ExtensionAskDialogSubmitResult, ExtensionAskDialogChatResult, ExtensionAskDialogResult, } from "@oh-my-pi/pi-tui/overlays/ask-dialog";
export declare function getExtensionUISelectOptionLabel(option: ExtensionUISelectItem): string;
export declare function timedOutAskDialogResult(questions: ExtensionAskDialogQuestion[]): ExtensionAskDialogSubmitResult;
```

Import specifier: `@oh-my-pi/pi-coding-agent/extensibility/extensions/types` (also re-exported by `.../extensibility/extensions` and, type-only, by the root: `dist/types/index.d.ts:17-18`).

## I. '@oh-my-pi/pi-coding-agent/config/all-settings'

```ts
// from: dist/types/config/all-settings.d.ts (entire file, 8 lines)
import { type AnySetting } from "./registry.js";
export declare function orderedSettings(): readonly AnySetting[];
```

Side effect: the module declares only `orderedSettings()`; importing it pulls in every settings-domain module (`PKGROOT/src/config/all-settings.ts`), each of which registers its settings as a top-level side effect. `Settings` depends on it — `dist/types/config/settings.d.ts:17` is the bare `import "./all-settings.js";` — so any `Settings` instance implies every setting id is registered (e.g. `enabledProviders` at `PKGROOT/src/config/model-settings.ts:71`, `disabledProviders` at `:78`).

## J. ExtensionUIContext — every member

```ts
// from: dist/types/extensibility/extensions/types.d.ts:55-59 and :68-206
export interface ExtensionUISelectOption { label: string; description?: string; }
export type ExtensionUISelectItem = string | ExtensionUISelectOption;
export interface ExtensionUIDialogOptions { signal?: AbortSignal; timeout?: number; onTimeout?: () => void; onTimeoutStart?: () => void; onTimeoutReset?: () => void; initialIndex?: number; outline?: boolean; onLeft?: () => void; onRight?: () => void; onExternalEditor?: () => void; helpText?: string; selectionMarker?: "radio" | "checkbox"; checkedIndices?: readonly number[]; markableCount?: number; acceptImages?: boolean; }
export type TerminalInputHandler = (data: string) => { consume?: boolean; data?: string; } | undefined;
export type WidgetPlacement = "aboveEditor" | "belowEditor";
export interface ExtensionWidgetOptions { placement?: WidgetPlacement; }
export interface ExtensionCustomOptions { overlay?: boolean; overlayOptions?: OverlayOptions | (() => OverlayOptions); onHandle?: (handle: OverlayHandle) => void; signal?: AbortSignal; }
export type AutocompleteProviderFactory = (current: AutocompleteProvider) => AutocompleteProvider;
export interface ExtensionUIContext { timeoutStartsOnPresentation?: boolean; select(title: string, options: ExtensionUISelectItem[], dialogOptions?: ExtensionUIDialogOptions): Promise<string | undefined>; confirm(title: string, message: string, dialogOptions?: ExtensionUIDialogOptions): Promise<boolean>; input(title: string, placeholder?: string, dialogOptions?: ExtensionUIDialogOptions): Promise<string | undefined>; askDialog?(questions: ExtensionAskDialogQuestion[], dialogOptions?: ExtensionUIDialogOptions): Promise<ExtensionAskDialogResult | undefined>; notify(message: string, type?: "info" | "warning" | "error"): void; onTerminalInput(handler: TerminalInputHandler): () => void; setStatus(key: string, text: string | undefined): void; setWorkingMessage(message?: string): void; setWidget(key: string, content: ExtensionWidgetContent, options?: ExtensionWidgetOptions): void; setFooter(factory: ExtensionUiComponentFactory | undefined): void; setHeader(factory: ExtensionUiComponentFactory | undefined): void; setTitle(title: string): void; custom<T>(factory: (tui: TUI, theme: Theme, keybindings: KeybindingsManager, done: (result: T) => void) => ExtensionUiComponent | Promise<ExtensionUiComponent>, options?: ExtensionCustomOptions): Promise<T>; setEditorText(text: string): void; pasteToEditor(text: string): void; getEditorText(): string; editor(title: string, prefill?: string, dialogOptions?: ExtensionUIDialogOptions, editorOptions?: { promptStyle?: boolean; }): Promise<string | undefined>; addAutocompleteProvider(factory: AutocompleteProviderFactory): void; setEditorComponent(factory: ((tui: TUI, theme: EditorTheme, keybindings: KeybindingsManager) => CustomEditor) | undefined): void; readonly theme: Theme; getAllThemes(): Promise<{ name: string; path: string | undefined; }[]>; getTheme(name: string): Promise<Theme | undefined>; setTheme(theme: string | Theme): Promise<{ success: boolean; error?: string; }>; getToolsExpanded(): boolean; setToolsExpanded(expanded: boolean): void; }
```

`timeoutStartsOnPresentation?` and `askDialog?` are the only optional members; every other member is required. `Theme` / `TUI` / `EditorTheme` / `KeybindingsManager` / `CustomEditor` / `OverlayHandle` / `OverlayOptions` / `ExtensionUiComponent*` / `ExtensionWidgetContent` / `AutocompleteProvider` come from `@oh-my-pi/pi-tui` (imports at types.d.ts:10-11,20,22,33,35,51-52); `ExtensionAskDialog*` comes from `@oh-my-pi/pi-tui/overlays/ask-dialog` and is re-exported at types.d.ts:61.

## K. Approval machinery

`APPROVAL_MODE_MAX_TIER`: **module-private constant, NOT exported** (absent from `dist/types/tools/approval.d.ts`; grep over PKGROOT/src and PKGROOT/dist/types matched only the source lines shown below). `TIER_RANK` is its exported counterpart.

```ts
// from: PKGROOT/src/tools/approval.ts:99-124, :340-387
export const TIER_RANK: Readonly<Record<ToolTier, number>> = { read: 0, write: 1, exec: 2, };
export function strictestApproval(decisions: Iterable<ToolApprovalDecision>): ToolApprovalDecision { let tier: ToolTier = "read"; for (const decision of decisions) { if (typeof decision !== "string" && decision.policy === "deny") return decision; const decisionTier = typeof decision === "string" ? decision : decision.tier; if (TIER_RANK[decisionTier] > TIER_RANK[tier]) tier = decisionTier; } return tier; }
const APPROVAL_MODE_MAX_TIER: Record<ApprovalMode, ToolTier> = { "always-ask": "read", write: "write", yolo: "exec", };
export function requiresApproval(tool: ApprovalSubject, args: unknown, mode: ApprovalMode, userConfig: Record<string, unknown> = {},): { required: boolean; reason?: string } { const resolved = resolveApproval(tool, args, mode, userConfig); const { policy, reason } = resolved; if (policy === "deny") { throw denyError(resolved, tool.name); } if (policy === "prompt") return { required: true, reason }; return { required: false }; }
export function truncateForPrompt(value: string, maxChars = DEFAULT_PROMPT_TRUNCATE_CHARS): string { if (value.length <= maxChars) return value; const omitted = value.length - maxChars; return `${value.slice(0, maxChars)}[…${omitted}ch elided…]`; }
export function formatApprovalPrompt(tool: ApprovalSubject, args: unknown, reason?: string): string { const lines = [`Allow tool: ${tool.name}`]; if (tool.name.startsWith("mcp__") && tool.approval === undefined) { lines.push("Origin: MCP server tool"); } if (reason) { lines.push(`Reason: ${reason}`); } const details = tool.formatApprovalDetails?.(args); if (typeof details === "string") { if (details.length > 0) lines.push(details); } else if (Array.isArray(details)) { for (const detail of details) { if (detail.length > 0) lines.push(detail); } } return lines.join("\n"); }
```
```ts
// from: dist/types/tools/approval.d.ts:1-108 — import specifier "@oh-my-pi/pi-coding-agent/tools/approval"
import type { AgentTool, ToolApprovalDecision, ToolTier } from "@oh-my-pi/pi-agent-core";
import type { Settings } from "../config/settings.js";
export type { ToolApproval, ToolApprovalDecision, ToolTier } from "@oh-my-pi/pi-agent-core";
export type ApprovalPolicy = "allow" | "deny" | "prompt";
export type ApprovalMode = "always-ask" | "write" | "yolo";
export type ApprovalContextSource = { autoApprove?: boolean; settings?: Settings; };
export interface ResolvedExecuteTimeApproval { approvalMode: ApprovalMode; userPolicies: Record<string, unknown>; }
type ApprovalSubject = Pick<AgentTool, "name" | "approval" | "formatApprovalDetails"> & { readonly legacyName?: string; };
export declare function resolveApprovalFromContext(context?: ApprovalContextSource | null): ResolvedExecuteTimeApproval;
export interface ResolvedApproval { policy: ApprovalPolicy; tier: ToolTier; reason?: string; override: boolean; source?: "tool" | "user" | "mode"; policyKey?: string; }
export declare const TIER_RANK: Readonly<Record<ToolTier, number>>;
export declare function strictestApproval(decisions: Iterable<ToolApprovalDecision>): ToolApprovalDecision;
export declare function resolveToolTier(tool: ApprovalSubject, args: unknown): ToolTier;
export declare function resolveApproval(tool: ApprovalSubject, args: unknown, mode: ApprovalMode, userConfig?: Record<string, unknown>): ResolvedApproval;
export declare function denyError(resolved: ResolvedApproval, toolName: string): Error;
export declare function requiresApproval(tool: ApprovalSubject, args: unknown, mode: ApprovalMode, userConfig?: Record<string, unknown>): { required: boolean; reason?: string; };
export declare function truncateForPrompt(value: string, maxChars?: number): string;
export declare function formatApprovalPrompt(tool: ApprovalSubject, args: unknown, reason?: string): string;
```

How the approval dialog reaches `uiContext.select` (`Allow tool:`):

```ts
// from: PKGROOT/src/extensibility/extensions/wrapper.ts:373-412
 if (!this.runner.hasUI()) { const reason = "no interactive UI available"; await emitApprovalResolved(false, reason); cancelPreflight(); if (pendingSafetyChecks.length > 0) { throw new Error(`Tool "${this.tool.name}" has pending provider safety checks but no interactive UI is available.`,); } throw new Error(`Tool "${this.tool.name}" requires approval but no interactive UI available.\n` + `Options:\n` + ` 1. Set tools.approvalMode: yolo in /settings\n` + ` 2. Add tools.approval.${this.tool.name}: allow to config\n` + ` 3. Use an interactive UI to approve the tool call`,); }
 const uiContext = this.runner.getUIContext();
 const basePrompt = formatApprovalPrompt(this.tool, resolvedArgs, approvalCheck.reason);
 const safetyPrompt =
 pendingSafetyChecks.length > 0
 ? `${basePrompt}\nProvider safety checks:\n${safetyCheckLines(pendingSafetyChecks).join("\n")}`
 : basePrompt;
 let choice: string | undefined;
 try { choice = await uiContext.select(safetyPrompt, ["Approve", "Deny"]); } catch (err) { await emitApprovalResolved(false, err instanceof Error ? err.message : "approval aborted"); cancelPreflight(); throw err; }
 const approved = choice === "Approve";
 await emitApprovalResolved(approved, approved ? undefined : "denied by user");
 if (!approved) { cancelPreflight(); throw new Error(`Tool call denied by user: ${this.tool.name}`); }
```
```ts
// from: PKGROOT/src/eval/preludes.ts:105-115
 throw new Error(`Eval prelude "${definition.name}" requires approval but no interactive UI is available.\n` + `Set tools.approval.${definition.name}: allow or use an interactive UI to approve the call.`,);
	}
	const choice = await untilAborted(context.signal, () => ui.select(formatApprovalPrompt(subject, parameters, resolved.reason), ["Approve", "Deny"]),);
	if (choice !== "Approve") throw new Error(`Eval prelude call denied by user: ${definition.name}`);
}
```

Compiled proof: `grep 'Allow tool:' PKGROOT/dist/cli.js` yields a single match on line 2198; the minified formatter is `t$e` there and the eval-prelude caller is `uzo`. The emitted text is `Allow tool: <toolName>`, then `Origin: MCP server tool` for an `mcp__*` tool whose `approval` is undefined, then `Reason: <reason>`, then the `formatApprovalDetails(args)` lines, joined with a newline; the caller awaits `uiContext.select(<that text>, ["Approve", "Deny"])`.

Approval events around the dialog (`dist/types/extensibility/extensions/types.d.ts:723,:731`):

```ts
// from: dist/types/extensibility/extensions/types.d.ts:723-738
export interface ToolApprovalRequestedEvent { type: "tool_approval_requested"; sessionId: string; toolCallId: string; toolName: string; reason?: string; approvalMode: ApprovalMode; }
export interface ToolApprovalResolvedEvent { type: "tool_approval_resolved"; sessionId: string; toolCallId: string; toolName: string; approved: boolean; reason?: string; }
```

## L. Discovery providers (src/discovery/*.ts) and the disable API

Provider ids — one `PROVIDER_ID` constant per discovery file (grepped from PKGROOT/src/discovery):

```
src/discovery/agent-plugins.ts:36   PROVIDER_ID = "agent-plugins"
src/discovery/agents-md.ts:13       PROVIDER_ID = "agents-md"
src/discovery/agents.ts:27          PROVIDER_ID = "agents"
src/discovery/builtin.ts:39         PROVIDER_ID = "native"
src/discovery/claude-md.ts:13       PROVIDER_ID = "claude-md"
src/discovery/claude-plugins.ts:32  PROVIDER_ID = "claude-plugins"
src/discovery/claude.ts:42          PROVIDER_ID = "claude"
src/discovery/cline.ts:15           PROVIDER_ID = "cline"
src/discovery/codex.ts:46           PROVIDER_ID = "codex"
src/discovery/cursor.ts:35          PROVIDER_ID = "cursor"
src/discovery/gemini.ts:39          PROVIDER_ID = "gemini"
src/discovery/github.ts:40          PROVIDER_ID = "github"
src/discovery/mcp-json.ts:17        PROVIDER_ID = "mcp-json"
src/discovery/omp-plugins.ts:43     PROVIDER_ID = "omp-plugins"
src/discovery/opencode.ts:47        PROVIDER_ID = "opencode"
src/discovery/skillshare.ts:27      export const SKILLSHARE_PROVIDER_ID = "skillshare"
src/discovery/ssh.ts:16             PROVIDER_ID = "ssh-json"
src/discovery/vscode.ts:14          PROVIDER_ID = "vscode"
src/discovery/windsurf.ts:29        PROVIDER_ID = "windsurf"
```

(`src/discovery/index.ts` additionally imports the capability domains in `src/capability/`: context-file, extension, extension-module, hook, instruction, mcp, prompt, rule, settings, skill, slash-command, ssh, system-prompt, tool — those register capabilities, not discovery providers.) The disable API is section A.2: `disableProvider(providerId)` / `enableProvider` / `isProviderEnabled` / `getDisabledProviders` / `setDisabledProviders` / `enableUserSource` / `disableUserSource`, imported from `@oh-my-pi/pi-coding-agent/capability` or `/discovery`. Persisted form: the settings ids `enabledProviders` and `disabledProviders` (PKGROOT/src/config/model-settings.ts:71,:78).

## M. buildSkillPromptMessage, tagImageAttachmentSource, SKILL_PROMPT_MESSAGE_TYPE

```ts
// from: dist/types/extensibility/skills.d.ts:77-81, :88-111
export interface BuiltSkillPromptMessage { message: string; details: SkillPromptDetails; }
export declare function getSkillSlashCommandName(skill: Pick<Skill, "name">): string;
export interface ParsedSkillInvocation { name: string; args: string; prompt: string; }
export declare function parseSkillInvocation(text: string): ParsedSkillInvocation | undefined;
export type SkillInvocationKind = "user" | "autoload";
export type SkillPromptInput = Pick<ParsedSkillInvocation, "args"> & Partial<Pick<ParsedSkillInvocation, "prompt">>;
export declare function buildSkillPromptMessage(skill: Pick<Skill, "name" | "filePath" | "baseDir">, input: SkillPromptInput, invocation?: SkillInvocationKind): Promise<BuiltSkillPromptMessage>;
```

`tagImageAttachmentSource`: **NOT FOUND** in `@oh-my-pi/pi-coding-agent` (searched PKGROOT/dist/types and PKGROOT/src recursively; the name appears only as call sites in `PKGROOT/src/modes/controllers/input-controller.ts:66,:2034,:2084`, which import it from pi-tui). It is exported by pi-tui:

```ts
// from: TUIROOT/dist/types/prompt/image-source.d.ts:9-27 — import specifier "@oh-my-pi/pi-tui/prompt/image-source"
import type { ImageContent } from "@oh-my-pi/pi-ai";
export type ImageAttachmentSourceKind = "image" | "video";
export interface ImageAttachmentSource { readonly path: string; readonly kind: ImageAttachmentSourceKind; }
declare const kImageAttachmentSource: unique symbol;
export type SourceTaggedImage = ImageContent & { readonly [kImageAttachmentSource]: ImageAttachmentSource; };
export declare function tagImageAttachmentSource(image: ImageContent, path: string, kind: ImageAttachmentSourceKind): SourceTaggedImage;
export declare function imageAttachmentSource(image: ImageContent): ImageAttachmentSource | undefined;
export {};
```

```ts
// from: TUIROOT/dist/types/chat/messages.d.ts:17 and :40-54 — import specifier "@oh-my-pi/pi-tui/chat/messages"
export declare const SKILL_PROMPT_MESSAGE_TYPE = "skill-prompt";
export interface SkillPromptDetails { name: string; path: string; args?: string; prompt?: string; lineCount: number; __queueChipText?: string; }
```

`SKILL_PROMPT_MESSAGE_TYPE` is re-exported by the coding agent at `dist/types/session/messages.d.ts:9` (`export { SKILL_PROMPT_MESSAGE_TYPE, LSP_LATE_DIAGNOSTIC_MESSAGE_TYPE, BACKGROUND_TAN_DISPATCH_MESSAGE_TYPE, PREWALK_PLAN_MESSAGE_TYPE, VIBE_MODE_CONTEXT_MESSAGE_TYPE, DEFAULT_CUSTOM_MESSAGE_TYPE, LIVE_DELEGATION_MESSAGE_TYPE, ... } from "@oh-my-pi/pi-tui/chat/messages"`) and therefore by the package root (`dist/types/index.d.ts:32` = `export * from "./session/messages.js"`). `SkillPromptDetails` is declared in pi-tui (`TUIROOT/dist/types/chat/messages.d.ts:40-54`, shown above) and re-exported here.

## N. Session files: location and .jsonl layout

Sessions root = `getSessionsDir(agentDir?)` = `<agentDir>/sessions`; agent dir default `~/.omp/agent` (overridable by `PI_CODING_AGENT_DIR` / XDG redirects). Verified on this machine: `C:/Users/<user>/.omp/agent/sessions` exists with the buckets `--D--xiaojianc-poietica--` and `--D--xiaojianc-poietica-packages-agent-bridge--`. No `*.jsonl` exists yet under `~/.omp` or the repo.

```ts
// from: UTILSROOT/dist/types/dirs.d.ts:285 (getSessionsDir)
export declare function getSessionsDir(agentDir?: string): string;
```
```ts
// from: PKGROOT/src/session/session-manager.ts:3796-3815 (session file name and header write)
	static createEmptySessionFile(cwd: string, storage: SessionStorage = new FileSessionStorage()): string { const sessionDir = SessionManager.getDefaultSessionDir(cwd, undefined, storage); const id = mintSessionId(); const timestamp = nowIso(); const header: SessionHeader = { type: "session", version: CURRENT_SESSION_VERSION, id, timestamp, cwd: path.resolve(cwd), }; const file = path.join(sessionDir, `${fileSafeTimestamp(timestamp)}_${id}.jsonl`); storage.writeTextSync(file, `${serializeTitleSlot({ updatedAt: timestamp })}${JSON.stringify(header)}\n`); return file; }
```
```ts
// from: PKGROOT/src/session/session-title-slot.ts:111-130 (fixed-width title slot)
export function serializeTitleSlot(options: SessionTitleUpdate): string { const title = truncateTitleForSlot(options.title ?? "", options.source, options.updatedAt); const unpadded = titleSlotLine(title, options.source, options.updatedAt, ""); const padBytes = SESSION_TITLE_SLOT_BYTES - byteLength(unpadded); if (padBytes < 0) throw new Error("Session title slot metadata exceeds fixed slot size"); const line = titleSlotLine(title, options.source, options.updatedAt, " ".repeat(padBytes)); if (byteLength(line) !== SESSION_TITLE_SLOT_BYTES) { throw new Error("Session title slot serialization failed to produce fixed-width output"); } return line; }
export function overlayTitleSlotContent(content: string, update: SessionTitleUpdate): string { const slot = Buffer.from(serializeTitleSlot(update), "utf-8"); const existing = Buffer.from(content, "utf-8"); if (existing.length <= slot.length) return slot.toString("utf-8"); return Buffer.concat([slot, existing.subarray(slot.length)]).toString("utf-8"); }
```
```ts
// from: PKGROOT/src/session/session-loader.ts:283-303 (first line peeled as the title slot)
 sink.append(chunk);
 if (!sawFirstLine) { const buffered = sink.flush()!; const newline = buffered.indexOf(0x0a); if (newline !== -1) { sawFirstLine = true; const firstLine = decoder.decode(buffered.subarray(0, newline)).trim(); if (firstLine) { const slot = parseTitleSlotLine(firstLine); if (slot) { titleSlot = titleUpdateFromSlot(slot); sink.consume(newline + 1); } } } }
```

Directory naming (PKGROOT/src/session/session-paths.ts): `encodeLegacyAbsoluteSessionDirName(cwd)` (:44) = `--` + cwd without its leading separator, with every `/`, backslash and `:` replaced by `-`, + `--` (so `D:\xiaojianc\poietica` becomes `--D--xiaojianc-poietica--`); `encodeRelativeSessionDirName(prefix, relative)` (:49) joins with `-` (prefix `-tmp` under the temp root, `-` under home); `getDefaultSessionDirName` (:76) checks the temp root first, then home-relative, else the absolute form; `computeDefaultSessionDir` (:212) = `path.join(sessionsRoot, encodedDirName)`. Artifacts live in a sibling directory named like the session file minus its `.jsonl` suffix (session-storage.ts:1146-1156).

```ts
// from: dist/types/session/session-entries.d.ts:6-19, :52-57
export declare const CURRENT_SESSION_VERSION = 3;
export declare const SESSION_TITLE_SLOT_BYTES = 256;
export declare const SESSION_TITLE_SLOT_ENTRY_TYPE = "title";
export declare const TITLE_CHANGE_ENTRY_TYPE = "title_change";
export type SessionTitleSource = "auto" | "user";
export interface SessionTitleSlotEntry { type: typeof SESSION_TITLE_SLOT_ENTRY_TYPE; v: 1; title: string; source?: SessionTitleSource; updatedAt: string; pad: string; }
export interface SessionEntryBase { type: string; id: string; parentId: string | null; timestamp: string; }
```

```ts
// from: dist/types/session/session-entries.d.ts:270-282
export type SessionEntry = SessionMessageEntry | ModelUsageEntry | ThinkingLevelChangeEntry | ModelChangeEntry | ServiceTierChangeEntry | CompactionEntry | BranchSummaryEntry | CustomEntry | CustomMessageEntry | LabelEntry | TitleChangeEntry | TtsrInjectionEntry | SessionInitEntry | ModeChangeEntry | CredentialPinEntry | ResetBoundaryEntry;
export type FileEntry = SessionHeader | SessionEntry;
export type RawFileEntry = SessionTitleSlotEntry | FileEntry;
export interface SessionTreeNode { entry: SessionEntry; children: SessionTreeNode[]; label?: string; }
```

Per-entry variants in dist/types/session/session-entries.d.ts (names + line numbers; all extend `SessionEntryBase` = `{ type: string; id: string; parentId: string | null; timestamp: string }`): `SessionMessageEntry:58`, `ModelUsageEntry:63`, `ThinkingLevelChangeEntry:75`, `ModelChangeEntry:85`, `ServiceTierChangeEntry:94`, `CompactionEntry:98`, `BranchSummaryEntry:123`, `ResetBoundaryEntry:140`, `CustomEntry:153`, `LabelEntry:159`, `TitleChangeEntry:165`, `TtsrInjectionEntry:180`, `CredentialPinEntry:195`, `SessionInitEntry:203`, `ModeChangeEntry:242`, `CustomMessageEntry:261`.

Physical format: one JSON object per line, UTF-8, newline-terminated (`SessionStorageWriter.append` requires the trailing newline — `dist/types/session/session-storage.d.ts:8-20`). The first physical line is the optional fixed-width 256-byte title slot; every later line is a typed entry. Concrete shape (from the types above and `createEmptySessionFile`; no live session file existed to quote):

```
{"type":"title","v":1,"title":"...","source":"user","updatedAt":"2026-10-05T01:44:55.000Z","pad":"   ...   "}
{"type":"session","version":3,"id":"<sessionId>","timestamp":"2026-10-05T01:44:55.000Z","cwd":"D:\\xiaojianc\\poietica"}
{"type":"message","id":"<entryId>","parentId":null,"timestamp":"...","message":{"role":"user","content":[{"type":"text","text":"hi"}]}}
{"type":"model_change","id":"...","parentId":"<prevEntryId>","timestamp":"...","model":"anthropic/claude-opus-4-5"}
{"type":"custom_message","id":"...","parentId":"...","timestamp":"...","customType":"skill-prompt","content":"...","display":true,"details":{"name":"...","path":"...","lineCount":3}}
{"type":"custom","id":"...","parentId":"...","timestamp":"...","customType":"my-ext","data":{}}
```
