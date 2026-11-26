# @oh-my-pi/pi-coding-agent 19.1.0 — exact SDK API reference

Extracted read-only from the shipped declarations and sources. `PKGROOT` = `node_modules/.bun/@oh-my-pi+pi-coding-agent@19.1.0+17530ac01dea6b83/node_modules/@oh-my-pi/pi-coding-agent`; `AIROOT` = `.../@oh-my-pi+pi-ai@19.1.0/node_modules/@oh-my-pi/pi-ai`; `UTILSROOT` = `.../@oh-my-pi+pi-utils@19.1.0/...`; `TUIROOT` = `.../@oh-my-pi+pi-tui@19.1.0/...`; `COREROOT` = `.../@oh-my-pi+pi-agent-core@19.1.0/...`.
Every `// from:` path is relative to PKGROOT unless the header names another root; `:N` / `:N-M` are line ranges in that file. JSDoc and blank lines are elided; wrapped signatures are joined onto one line with the text unchanged.
Export map: `.` -> `src/index.ts` (types `dist/types/index.d.ts`); `./*` -> `src/*.ts` (types `dist/types/*.d.ts`); explicit keys per top-level directory. **No `./cli` key** — `.../cli` resolves through `./*`. pi-utils / pi-tui / pi-ai resolve `worker-host`, `theme`, `overlays/*`, `providers/mock` through their own `./*` wildcards.

## A. Root export — '@oh-my-pi/pi-coding-agent'

### A.1 createAgentSession

```ts
// from: dist/types/sdk.d.ts:724
export declare function createAgentSession(options?: CreateAgentSessionOptions): Promise<CreateAgentSessionResult>;
```

```ts
// from: dist/types/sdk.d.ts:501-520
export interface CreateAgentSessionResult { session: AgentSession; extensionsResult: LoadExtensionsResult; setToolUIContext: (uiContext: ExtensionUIContext, hasUI: boolean) => void; mcpManager?: MCPManager; modelFallbackMessage?: string; lspServers?: LspStartupServerInfo[]; startBackgroundModelDiscovery?: () => Promise<void>; eventBus: EventBus; subagentEventBus?: EventBus; }
```

```ts
// from: dist/types/sdk.d.ts:41-495 (all fields, types verbatim)
export interface CreateAgentSessionOptions { cwd?: string; additionalDirectories?: string[]; agentDir?: string; spawns?: string; inheritedSessionAgents?: readonly AgentDefinition[]; authStorage?: AuthStorage; modelRegistry?: ModelRegistry; getApiKey?: AgentOptions["getApiKey"]; credentialSourceSessionId?: string; oauthAccountPools?: OAuthAccountPools; model?: Model; modelRole?: string; rebindModelAfterDiscovery?: boolean; deferRetryFallbackValidation?: boolean; modelPattern?: string | string[]; modelPatternParentFallback?: string; modelPatternFallbackRole?: string; modelPatternDefaultFallbackChain?: string[]; assertDispatchModel?: (model: Model) => void; disableModelFallback?: boolean; disableServerSideFallback?: boolean; thinkingLevel?: ConfiguredThinkingLevel; thinkingLevelCeiling?: Effort; openAIServiceTier?: ServiceTier | null; cacheWarming?: CacheWarmingMode; resolveServiceTierByFamily?: (model: Model | undefined) => ServiceTierByFamily; scopedModels?: Array<{ model: Model; thinkingLevel?: ThinkingLevel; }>; prewalk?: Prewalk; deferredPrewalk?: { target: string; patterns: string[]; }; onPrewalkWarning?: (warning: string) => void; suppressAutoPrewalk?: boolean; awaitingAssignment?: boolean; planYolo?: PlanYolo; systemPrompt?: string | string[] | ((defaultPrompt: string[]) => string | string[]); systemPromptTemplate?: string; customSystemPrompt?: string; appendSystemPrompt?: string; titleSystemPrompt?: string; providerSessionId?: string; providerPromptCacheKey?: string; taskPromptCacheKey?: string; providerPromptCacheKeySource?: "explicit" | "fork"; deadline?: number; costGate?: CostGateApi; customTools?: (CustomTool | ToolDefinition)[]; extensions?: ExtensionFactory[]; topLevelExtensions?: ExtensionFactory[]; additionalExtensionPaths?: string[]; disableExtensionDiscovery?: boolean; extensionRoots?: () => EffectiveExtensionRoots; preloadedExtensions?: LoadExtensionsResult; deferredExtensionPaths?: readonly string[]; preloadedExtensionPaths?: string[]; preloadedPreparedExtensions?: readonly PreparedExtension[]; preloadedCustomToolPaths?: ToolPathWithSource[]; eventBus?: EventBus; subagentEventBus?: EventBus; skills?: Skill[]; rules?: Rule[]; contextFiles?: Array<{ path: string; content: string; }>; noContextFiles?: boolean; excludeAgentsMd?: boolean; workspaceTree?: WorkspaceTree; promptTemplates?: PromptTemplate[]; slashCommands?: FileSlashCommand[]; enableMCP?: boolean; mcpManager?: MCPManagerApi; mcpTools?: CustomTool[]; mcpToolScope?: MCPToolScope; enableLsp?: boolean; lspReadOnly?: boolean; enableIrc?: boolean; skipPythonPreflight?: boolean; toolNames?: string[]; mountedToolNames?: string[]; restrictToolNames?: boolean; allowRestrictedCustomTools?: boolean; outputSchema?: unknown; outputSchemaMode?: StructuredSubagentSchemaMode; requireYieldTool?: boolean; bindProcessState?: boolean; taskDepth?: number; parentHindsightSessionState?: HindsightSessionStateApi; parentMnemopiSessionState?: MnemopiSessionStateApi; agentId?: string; agentDisplayName?: string; agentName?: string; agentRegistry?: AgentRegistryApi; expectedAgentRef?: AgentRef | null; parentTaskPrefix?: string; asyncJobManager?: AsyncJobManagerApi; jobWidgetAuthor?: JobWidgetAuthor; jobCaptionWriter?: JobCaptionWriter; parentAgentId?: string; sessionManager?: SessionManager; localProtocolOptions?: LocalProtocolOptions; settings?: Settings; settingsManager?: Settings | Promise<Settings>; hasUI?: boolean; allowSessionModelFallback?: boolean; interactivePrompts?: boolean; advertiseHeadlessAsk?: boolean; settingsApproval?: boolean; tuiTranscript?: boolean; autoTitle?: boolean; deferHintCompression?: boolean; deferUsageReserveConfirmation?: boolean; telemetry?: AgentTelemetryConfig; onFirstChatDispatch?: () => void; autoApprove?: boolean; }
```

Also exported by that file: `discoverExtensions:558`, `discoverSessionExtensionPaths:573`, `loadSessionExtensions:587`, `loadCliExtensionProviders:604`, `resolvePrewalkTarget:606`, `discoverContextFiles:625`, `discoverPromptTemplates:633`, `discoverSlashCommands:637`, `discoverCustomTSCommands:641`, `discoverMCPServers:646`, `buildSystemPrompt:672`, `customToolToDefinition:673`, `createAutoLearnCaptureRunner:692`, `resolveDialect:522`.

### A.2 Settings (class)

```ts
// from: dist/types/config/settings.d.ts:197-547 (members, verbatim; wrapped signatures joined)
 static init(options?: SettingsOptions): Promise<Settings>;
 static loadReadOnly(options?: SettingsOptions): Promise<Settings>;
 static loadIsolated(options?: SettingsOptions): Promise<Settings>;
 static isolated(overrides?: Readonly<Record<string, unknown>>, options?: { storage?: AgentStorage | null; }): Settings;
 grantAuthority(): Settings;
 overlay(overrides?: Readonly<Record<string, unknown>>, options?: { derived?: boolean; }): Settings;
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
 reloadFromDisk(options?: { includeParents?: boolean; }): Promise<void>;
 reloadForCwd(cwd: string): Promise<void>;
 getStorage(): AgentStorageApi | null;
 getCwd(): string;
 getAgentDir(): string;
 getModelRole(role: ModelRole | string): string | undefined;
 getModelRoles(): ReadOnlyDict<string>;
```

```ts
// from: dist/types/config/settings.d.ts:19-48
export type SettingProvenance = "env" | "runtime" | "overlay" | "project" | "global" | "default";
export interface RawSettings { [key: string]: unknown; }
export interface SettingsOptions { cwd?: string; agentDir?: string; inMemory?: boolean; readOnly?: boolean; overrides?: Readonly<Record<string, unknown>>; configFiles?: string[]; }
interface OwnLayers { global: RawSettings; project: RawSettings; configOverlay: RawSettings; overrides: RawSettings; }
export type OverlayLayers = Readonly<Pick<OwnLayers, "global" | "overrides">>;
```

Also on the class: `cancelPendingSaves:368`, `startWatching:379`, `stopWatching:381`, `cloneForCwd:394`, `get revision:287`, `getGlobalSettings:448`, `getProjectSettings:455`, `getPlansDirectory:456`, `getShellConfig:460`, `extensionsSourceLevel:472`, `setModelRole:487`, `isProjectModelRoleRuntimeOverrideActive:495`, `setProjectModelRole:499`, `clearProjectModelRole:503`, `getGlobalModelRole:511`, `getProjectModelRole:515`, `getModelRoleProvenance:527`, `getModelRoleSource:531`, `getOwnedModelPreset:540`, `overrideModelRoles:548`. Module level: `SettingProvenance:19`, `OverlayLayers:46`, `withActiveSettings:558`, `isSettingsInitialized:559`, `findScopedSettings:568`, `settings:586`.

**The settings handle** behind get / set / override / unset / clearOverride / isConfigured / isCredential is the registry handle, not `Settings`:

```ts
// from: dist/types/config/registry.d.ts:203-351 (members, verbatim; wrapped signatures joined)
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
// from: dist/types/config/registry.d.ts:358-368, :157, :340-342
export type AnySetting = Setting<unknown>;
export declare function register<const D extends SettingDefinition>(definition: D): Setting<DefinitionValue<D>, D["id"]>;
export declare function lookup(id: string): AnySetting | undefined;
export declare function all(): readonly AnySetting[];
export declare function register<const D extends SettingDefinition>(definition: D): Setting<DefinitionValue<D>, D["id"]>;
export declare function lookup(id: string): AnySetting | undefined;
```

`disableProvider` / `initializeWithSettings` live in the capability registry, re-exported verbatim by the discovery entry; they are NOT in `dist/types/config` and NOT re-exported by the package root (grep `discovery` over dist/types/index.d.ts: 0 matches). Import specifier: `@oh-my-pi/pi-coding-agent/capability` or `/discovery`.

```ts
// from: dist/types/capability/index.d.ts:60-90
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
// from: dist/types/config/model-registry.d.ts:49-447 (members, verbatim; wrapped signatures joined)
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
// from: dist/types/config/model-registry.d.ts:31-43
export interface ModelRegistryRefreshOptions { refreshCommandCredentials?: boolean; }
export type ResolvedRequestAuth = { ok: true; apiKey?: string; headers?: Record<string, string>; env?: Record<string, string>; } | { ok: false; error: string; };
```

Also declared: `reapplyModelPolicies:131`, `refreshProvider:176`, `refreshDiscoverableProviders:183`, `hasLazyRuntimeMetadata:204`, `refreshSelectedModelMetadata:214`, `refreshRuntimeProviders:224`, `getError:228`, `getAvailableForProviders:274`, `hasConcreteAuth:312`, `hasCommandBackedApiKey:319`, `getDiscoverableProviders:320`, `getDiscoveryProviderId:322`, `getProviderDiscoveryState:333`, `isProviderDiscoveryPending:352`, `getProviderBaseUrl:378`, `getProviderHeaders:383`, `resolveModelHeaders:385`, `getApiKey:387`, `getApiKeyAndHeaders:391`, `getApiKeyForProvider:402`, `getApiKeyWithCredentialForProvider:410`, `resolver:301/:302`, `isUsingOAuth:423`, `clearSourceRegistrations:430`, `unregisterProvider:434`, `syncExtensionSources:438`, `suppressSelector:451`, `isSelectorSuppressed:455`, `clearSuppressedSelector:459`, `clearSuppressedSelectors:464`. `ModelRefreshStrategy` comes from `@oh-my-pi/pi-catalog/model-manager`; `ModelKind` from `@oh-my-pi/pi-catalog/types`.

### A.4 discoverAuthStorage + AuthStorage + credentials

```ts
// from: dist/types/sdk.d.ts:554 (discoverAuthStorage)
export declare function discoverAuthStorage(agentDir?: string, options?: Omit<DiscoverAuthStorageOptions, "agentDir" | "configValueResolver"> & Omit<EffectiveSettingsScope, "agentDir">): Promise<AuthStorage>;
```

```ts
// from: dist/types/session/auth-storage.d.ts:5-7 (pure re-export of the pi-ai surface)
export type { ApiKeyCredential, AuthCredential, AuthCredentialEntry, AuthCredentialStore, AuthStorageData, AuthStorageOptions, CredentialOrigin, CredentialOriginKind, OAuthAccountIdentity, OAuthAccountSummary, OAuthCredential, ResetCreditAccountStatus, ResetCreditRedeemOutcome, ResetCreditTarget, StoredAuthCredential, } from "@oh-my-pi/pi-ai";
export { AuthStorage, REMOTE_REFRESH_SENTINEL, SqliteAuthCredentialStore } from "@oh-my-pi/pi-ai";
export type { SnapshotResponse } from "@oh-my-pi/pi-ai/auth-broker/types";
```

```ts
// from: AIROOT/dist/types/auth-storage.d.ts:53-115
export declare class AuthStorage { #private; constructor(backend: AuthStorageBackend); constructor(store: AuthCredentialStore, options?: AuthStorageOptions); get credentials(): CredentialsApi; get keys(): KeysApi; get oauth(): OAuthApi; get sessions(): SessionsApi; get usage(): UsageApi; get health(): HealthApi; get limits(): LimitsApi; get resets(): ResetsApi; get blocks(): BlocksApi; setAccountPolicies(config: AuthAccountPolicyConfig): void; replaceStore(store: AuthCredentialStore, options?: { sourceLabel?: string; }): Promise<void>; static create(dbPath: string, options?: AuthStorageOptions): Promise<AuthStorage>; close(): void; getApiKey(provider: string, sessionId?: string, options?: AuthApiKeyOptions): Promise<string | undefined>; reload(): Promise<void>; }
```

```ts
// from: AIROOT/dist/types/auth/types.d.ts (CredentialsApi):769-878 (members, verbatim; wrapped signatures joined)
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
// from: AIROOT/dist/types/auth/types.d.ts (KeysApi):897-1001 (members, verbatim; wrapped signatures joined)
 get(provider: string, sessionId?: string, options?: AuthApiKeyOptions): Promise<string | undefined>;
 getWithCredential(provider: string, sessionId?: string, options?: AuthApiKeyOptions): Promise<ResolvedApiKey | undefined>;
 peek(provider: string, options?: AuthPeekOptions): Promise<string | undefined>;
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
// from: AIROOT/dist/types/auth/types.d.ts:21
export type AuthCredentialEntry = AuthCredential | AuthCredential[];
```

### A.5 SessionManager

```ts
// from: dist/types/session/session-manager.d.ts:200-780 (members, verbatim; wrapped signatures joined)
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
 static listForPicker(cwd: string, sessionDir?: string, storage?: SessionStorage, worktreeScope?: "directory" | "repo"): Promise<PickerListing>;
 static listAllForPicker(storage?: SessionStorage): Promise<PickerListing>;
```

```ts
// from: dist/types/session/session-manager.d.ts:17-82, :28
export declare function mintSessionId(): string;
export type ReadonlySessionManager = Pick<SessionManager, "getCwd" | "getRecordedCwd" | "getSessionDir" | "getSessionId" | "getSessionFile" | "getSessionName" | "getArtifactsDir" | "getArtifactManager" | "allocateArtifactPath" | "saveArtifact" | "getArtifactPath" | "getLeafId" | "getLeafEntry" | "getEntry" | "getLabel" | "getBranch" | "getHeader" | "getEntries" | "getTree" | "getUsageStatistics" | "putBlob" | "putBlobSync">;
```

```ts
// from: dist/types/session/session-listing.d.ts:18-109, :97-100
export type SessionStatus = "complete" | "interrupted" | "aborted" | "error" | "pending" | "unknown";
export interface SessionInfo { path: string; id: string; cwd: string; title?: string; parentSessionPath?: string; created: Date; modified: Date; messageCount: number; assistantTurns?: number; size: number; firstMessage: string; allMessagesText: string; status?: SessionStatus; }
// SessionListing<T> 来自 `@oh-my-pi/pi-tui/overlays/session-selector`：{ sessions: T[]; complete?: Promise<T[]> }
export interface PickerListing extends SessionListing<SessionInfo> { complete: Promise<SessionInfo[]>; }
```

The session file / messages surface is the trio `getSessionFile(): string | undefined` / `getSessionDir(): string` / `getSessionId(): string`, plus the tree readers (`getHeader` / `getEntries` / `getLeafId` / `getLeafEntry` / `getEntry` / `getChildren` / `getBranch` / `getTree` / `buildSessionContext`) and the writers (`appendMessage` / `appendCustomMessageEntry` / `appendCustomEntry` / `appendModelChange` / `appendThinkingLevelChange` / `appendCompaction` / `rewriteEntries` / `flush`).

### A.6 The session object returned by createAgentSession

Class `AgentSession` (dist/types/session/agent-session.d.ts:111). The block below is verbatim, in declaration order, for every member the adapter needs (subscribe / prompt / steer / followUp / abort / dispose / setModel / setThinkingLevel / queues / context usage / model / messages / skills / session file + id); the class declares more, listed by name after the block. `#private` members are excluded, and `initializeExtensions` / `setToolUIContext` are NOT methods here (see A.7).

```ts
// from: dist/types/session/agent-session.d.ts:166-1954 (all adapter-relevant members, in declaration order;
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
 get wakeSources(): WakeSources | undefined;
 get hasPendingWake(): boolean;
 hasWakeAfterTurn(): boolean;
 get isRunActive(): boolean;
 waitForRunEnd(): Promise<void>;
 get hasAdmittedSubmission(): boolean;
 get messages(): AgentMessage[];
 buildDisplaySessionContext(model?: Model<import("@oh-my-pi/pi-ai").Api> | undefined): SessionContext;
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
 popLastQueuedMessage(): DequeuedMessage | undefined;
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

The class declares many more public members (tools, compaction, session management, OAuth accounts, admin). Don't enumerate them here — read `dist/types/session/agent-session.d.ts`; the list that used to sit in this paragraph drifted on every upgrade. Run lifecycle (19.0) added `isRunActive` / `wakeSources` / `waitForRunEnd`; `handoff` was replaced by `compact(instructions?, options?)` with `mode: "handoff"`.

```ts
// from: dist/types/session/agent-session.d.ts:107-117 (PromptDroppedError, SessionBusyError)
export declare class PromptDroppedError extends Error { constructor(reason?: string); }
export declare class SessionBusyError extends Error { constructor(action: string); }
```

`initializeExtensions` and `setToolUIContext` are NOT AgentSession methods — `setToolUIContext` is a field of `CreateAgentSessionResult` (sdk.d.ts:368) and `initializeExtensions` is the free function in A.7.

```ts
// from: dist/types/session/agent-session-types.d.ts:424-525 (PromptOptions, DroppedPrompt, FollowUp/Steer/SendUserMessage options)
export interface PromptOptions { expandPromptTemplates?: boolean; runCommands?: boolean; throwOnDrop?: boolean; images?: ImageContent[]; streamingBehavior?: "steer" | "followUp" | "aside"; toolChoice?: ToolChoice; synthetic?: boolean; userInitiated?: boolean; attribution?: MessageAttribution; skipCompactionCheck?: boolean; solutionSpace?: string; onPromptAdmitted?: () => void; }
export interface DroppedPrompt { text: string; images?: ImageContent[]; }
export interface FollowUpOptions { synthetic?: boolean; expandPromptTemplates?: boolean; attribution?: MessageAttribution; }
export interface SteerOptions { attribution?: MessageAttribution; onPromptQueued?: PromptOptions["onPromptQueued"]; }
export interface SendUserMessageOptions { deliverAs?: "steer" | "followUp" | "aside"; attribution?: MessageAttribution; }
```

```ts
// from: dist/types/session/agent-session-types.d.ts:547-608 (ContextUsageBreakdown, SessionStats, FreshSessionResult, RestoredQueuedMessage)
export interface ContextUsageBreakdown { contextWindow: number; anchored: boolean; usedTokens: number; systemPromptTokens: number; systemToolsTokens: number; systemContextTokens: number; skillsTokens: number; messagesTokens: number; }
export interface SessionStats { sessionFile: string | undefined; sessionId: string; userMessages: number; assistantMessages: number; toolCalls: number; toolResults: number; totalMessages: number; tokens: { input: number; output: number; reasoning: number; cacheRead: number; cacheWrite: number; total: number; }; premiumRequests: number; cost: number; credits?: { cost: number; committedCost: number; acuCost: number; }; routedModels?: Record<string, number>; contextUsage?: ContextUsage; }
export interface SessionOAuthAccountList { provider: string; accounts: OAuthAccountSummary[]; }
export interface FreshSessionResult { previousSessionId: string; sessionId: string; closedProviderSessions: number; }
export interface ResetSessionContextResult { droppedCount: number; }
export type RestoredQueuedMessage = { text: string; images?: ImageContent[]; };
```

```ts
// from: dist/types/session/agent-session-types.d.ts:44-63 (AgentSessionDisposeOptions)
export interface AgentSessionDisposeOptions { mnemopiConsolidateTimeoutMs?: number; drainTimeoutMs?: number; reason?: postmortem.Reason; }
```

```ts
// from: TUIROOT/dist/types/status-line/types.d.ts:9-15 (ContextUsage)
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
// from: dist/types/sdk.d.ts:507
 setToolUIContext: (uiContext: ExtensionUIContext, hasUI: boolean) => void;
```

```ts
// from: dist/types/main.d.ts:30 (member of AcpSessionHandle)
 setToolUIContext: (uiContext: ExtensionUIContext, hasUI: boolean) => void;
```

```ts
// from: dist/types/main.d.ts:30 (member of AcpSessionFactoryOptions, inside the options object)
 setToolUIContext: (uiContext: ExtensionUIContext, hasUI: boolean) => void;
```

```ts
// from: dist/types/modes/interactive-mode.d.ts:575
 setToolUIContext(uiContext: ExtensionUIContext, hasUI: boolean): void;
```

```ts
// from: dist/types/modes/types.d.ts:412
 setToolUIContext(uiContext: ExtensionUIContext, hasUI: boolean): void;
```

```ts
// from: dist/types/modes/acp/acp-mode.d.ts:8
 setToolUIContext: (uiContext: ExtensionUIContext, hasUI: boolean) => void;
```

`ensureThemeSync`: **NOT FOUND** in @oh-my-pi/pi-coding-agent (searched the whole package including `src/` and `dist/cli.js`). It is a pi-tui export, and the coding-agent root re-exports that module (`dist/types/index.d.ts:23` = `export * from "@oh-my-pi/pi-tui/theme"`):

```ts
// from: TUIROOT/dist/types/theme/theme.d.ts:37 — import specifier "@oh-my-pi/pi-tui/theme"
export declare function ensureThemeSync(): void;
```

### A.8 exportFromFile

```ts
// from: dist/types/export/html/index.d.ts:9-48 — import specifier "@oh-my-pi/pi-coding-agent/export/html"
export declare function getTemplate(): string;
export interface ExportOptions { outputPath?: string; palette?: "web" | "theme"; themeName?: string; themeNames?: ExportThemeNames; includeSubSessions?: boolean; }
export declare function generateThemeVars(palette?: "web" | "theme" | (string & {}), themeName?: string): Promise<string>;
export declare function generateThemeStyles(palette: "web" | "theme", themeNames?: ExportThemeNames, legacyThemeName?: string): Promise<string>;
export interface SessionData { header: SessionHeader | null; entries: SessionEntry[]; leafId: string | null; systemPrompt?: string; tools?: { name: string; description: string; }[]; subSessions?: Record<string, SubSession>; trace?: SessionTrace; }
export declare function buildSessionData(sm: SessionManager, state?: AgentState): SessionData;
export declare function exportSessionToHtml(sm: SessionManager, state?: AgentState, options?: ExportOptions | string): Promise<string>;
export declare function exportFromFile(inputPath: string, options?: ExportOptions | string): Promise<string>;
```

`exportFromFile` is not re-exported from the package root (no `./export/*` entry in dist/types/index.d.ts).

### A.9 discoverSkills

```ts
// from: dist/types/sdk.d.ts:617-620
export declare function discoverSkills(cwd?: string, _agentDir?: string, settings?: SkillsSettings & Pick<LoadSkillsOptions, "disabledExtensions">): Promise<{ skills: Skill[]; warnings: SkillWarning[]; }>;
```

```ts
// from: dist/types/extensibility/skills.d.ts:7-77, :76
export interface Skill { name: string; description: string; filePath: string; baseDir: string; source: string; hide?: boolean; containRoot?: string; _source?: SourceMeta; }
export interface SkillWarning { skillPath: string; message: string; }
export interface LoadSkillsResult { skills: Skill[]; warnings: SkillWarning[]; }
export declare function loadSkills(options?: LoadSkillsOptions): Promise<LoadSkillsResult>;
```

### A.10 loadAllMCPConfigs

```ts
// from: dist/types/mcp/config.d.ts:10-43 — import specifier "@oh-my-pi/pi-coding-agent/mcp/config"
export interface LoadMCPConfigsOptions { enableProjectConfig?: boolean; filterExa?: boolean; filterBrowser?: boolean; extensionRoots?: EffectiveExtensionRoots; }
export interface LoadMCPConfigsResult { configs: Record<string, MCPServerConfig>; exaApiKeys: string[]; sources: Record<string, SourceMeta>; }
export declare function loadAllMCPConfigs(cwd: string, options?: LoadMCPConfigsOptions): Promise<LoadMCPConfigsResult>;
```

Same file: `isExaMCPServer:47`, `extractExaApiKey:51`, `filterExaMCPServers:67`, `validateServerConfig:71`, `shouldFilterBrowserMCPForPrelude:79`, `isBrowserMCPServer:83`, `filterBrowserMCPServers:95`, `ExaFilterResult:53`, `BrowserMCPPreludeFilterOptions:72`, `BrowserFilterResult:85`.

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
// from: dist/types/mcp/types.d.ts:105-134
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
// from: dist/types/extensibility/plugins/manager.d.ts:4-95 (members, verbatim; wrapped signatures joined)
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
// from: dist/types/extensibility/plugins/marketplace/manager.d.ts:10-82 (members, verbatim; wrapped signatures joined)
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
// from: dist/types/extensibility/plugins/types.d.ts:5-155
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
// from: dist/types/session/agent-session-events.d.ts:24-149 (the whole union, JSDoc elided)
export type AgentSessionEvent = AgentEvent | { type: "agent_pause"; messages: AgentMessage[]; yielded: boolean; awaiting: boolean; } | { type: "auto_compaction_start"; reason: "threshold" | "overflow" | "idle" | "incomplete"; action: "context-full" | "remote" | "handoff" | "shake" | "snapcompact"; } | { type: "auto_compaction_end"; action: "context-full" | "remote" | "handoff" | "shake" | "snapcompact"; result: CompactionResult | undefined; aborted: boolean; willRetry: boolean; errorMessage?: string; skipped?: boolean; } | { type: "manual_compaction_start"; mode?: string; } | { type: "manual_compaction_end"; result?: CompactionResult; aborted: boolean; skipped?: boolean; errorMessage?: string; } | { type: "auto_retry_start"; attempt: number; maxAttempts: number; delayMs: number; errorMessage: string; errorId?: number; } | { type: "auto_retry_end"; success: boolean; attempt: number; finalError?: string; retryErrors?: RetryErrorUpdate[]; } | ({ type: "cache_warming_start"; } & CacheWarmingRefreshStart) | ({ type: "cache_warming_end"; } & CacheWarmingRefreshEnd) | { type: "retry_fallback_applied"; from: string; to: string; role: string; reason?: string; } | { type: "retry_fallback_succeeded"; model: string; role: string; } | { type: "model_changed"; } | { type: "config_warnings_changed"; } | { type: "advisor_cost_changed"; } | { type: "advisor_yielded"; } | { type: "ttsr_triggered"; rules: Rule[]; } | { type: "todo_reminder"; todos: TodoItem[]; attempt: number; maxAttempts: number; } | { type: "todo_auto_clear"; } | { type: "irc_message"; message: CustomMessage; } | { type: "notice"; level: "info" | "warning" | "error"; message: string; source?: string; } | { type: "thinking_level_changed"; thinkingLevel: ThinkingLevel | undefined; configured?: ConfiguredThinkingLevel; resolved?: Effort; } | { type: "goal_updated"; goal: Goal | null; state?: GoalModeState; } | { type: "queue_update"; steering: string[]; followUp: string[]; liveSteered: number; };
export type AgentSessionEventListener = (event: AgentSessionEvent) => void;
```

**Run lifecycle (19.0)**: a _run_ opens at the first `agent_start` and closes at exactly one `agent_end` — emitted once nothing can resume it (no model loop live, nothing the session scheduled pending, no background job / child agent / peer message can wake it). Every model loop that stops while the run goes on emits `agent_pause` instead, followed by the next loop's `agent_start` or by the run's `agent_end`. A session transition (`/new`, a switch, dispose) abandons an open run with neither. The old `agent_end { isTerminal: false }` / `awaitingAsyncWork` shape is gone; `AgentSession` exposes `isRunActive`, `wakeSources` (`WakeSources`), and `waitForRunEnd()` in its place.

The first arm (`AgentEvent`) expands to these pi-agent-core variants:

```ts
// from: COREROOT/dist/types/types.d.ts:1173-1225
export type AgentEvent = { type: "agent_start"; resumedToolCallIds?: string[]; } | { type: "agent_end"; messages: AgentMessage[]; telemetry?: AgentRunSummary; coverage?: AgentRunCoverage; } | { type: "turn_start"; } | { type: "turn_end"; message: AgentMessage; toolResults: ToolResultMessage[]; } | { type: "message_start"; message: AgentMessage; } | { type: "message_update"; message: AgentMessage; assistantMessageEvent: AssistantMessageEvent; } | { type: "message_end"; message: AgentMessage; } | { type: "tool_execution_start"; toolCallId: string; toolName: string; args: any; intent?: string; } | { type: "tool_execution_update"; toolCallId: string; toolName: string; args: any; partialResult: any; } | { type: "tool_stream_update"; toolCallId: string; toolName: string; update: unknown; } | { type: "tool_execution_end"; toolCallId: string; toolName: string; result: any; isError?: boolean; };
```

```ts
// from: dist/types/session/cache-warmer.d.ts:34-72 (payloads of the cache_warming_* arms)
export type CacheWarmingMode = "off" | "streaming" | "idle";
export declare const CACHE_WARMING_MODES: readonly ["off", "streaming", "idle"];
export interface CacheWarmingRefreshStart { phase: "streaming" | "idle"; provider: string; model: string; }
export interface CacheWarmingRefreshEnd extends CacheWarmingRefreshStart { outcome: "hit" | "miss" | "error" | "aborted"; usage?: Usage; warmingStopReason?: string; }
```

```ts
// from: dist/types/extensibility/shared-events.d.ts:232-245 (RetryErrorUpdate, used by auto_retry_end)
export interface RetryErrorUpdate { entryId: string; persistenceKey?: string; note: string; retryRecovery: AssistantRetryRecovery; }
export interface AutoRetryEndEvent { type: "auto_retry_end"; success: boolean; attempt: number; finalError?: string; retryErrors?: RetryErrorUpdate[]; }
```

### A.14 ToolDefinition accepted by pi.registerTool inside an extension

```ts
// from: dist/types/extensibility/extensions/types.d.ts:795-855
export interface ToolDefinition<TParams extends TSchema = TSchema, TDetails = unknown> { name: string; label: string; description: string; parameters: TParams; hidden?: boolean; defaultInactive?: boolean; loadMode?: ToolLoadMode; deferrable?: boolean; readsSkillUris?: boolean; approval?: ToolApproval; strict?: boolean; mcpServerName?: string; mcpToolName?: string; legacyName?: string; shellEnv?: ToolShellEnvironmentHook; sourcePath?: string; execute(toolCallId: string, params: Static<TParams>, signal: AbortSignal | undefined, onUpdate: AgentToolUpdateCallback<TDetails> | undefined, ctx: ExtensionContext): Promise<AgentToolResult<TDetails>>; onSession?: (event: ToolSessionEvent, ctx: ExtensionContext) => void | Promise<void>; renderCall?: (args: Static<TParams>, options: ToolRenderResultOptions, theme: Theme) => Component; renderResult?: (result: AgentToolResult<TDetails>, options: ToolRenderResultOptions, theme: Theme, args?: Static<TParams>) => Component; describeCall?: (args: Static<TParams>, options: ToolRenderResultOptions) => NativeToolView | undefined; describeResult?: (result: AgentToolResult<TDetails>, options: ToolRenderResultOptions, args?: Static<TParams>) => NativeToolView | undefined; }
```

```ts
// from: dist/types/extensibility/extensions/types.d.ts:1482 (registerTool)
 registerTool<TParams extends TSchema = TSchema, TDetails = unknown>(tool: ToolDefinition<TParams, TDetails>): void;
```

```ts
// from: dist/types/extensibility/extensions/types.d.ts (ExtensionAPI members):1418-1513 (members, verbatim; wrapped signatures joined)
 logger: typeof PiLogger;
 typebox: typeof TypeBox;
 arktype: typeof ArkType;
 zod: typeof zod;
 pi: typeof PiCodingAgent;
 registerTool<TParams extends TSchema = TSchema, TDetails = unknown>(tool: ToolDefinition<TParams, TDetails>): void;
 registerFileWriteFallback(handler: FileWriteFallbackHandler): void;
```

```ts
// from: dist/types/extensibility/extensions/types.d.ts:1427-1479 (the ExtensionAPI on(...) overload set, verbatim)

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
// from: dist/types/extensibility/extensions/types.d.ts:1390-1818 (ExtensionHandler), :1238 (ExtensionFactory)
export type ExtensionHandler<E, R = undefined> = (event: E, ctx: ExtensionContext) => Promise<R | void> | R | void;
export type ExtensionFactory = (pi: ExtensionAPI) => void | Promise<void>;
```

```ts
// from: COREROOT/dist/types/types.d.ts:948-995 (AgentToolResult, update callback, ToolTier/ToolLoadMode/ToolApproval)
export interface AgentToolResult<T = any, _TInput = unknown> { content: (TextContent | ImageContent)[]; details?: T; isError?: boolean; providerMetadata?: ToolResultProviderMetadata; useless?: boolean; }
export type AgentToolUpdateCallback<T = any, TInput = unknown> = (partialResult: AgentToolResult<T, TInput>) => void;
export interface RenderResultOptions { expanded: boolean; isPartial: boolean; spinnerFrame?: number; }
export type ToolTier = "read" | "write" | "exec";
export type ToolLoadMode = "essential" | "discoverable";
export type ToolApprovalDecision = ToolTier | { tier: ToolTier; reason?: string; override?: boolean; policy?: "allow" | "deny" | "prompt"; policyKey?: string; };
export type ToolApproval = ToolApprovalDecision | ((args: unknown, context?: AgentToolContext) => ToolApprovalDecision);
```

```ts
// from: dist/types/extensibility/extensions/types.d.ts:769-889, :529-545 (render options, tool session event, ToolInfo, SourceInfo)
export interface ToolRenderResultOptions { expanded: boolean; isPartial: boolean; spinnerFrame?: number; }
export interface ToolSessionEvent { reason: "start" | "switch" | "branch" | "tree" | "shutdown"; previousSessionFile: string | undefined; }
export interface ToolShellEnvironmentContext { command: string; cwd: string; env: Record<string, string | undefined>; }
export type ToolShellEnvironmentHook = (context: ToolShellEnvironmentContext) => Record<string, string> | undefined;
export interface SourceInfo { path: string; source: string; scope: SourceScope; origin: SourceOrigin; baseDir?: string; }
export interface ToolInfo { name: string; description: string; parameters: TSchema; promptGuidelines?: string[]; sourceInfo: SourceInfo; }
```

```ts
// from: dist/types/extensibility/extensions/runner.d.ts:234-235 (getUIContext / hasUI)
 getUIContext(): ExtensionUIContext;
 hasUI(): boolean;
```

## B. '@oh-my-pi/pi-utils/worker-host'

```ts
// from: UTILSROOT/dist/types/worker-host.d.ts:2-57 (complete module)
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

`parentPort`: **NOT FOUND**. The module exports no such symbol — grep for `parentPort` over `UTILSROOT/dist/types/worker-host.d.ts` and `UTILSROOT/src/worker-host.ts` matched only doc comments and the un-exported `MessageListenerPort` interface. Full export list of `UTILSROOT/src/worker-host.ts`: `WORKER_HOST_SELECTOR_PREFIX:4`, `isWorkerHostSelector:14`, `declareWorkerHostEntry:29`, `workerHostEntry:34`, `WorkerInbox:59`, `installWorkerInbox:77`, `consumeWorkerInbox:103` (those line numbers are in `src/`, not in the `dist/types` block above).

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
// from: TUIROOT/dist/types/theme/theme.d.ts:1-131 (complete module)
import type { Terminal } from "../terminal.js";
import { type ThemeColor } from "./schema.js";
import type { SymbolPreset } from "./symbols.js";
import type { Theme } from "./theme-class.js";
export { getAvailableThemes, getAvailableThemesWithPaths, getThemeByName, type ThemeInfo } from "./loader.js";
export { isValidThemeColor, type ThemeBg, type ThemeColor } from "./schema.js";
export { getAvailableSymbolPresets, isValidSymbolPreset, type SpinnerType, type SymbolKey, type SymbolPreset, } from "./symbols.js";
export { Theme } from "./theme-class.js";
export { createHighlightStream, getEditorTheme, getMarkdownTheme, getMarkdownThemeWithLinkTargets, getSelectListTheme, getSettingsListTheme, getSymbolTheme, highlightCode, isHighlightLanguage, setMarkdownMermaidRendering, warmHighlighter, } from "./tui-adapters.js";
export declare function onTerminalBackgroundFallbackChange(callback: () => void): () => void;
export declare function detectTerminalBackground(): "dark" | "light";
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
export declare function isLightTheme(themeName?: string): boolean;
export declare function getThemeExportColors(themeName?: string): Promise<{ pageBg?: string; cardBg?: string; infoBg?: string; }>;
```

```ts
// from: TUIROOT/dist/types/theme/theme-class.d.ts (the Theme instance the singleton is bound to):22-326 (members, verbatim; wrapped signatures joined)
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
// from: TUIROOT/dist/types/overlays/session-observer-registry.d.ts:1-79 (complete module)
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
// from: AIROOT/dist/types/providers/mock.d.ts:44-188 (complete module)
import type { AnthropicFallbackCreditHandle, Api, Context, Model, ServiceTier, SimpleStreamOptions, StopDetails, StopReason, Usage } from "../types.js";
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
// from: dist/types/extensibility/extensions/types.d.ts:62-83
export interface ExtensionUISelectOption { label: string; description?: string; }
export type ExtensionUISelectItem = string | ExtensionUISelectOption;
import type { ExtensionAskDialogQuestion, ExtensionAskDialogResult, ExtensionAskDialogSubmitResult } from "@oh-my-pi/pi-tui/overlays/ask-dialog";
export type { ExtensionAskDialogOption, ExtensionAskDialogQuestion, ExtensionAskDialogResultItem, ExtensionAskDialogSubmitResult, ExtensionAskDialogChatResult, ExtensionAskDialogResult, } from "@oh-my-pi/pi-tui/overlays/ask-dialog";
export declare function getExtensionUISelectOptionLabel(option: ExtensionUISelectItem): string;
export declare function timedOutAskDialogResult(questions: ExtensionAskDialogQuestion[]): ExtensionAskDialogSubmitResult;
```

Import specifier: `@oh-my-pi/pi-coding-agent/extensibility/extensions/types` (also re-exported by `.../extensibility/extensions` and, type-only, by the root: `dist/types/index.d.ts:15-16`).

## I. '@oh-my-pi/pi-coding-agent/config/all-settings'

```ts
// from: dist/types/config/all-settings.d.ts (entire file, 8 lines)
import { type AnySetting } from "./registry.js";
export declare function orderedSettings(): readonly AnySetting[];
```

Side effect: the module declares only `orderedSettings()`; importing it pulls in every settings-domain module (`PKGROOT/src/config/all-settings.ts`), each of which registers its settings as a top-level side effect. `Settings` depends on it — `dist/types/config/settings.d.ts:17` is the bare `import "./all-settings.js";` — so any `Settings` instance implies every setting id is registered (e.g. `enabledProviders` at `PKGROOT/src/config/model-settings.ts:71`, `disabledProviders` at `:78`).

## J. ExtensionUIContext — every member

```ts
// from: dist/types/extensibility/extensions/types.d.ts:189-309
export interface ExtensionUIContext { timeoutStartsOnPresentation?: boolean; supportsEditor?: boolean; select(title: string, options: ExtensionUISelectItem[], dialogOptions?: ExtensionUIDialogOptions): Promise<string | undefined>; confirm(title: string, message: string, dialogOptions?: ExtensionUIDialogOptions): Promise<boolean>; openTerminal?(request: TerminalLaunchRequest): Promise<TerminalLaunchResult>; input(title: string, placeholder?: string, dialogOptions?: ExtensionUIDialogOptions): Promise<string | undefined>; askDialog?(questions: ExtensionAskDialogQuestion[], dialogOptions?: ExtensionUIDialogOptions): Promise<ExtensionAskDialogResult | undefined>; formDialog?(html: string, dialogOptions?: ExtensionUIDialogOptions): Promise<ExtensionFormDialogResult | undefined>; approve?(prompt: ExtensionApprovalPrompt, dialogOptions?: ExtensionUIDialogOptions): Promise<ExtensionApprovalAnswer>; notify(message: string, type?: "info" | "warning" | "error"): void; onTerminalInput(handler: TerminalInputHandler): () => void; rerenderMessage(timestamp: number): void; refreshTranscript(ids: readonly string[]): void; getLinkClicksAvailable(): boolean; setStatus(key: string, text: string | undefined): void; setWorkingMessage(message?: string): void; setWidget(key: string, content: ExtensionWidgetContent, options?: ExtensionWidgetOptions): void; setFooter(factory: ExtensionUiComponentFactory | undefined): void; setHeader(factory: ExtensionUiComponentFactory | undefined): void; setTitle(title: string): void; custom<T>(factory: (tui: TUI, theme: Theme, keybindings: KeybindingsManager, done: (result: T) => void) => ExtensionUiComponent | Promise<ExtensionUiComponent>, options?: ExtensionCustomOptions): Promise<T>; setEditorText(text: string): void; pasteToEditor(text: string): void; getEditorText(): string; editor(title: string, prefill?: string, dialogOptions?: ExtensionUIDialogOptions, editorOptions?: { promptStyle?: boolean; }): Promise<string | undefined>; addAutocompleteProvider(factory: AutocompleteProviderFactory): void; setEditorComponent(factory: ((tui: TUI, theme: EditorTheme, keybindings: KeybindingsManager) => CustomEditor) | undefined): void; getEditorComponent(): ((tui: TUI, theme: EditorTheme, keybindings: KeybindingsManager) => CustomEditor) | undefined; readonly theme: Theme; getAllThemes(): Promise<{ name: string; path: string | undefined; }[]>; getTheme(name: string): Promise<Theme | undefined>; setTheme(theme: string | Theme): Promise<{ success: boolean; error?: string; }>; getToolsExpanded(): boolean; setToolsExpanded(expanded: boolean): void; }
```

Optional members: `timeoutStartsOnPresentation?`, `supportsEditor?`, `openTerminal?`, `askDialog?`, `formDialog?`, `approve?`. Every other member is required — `rerenderMessage`, `refreshTranscript` and `getLinkClicksAvailable` became required in 19.0 (the embedder's transcript has no assistant-text renderers, so they are honest no-ops / `false`). `approve?` 是 18.11.3 起的工具审批入口：`ExtensionApprovalPrompt` 带 `full` / `compact` / 可选 `session` 与 `grants`，答复是 `"once" | "session" | "deny" | { grant, always }`；不实现时 omp 回退到 `select(full, approvalChoiceLabels(...))`（有 `session` 时选项集不再是两颗按钮）。`formDialog?` 是 19.0 的 ask 入口：入参是一整张 HTML `<form>`（`parseHtmlForm` 解析），答复 `ExtensionFormDialogResult { data: HtmlFormData; notes?: OptionNote[]; timedOut?: boolean }`；不实现时 `ask` 退回逐字段 `select` / `input` / `editor`（`askDialog` 的另一条路），19.1 的 RPC 宿主则必须实现 `formDialog`。`Theme` / `TUI` / `EditorTheme` / `KeybindingsManager` / `CustomEditor` / `OverlayHandle` / `OverlayOptions` / `ExtensionUiComponent*` / `ExtensionWidgetContent` / `AutocompleteProvider` come from `@oh-my-pi/pi-tui` (imports at types.d.ts:10-11,20,22,33,35,51-52); `ExtensionAskDialog*` comes from `@oh-my-pi/pi-tui/overlays/ask-dialog` and is re-exported at types.d.ts:61; `FormAnswer` / `OptionNote` / `HtmlFormData` come from `@oh-my-pi/pi-tui/html-form/data`.

## K. Approval machinery

`APPROVAL_MODE_MAX_TIER`: **module-private constant, NOT exported** (absent from `dist/types/tools/approval.d.ts`; grep over PKGROOT/src and PKGROOT/dist/types matched only the source lines shown below). `TIER_RANK` is its exported counterpart.

```ts
// from: PKGROOT/src/tools/approval.ts:131-709, :575-603
export const TIER_RANK: Readonly<Record<ToolTier, number>> = { read: 0, write: 1, exec: 2, }; export function strictestApproval(decisions: Iterable<ToolApprovalDecision>): ToolApprovalDecision { let tier: ToolTier = "read"; for (const decision of decisions) { if (typeof decision !== "string" && decision.policy === "deny") return decision; const decisionTier = typeof decision === "string" ? decision : decision.tier; if (TIER_RANK[decisionTier] > TIER_RANK[tier]) tier = decisionTier; } return tier; } const APPROVAL_MODE_MAX_TIER: Record<ApprovalMode, ToolTier> = { "always-ask": "read", "always-ask-cached": "read", write: "write", yolo: "exec", };
// …（中间：approvalFolderCandidate / recordApprovalGrant / resolveToolTier / sessionApprovalScope / denyError 等，签名见下方 d.ts 块）
function approvalHeader(tool: ApprovalSubject, reason?: string): string[] { const lines = [`Allow tool: ${tool.name}`]; if (tool.name.startsWith("mcp__") && tool.approval === undefined) { lines.push("Origin: MCP server tool"); } if (reason) { lines.push(`Reason: ${reason}`); } return lines; } function approvalDetails(tool: ApprovalSubject, args: unknown): string[] { const details = tool.formatApprovalDetails?.(args); if (details !== undefined) { return (typeof details === "string" ? [details] : details).filter(detail => detail.length > 0); } if (tool.name.startsWith("mcp__")) { return formatApprovalArguments(args); } return []; } export function formatApprovalPrompt(tool: ApprovalSubject, args: unknown, reason?: string): string { return [...approvalHeader(tool, reason), ...approvalDetails(tool, args)].join("\n"); }
```

```ts
// from: dist/types/tools/approval.d.ts:1-180 — import specifier "@oh-my-pi/pi-coding-agent/tools/approval"
import type { AgentTool, AgentToolContext, ToolApprovalDecision, ToolTier } from "@oh-my-pi/pi-agent-core";
import type { Settings } from "../config/settings.js";
import type { ExtensionApprovalAnswer, ExtensionApprovalPrompt, ExtensionUIContext } from "../extensibility/extensions/types.js";
import { type ApprovalGrantStore, type ApprovalGrants } from "./approval-cache.js";
export type { ToolApproval, ToolApprovalDecision, ToolTier } from "@oh-my-pi/pi-agent-core";
export type ApprovalPolicy = "allow" | "deny" | "prompt";
declare const APPROVAL_MODES: readonly ["always-ask", "always-ask-cached", "write", "yolo"];
export type ApprovalMode = (typeof APPROVAL_MODES)[number];
export type ApprovalContextSource = {
    autoApprove?: boolean;
    settings?: Settings;
};
export interface ResolvedExecuteTimeApproval {
    approvalMode: ApprovalMode;
    userPolicies: Record<string, unknown>;
}
type ApprovalSubject = Pick<AgentTool, "name" | "approval" | "formatApprovalDetails" | "approvalCacheTargets"> & {
    readonly legacyName?: string;
};
export declare function resolveApprovalFromContext(context?: ApprovalContextSource | null): ResolvedExecuteTimeApproval;
export interface ResolvedApproval {
    policy: ApprovalPolicy;
    tier: ToolTier;
    reason?: string;
    override: boolean;
    source?: "tool" | "user" | "mode" | "restriction";
    policyKey?: string;
}
export declare const TIER_RANK: Readonly<Record<ToolTier, number>>;
export declare function strictestApproval(decisions: Iterable<ToolApprovalDecision>): ToolApprovalDecision;
export declare function approvalFolderCandidate(tool: ApprovalSubject, args: unknown): {
    key: string;
    label: string;
} | undefined;
export declare function recordApprovalGrant(tool: ApprovalSubject, args: unknown, grants: ApprovalGrants, capability: ToolTier, answer: {
    grant: "folder" | "target";
    always: boolean;
}): void;
export declare function resolveToolTier(tool: ApprovalSubject, args: unknown): ToolTier;
export declare function resolveApproval(tool: ApprovalSubject, args: unknown, mode: ApprovalMode, userConfig?: Record<string, unknown>, grants?: ApprovalGrantStore): ResolvedApproval;
export declare function sessionApprovalScope(resolved: ResolvedApproval, toolName: string): {
    subject: string;
    key: string;
} | undefined;
export declare function denyError(resolved: ResolvedApproval, toolName: string): Error;
export declare function requiresApproval(tool: ApprovalSubject, args: unknown, mode: ApprovalMode, userConfig?: Record<string, unknown>): {
    required: boolean;
    reason?: string;
};
export declare function truncateForPrompt(value: string, maxChars?: number): string;
export declare function formatApprovalArguments(args: unknown, options?: {
    showEmpty?: boolean;
}): string[];
export declare function formatApprovalPrompt(tool: ApprovalSubject, args: unknown, reason?: string): string;
export declare function requestApproval(ui: Pick<ExtensionUIContext, "select" | "approve">, tool: ApprovalSubject, args: unknown, options?: {
    reason?: string;
    appendix?: readonly string[];
    sessionSubject?: string;
    grants?: boolean;
}): Promise<ExtensionApprovalAnswer>;
export declare function approvalOnceLabel(prompt: Pick<ExtensionApprovalPrompt, "grants">): string;
```

How the approval dialog reaches `requestApproval`, then `uiContext.approve` or a `select` fallback (`Allow tool:`):

```ts
// from: PKGROOT/src/extensibility/extensions/wrapper.ts:479
const uiContext = this.runner.getUIContext(); const safetyAppendix = pendingSafetyChecks.length > 0 ? ["Provider safety checks:", ...safetyCheckLines(pendingSafetyChecks)] : []; let approved: boolean; try { const answer = await requestApproval(uiContext, this.tool, resolvedArgs, { reason: approvalCheck.reason, appendix: safetyAppendix, sessionSubject: sessionScope?.subject, grants: cacheTargets, }); approved = answer !== "deny"; if (answer === "session" && sessionScope) this.runner.grantSessionApproval(sessionScope.key); if (typeof answer === "object" && approvalGrants) { recordApprovalGrant(this.tool, resolvedArgs, approvalGrants, resolved.tier, answer); } } catch (err) { await emitApprovalResolved(false, err instanceof Error ? err.message : "approval aborted"); cancelPreflight(); throw err; } await emitApprovalResolved(approved, approved ? undefined : "denied by user"); if (!approved) { cancelPreflight(); throw new Error(`Tool call denied by user: ${this.tool.name}`); }
```

```ts
// from: PKGROOT/src/eval/preludes.ts:154
context.signal?.throwIfAborted(); const settings = context.context?.settings ?? context.session.settings; const { approvalMode: mode, userPolicies: policies } = resolveApprovalFromContext( context.context ?? (settings ? { settings } : undefined), ); const subject: { name: string; approval?: ToolApproval } = { name: definition.name }; if (definition.approval !== undefined) subject.approval = definition.approval; const resolved = resolveApproval( subject, parameters, mode, policies, undefined, approvalRestrictions(settings, context.session.cwd), ); if (resolved.policy === "deny") throw denyError(resolved, definition.name); if (resolved.policy !== "prompt") return; const ui = context.context?.ui; if (!ui || context.context?.hasUI === false) { throw new Error( `Eval prelude "${definition.name}" requires approval but no interactive UI is available.\n` + `Set tools.approval.${definition.name}: allow or use an interactive UI to approve the call.`, ); } const answer = await untilAborted(context.signal, () => requestApproval(ui, subject, parameters, { reason: resolved.reason }), ); if (answer === "deny") throw new Error(`Eval prelude call denied by user: ${definition.name}`);
```

Compiled proof: `grep 'Allow tool:' PKGROOT/dist/cli.js` yields a single match on line 6274; the minified formatter is `EAo`/`RAo` there and the approval caller is `Sdt` (`requestApproval`). The emitted text is `Allow tool: <toolName>`, then `Origin: MCP server tool` for an `mcp__*` tool whose `approval` is undefined, then `Reason: <reason>`, then the `formatApprovalDetails(args)` lines, joined with a newline. `requestApproval` prefers `uiContext.approve({ full, compact, session?, grants? })`; without it, it awaits `uiContext.select(full, approvalChoiceLabels(choices))` — that option set is `[grant labels…, once, session?, "Deny"]`, not always exactly `["Approve", "Deny"]`.

Approval events around the dialog (block anchor below is exact):

```ts
// from: dist/types/extensibility/extensions/types.d.ts:1085-1100
export interface ToolApprovalRequestedEvent { type: "tool_approval_requested"; sessionId: string; toolCallId: string; toolName: string; reason?: string; approvalMode: ApprovalMode; }
export interface ToolApprovalResolvedEvent { type: "tool_approval_resolved"; sessionId: string; toolCallId: string; toolName: string; approved: boolean; reason?: string; }
```

## L. Discovery providers (src/discovery/*.ts) and the disable API

Provider ids — one `PROVIDER_ID` constant per discovery file (grepped from PKGROOT/src/discovery):

```
src/discovery/agent-plugins.ts:36   PROVIDER_ID = "agent-plugins"
src/discovery/agents-md.ts:13       PROVIDER_ID = "agents-md"
src/discovery/agents.ts:27          PROVIDER_ID = "agents"
src/discovery/builtin.ts:42         PROVIDER_ID = "native"
src/discovery/claude-md.ts:13       PROVIDER_ID = "claude-md"
src/discovery/claude-plugins.ts:32  PROVIDER_ID = "claude-plugins"
src/discovery/claude.ts:42          PROVIDER_ID = "claude"
src/discovery/cline.ts:15           PROVIDER_ID = "cline"
src/discovery/codex.ts:46           PROVIDER_ID = "codex"
src/discovery/cursor.ts:35          PROVIDER_ID = "cursor"
src/discovery/custom-context-files.ts:19  PROVIDER_ID = "custom-context"
src/discovery/gemini.ts:39          PROVIDER_ID = "gemini"
src/discovery/github.ts:40          PROVIDER_ID = "github"
src/discovery/mcp-json.ts:17        PROVIDER_ID = "mcp-json"
src/discovery/omp-plugins.ts:43     PROVIDER_ID = "omp-plugins"
src/discovery/opencode.ts:47        PROVIDER_ID = "opencode"
src/discovery/skillshare.ts:27      export const SKILLSHARE_PROVIDER_ID = "skillshare"
src/discovery/ssh-config.ts:20      PROVIDER_ID = "ssh-config"
src/discovery/ssh.ts:16             PROVIDER_ID = "ssh-json"
src/discovery/vscode.ts:15          PROVIDER_ID = "vscode"
src/discovery/windsurf.ts:29        PROVIDER_ID = "windsurf"
```

(`src/discovery/index.ts` additionally imports the capability domains in `src/capability/`: context-file, extension, extension-module, hook, instruction, mcp, prompt, rule, settings, skill, slash-command, ssh, system-prompt, tool — those register capabilities, not discovery providers.) 19.0 新增的 `ssh-config` 读 `~/.ssh/config` 与 `/etc/ssh/ssh_config`（跟随 `Include`），属于隔离根外的目录，Poietica 把它列进禁用名单。The disable API is section A.2: `disableProvider(providerId)` / `enableProvider` / `isProviderEnabled` / `getDisabledProviders` / `setDisabledProviders` / `enableUserSource` / `disableUserSource`, imported from `@oh-my-pi/pi-coding-agent/capability` or `/discovery`. Persisted form: the settings ids `enabledProviders` and `disabledProviders` (PKGROOT/src/config/model-settings.ts:71,:78).

## M. buildSkillPromptMessage, tagImageAttachmentSource, SKILL_PROMPT_MESSAGE_TYPE

```ts
// from: dist/types/extensibility/skills.d.ts:137-195, :88-111
export interface BuiltSkillPromptMessage { message: string; details: SkillPromptDetails; }
export declare function getSkillSlashCommandName(skill: Pick<Skill, "name">): string;
export interface ParsedSkillInvocation { name: string; args: string; prompt: string; }
export declare function parseSkillInvocation(text: string): ParsedSkillInvocation | undefined;
export type SkillInvocationKind = "user" | "autoload";
export type SkillPromptInput = Pick<ParsedSkillInvocation, "args"> & Partial<Pick<ParsedSkillInvocation, "prompt">>;
export declare function buildSkillPromptMessage(skill: Pick<Skill, "name" | "filePath" | "baseDir">, input: SkillPromptInput, invocation?: SkillInvocationKind): Promise<BuiltSkillPromptMessage>;
```

`tagImageAttachmentSource`: **NOT FOUND** in `@oh-my-pi/pi-coding-agent` (searched PKGROOT/dist/types and PKGROOT/src recursively; the name appears only as call sites in `PKGROOT/src/modes/controllers/input-controller.ts:68,:2032,:2078`, which import it from pi-tui). It is exported by pi-tui:

```ts
// from: TUIROOT/dist/types/prompt/image-source.d.ts:10-28 — import specifier "@oh-my-pi/pi-tui/prompt/image-source"
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
// from: TUIROOT/dist/types/chat/messages.d.ts:17-56 and :40-54 — import specifier "@oh-my-pi/pi-tui/chat/messages"
export declare const SKILL_PROMPT_MESSAGE_TYPE = "skill-prompt";
export interface SkillPromptDetails { name: string; path: string; args?: string; prompt?: string; lineCount: number; __queueChipText?: string; }
```

`SKILL_PROMPT_MESSAGE_TYPE` is re-exported by the coding agent at `dist/types/session/messages.d.ts:9` (`export { SKILL_PROMPT_MESSAGE_TYPE, LSP_LATE_DIAGNOSTIC_MESSAGE_TYPE, BACKGROUND_TAN_DISPATCH_MESSAGE_TYPE, PREWALK_PLAN_MESSAGE_TYPE, VIBE_MODE_CONTEXT_MESSAGE_TYPE, DEFAULT_CUSTOM_MESSAGE_TYPE, LIVE_DELEGATION_MESSAGE_TYPE, ... } from "@oh-my-pi/pi-tui/chat/messages"`) and therefore by the package root (`dist/types/index.d.ts:32` = `export * from "./session/messages.js"`). `SkillPromptDetails` is declared in pi-tui (`TUIROOT/dist/types/chat/messages.d.ts:40-54`, shown above) and re-exported here.

## N. Session files: location and .jsonl layout

Sessions root = `getSessionsDir(agentDir?)` = `<agentDir>/sessions`; agent dir default `~/.omp/agent` (overridable by `PI_CODING_AGENT_DIR` / XDG redirects). Verified on this machine: both the global `~/.omp/agent/sessions` and the app's isolated `<APPDATA>\Poietica\omp\agent\sessions` exist with the buckets `--D--xiaojianc-poietica--` and `--D--xiaojianc-poietica-packages-agent-bridge--`. The global root has no `*.jsonl` (isolation holds); the isolated root has real sessions — the layout below was re-verified against 9 live files.

```ts
// from: UTILSROOT/dist/types/dirs.d.ts:332 (getSessionsDir)
export declare function getSessionsDir(agentDir?: string): string;
```

```ts
// from: PKGROOT/src/session/session-manager.ts:4290-4304 (session file name and header write)
	static createEmptySessionFile(cwd: string, storage: SessionStorage = new FileSessionStorage()): string { const sessionDir = SessionManager.getDefaultSessionDir(cwd, undefined, storage); const id = mintSessionId(); const timestamp = nowIso(); const header: SessionHeader = { type: "session", version: CURRENT_SESSION_VERSION, id, timestamp, cwd: path.resolve(cwd), }; const file = path.join(sessionDir, `${fileSafeTimestamp(timestamp)}_${id}.jsonl`); storage.writeTextSync(file, `${serializeTitleSlot({ updatedAt: timestamp })}${JSON.stringify(header)}\n`); return file; }
```

```ts
// from: PKGROOT/src/session/session-title-slot.ts:112-130 (fixed-width title slot)
export function serializeTitleSlot(options: SessionTitleUpdate): string { const title = truncateTitleForSlot(options.title ?? "", options.source, options.updatedAt); const unpadded = titleSlotLine(title, options.source, options.updatedAt, ""); const padBytes = SESSION_TITLE_SLOT_BYTES - byteLength(unpadded); if (padBytes < 0) throw new Error("Session title slot metadata exceeds fixed slot size"); const line = titleSlotLine(title, options.source, options.updatedAt, " ".repeat(padBytes)); if (byteLength(line) !== SESSION_TITLE_SLOT_BYTES) { throw new Error("Session title slot serialization failed to produce fixed-width output"); } return line; }
export function overlayTitleSlotContent(content: string, update: SessionTitleUpdate): string { const slot = Buffer.from(serializeTitleSlot(update), "utf-8"); const existing = Buffer.from(content, "utf-8"); if (existing.length <= slot.length) return slot.toString("utf-8"); return Buffer.concat([slot, existing.subarray(slot.length)]).toString("utf-8"); }
```

```ts
// from: PKGROOT/src/session/session-loader.ts:382-407 (first line peeled as the title slot)
 sink.append(chunk);
 if (!sawFirstLine) { const buffered = sink.flush()!; const newline = buffered.indexOf(0x0a); if (newline !== -1) { sawFirstLine = true; const firstLine = decoder.decode(buffered.subarray(0, newline)).trim(); if (firstLine) { const slot = parseTitleSlotLine(firstLine); if (slot) { titleSlot = titleUpdateFromSlot(slot); sink.consume(newline + 1); } } } }
```

Directory naming (PKGROOT/src/session/session-paths.ts): `encodeLegacyAbsoluteSessionDirName(cwd)` (:44) = `--` + cwd without its leading separator, with every `/`, backslash and `:` replaced by `-`, + `--` (so `D:\xiaojianc\poietica` becomes `--D--xiaojianc-poietica--`); `encodeRelativeSessionDirName(prefix, relative)` (:49) joins with `-` (prefix `-tmp` under the temp root, `-` under home); `getDefaultSessionDirName` (:76) checks the temp root first, then home-relative, else the absolute form; `computeDefaultSessionDir` (:212) = `path.join(sessionsRoot, encodedDirName)`. Artifacts live in a sibling directory named like the session file minus its `.jsonl` suffix (session-storage.ts:1146-1156).

```ts
// from: dist/types/session/session-entries.d.ts:9-105, :52-57
export declare const CURRENT_SESSION_VERSION = 3;
export declare const SESSION_TITLE_SLOT_BYTES = 256;
export declare const SESSION_TITLE_SLOT_ENTRY_TYPE = "title";
export declare const TITLE_CHANGE_ENTRY_TYPE = "title_change";
export type SessionTitleSource = "auto" | "user";
export interface SessionTitleSlotEntry { type: typeof SESSION_TITLE_SLOT_ENTRY_TYPE; v: 1; title: string; source?: SessionTitleSource; updatedAt: string; pad: string; }
export interface SessionEntryBase { type: string; id: string; parentId: string | null; timestamp: string; }
```

```ts
// from: dist/types/session/session-entries.d.ts:379-399
export type SessionEntry = SessionMessageEntry | ModelUsageEntry | ThinkingLevelChangeEntry | ModelChangeEntry | ServiceTierChangeEntry | CompactionEntry | BranchSummaryEntry | CustomEntry | CustomMessageEntry | LabelEntry | TitleChangeEntry | TtsrInjectionEntry | SessionInitEntry | ModeChangeEntry | CredentialPinEntry | ResetBoundaryEntry;
export type FileEntry = SessionHeader | SessionEntry;
export type RawFileEntry = SessionTitleSlotEntry | FileEntry;
export interface SessionTreeNode { entry: SessionEntry; children: SessionTreeNode[]; label?: string; }
```

Per-entry variants in dist/types/session/session-entries.d.ts (names + line numbers; all extend `SessionEntryBase` = `{ type: string; id: string; parentId: string | null; timestamp: string }`): `SessionMessageEntry:106`, `ModelUsageEntry:141`, `ThinkingLevelChangeEntry:171`, `ModelChangeEntry:181`, `ServiceTierChangeEntry:190`, `CompactionEntry:194`, `BranchSummaryEntry:219`, `ResetBoundaryEntry:236`, `CustomEntry:249`, `LabelEntry:255`, `TitleChangeEntry:261`, `TtsrInjectionEntry:276`, `CredentialPinEntry:291`, `SessionInitEntry:299`, `ModeChangeEntry:348`, `CustomMessageEntry:367`.

Physical format: one JSON object per line, UTF-8, newline-terminated (`SessionStorageWriter.append` requires the trailing newline — `dist/types/session/session-storage.d.ts:16-30`). The first physical line is the title slot: `serializeTitleSlot` pads it so the **line including its own `\n`** is exactly `SESSION_TITLE_SLOT_BYTES` = 256 bytes (all 9 live files measured 256 with the newline, 255 without); the `pad` field is whatever padding is left after the metadata. Every later line is a typed entry. Concrete shape (from the types above, `createEmptySessionFile`, and the live files — the first two lines are quoted from a real session, the rest are the documented shapes):

```
{"type":"title","v":1,"title":"Fix CoreSupervisor launch failure per P2","source":"auto","updatedAt":"2026-10-16T04:50:12.679Z","pad":"<118 spaces>"}
{"type":"session","version":3,"id":"01a1430a-14c1-7487-8228-a5550edbe335","timestamp":"2026-10-16T04:48:16.577Z","cwd":"D:\\xiaojianc\\poietica"}
{"type":"message","id":"<entryId>","parentId":null,"timestamp":"...","message":{"role":"user","content":[{"type":"text","text":"hi"}]}}
{"type":"model_change","id":"...","parentId":"<prevEntryId>","timestamp":"...","model":"anthropic/claude-opus-4-5"}
{"type":"custom_message","id":"...","parentId":"...","timestamp":"...","customType":"skill-prompt","content":"...","display":true,"details":{"name":"...","path":"...","args":"...","lineCount":3},"attribution":"..."}
{"type":"custom","id":"...","parentId":"...","timestamp":"...","customType":"system-prompt-digest","data":"c295d636c3e2e072"}
```

## O. /btw side questions — rpc-btw, btw-turn, btw-history

The auxiliary dock's side chat (engine `askSide` / `cancelSide` / `sideTopics`) is a thin wrapper over omp's RPC `/btw` controller (`packages/engine-omp/src/session/side-questions.ts`, omp knowledge #21). The controller is constructed per session from the live `AgentSession`; it runs **one side question at a time** against the main session's current model + system prompt + history (in-flight streaming text included), never blocks or alters the main turn, and checkpoints every turn into a per-session history sidecar so TUI and RPC hosts read and continue the same topics.

```ts
// from: src/modes/rpc/rpc-btw.ts:40-259
export class RpcBtwController {
 constructor(session: Pick<AgentSession, "model" | "runEphemeralTurn" | "sessionManager">, output: (frame: RpcBtwOutputFrame) => void,) {
 async ask(question: string, recordId?: string): Promise<RpcBtwHistoryRecord> {
 cancel(recordId?: string): boolean {
 async history(): Promise<readonly RpcBtwHistoryRecord[]> {
 async close(): Promise<void> {
```

`ask` resolves once the new turn is checkpointed as `running` (a new topic when `recordId` is omitted, otherwise a follow-up in that topic); the answer then streams through `output`. `cancel()` without an id stops whatever is running. `close()` flushes pending checkpoints; poietica calls it from `dispose` before the session itself is disposed.

```ts
// from: src/modes/rpc/rpc-types.ts:712-725
export type RpcBtwHistoryRecord = Omit<BtwHistoryRecord, "title">;
export interface RpcBtwDeltaFrame { type: "btw_delta"; recordId: string; delta: string; }
export interface RpcBtwRecordFrame { type: "btw_record"; record: RpcBtwHistoryRecord; }
```

The controller's private output union also carries `{ type: "notice"; level: "error"; message: string; source: "btw-history" }` for sidecar read/write failures (mapped to the engine's `sideNotice`). A `btw_record` frame arrives on every lifecycle change (started, complete, cancelled, error); deltas only ever extend the **latest** turn of the running record, so the engine computes `turn`/`offset` itself and drops deltas that arrive after the record settled.

```ts
// from: src/session/btw-history.ts:8-27
export { type BtwHistoryRecord, type BtwHistoryTurn, getBtwCopyText, getBtwLatestTurn, getBtwRecordInject, getBtwTurns, getBtwTurnKey, } from "@oh-my-pi/pi-tui/overlays/btw-history";
const turnFields = { question: "string", "images?": imageSchema.array(), answer: "string", status: "'running' | 'complete' | 'cancelled' | 'error' | 'interrupted'", createdAt: "0 <= number <= 8640000000000000", updatedAt: "0 <= number <= 8640000000000000", "error?": "string", } as const;
```

```ts
// from: TUIROOT/src/overlays/btw-history.ts:4-34, :32-34
export interface BtwHistoryTurn { question: string; images?: readonly ImageContent[]; answer: string; status: "running" | "complete" | "cancelled" | "error" | "interrupted"; createdAt: number; updatedAt: number; error?: string; }
export interface BtwHistoryRecord extends BtwHistoryTurn { id: string; leafId: string | null; title?: string; followUps?: readonly BtwHistoryTurn[]; }
export function getBtwTurns(record: BtwHistoryRecord): readonly BtwHistoryTurn[] {
```

A record **is** its first turn; follow-ups hang off it. The engine flattens this into `SideTopic { id, leafId, turns }` (`getBtwTurns` order). `interrupted` marks a turn that was `running` when its process died — the sidecar is reread with it on the next open.

```ts
// from: src/session/btw-turn.ts:21-120
export function beginBtwTurn(question: string, leafId: string | null, previous?: BtwHistoryRecord): BtwTurnStart {
export function runBtwTurn(
```

`runBtwTurn` replays earlier turns of the topic as detached context messages (rendered through `prompts/system/btw-user.md`, which tells the model "NEVER use tools") and calls `runEphemeralTurn`. A cancelled or failed turn rotates the provider `conversationKey`, so a retry starts a fresh lineage.

```ts
// from: src/session/agent-session.ts:14248-14451
async runEphemeralTurn(args: EphemeralTurnOptions): Promise<EphemeralTurnResult> {
```

Per its JSDoc and `EphemeralTurnOptions.tools` (src/session/agent-session-types.ts:582): the main turn's tool catalog is still sent (prompt-cache reuse), but **tool calls are never executed**, and the session's history and persisted state are not modified. This is why the side chat has no tool, approval, plan or goal controls: it can only answer from context the main conversation already holds.

Storage and lifecycle facts poietica relies on:

- History lives under the session's artifacts directory, `btw-history/` (`historyDirectory`, src/session/btw-history.ts:80), one `entry-<id>.json` per topic; a session that has never been written to disk (no artifacts dir) keeps its topics in memory only.
- Forking a session copies its artifacts directory, so the fork starts with the parent's side topics; deleting a session removes them with the artifacts.
- `ask` while a side question is running is rejected by the controller; the engine pre-checks this (`engine.side_busy`) and also rejects with `engine.side_unavailable` when the session has no model.

## P. MCP manager ownership — owned vs. borrowed managers

`createAgentSession` either **owns** an MCP manager or **borrows** one, decided by a single option (omp knowledge #22, `packages/engine-omp/src/session/mcp-workspaces.ts`). Without `options.mcpManager` and with `hasUI: true` it builds a fresh `MCPManager` per session, starts discovery in the background once the session exists, and disconnects every server when the session is disposed. Poietica opens and closes sessions with the thread surface, so the owned model restarted every MCP process on every thread switch.

```ts
// from: dist/types/sdk.d.ts:319-330
mcpManager?: MCPManagerApi;
mcpTools?: CustomTool[];
mcpToolScope?: MCPToolScope;
```

A borrower runs no discovery and never disconnects; it passes its **own tool view** (`mcpToolScope`, a string) so a shared manager keeps per-session tool lists (subagents start from the spawner's view). The single-slot callbacks and the `mcp.notifications` listener are wired **only by the owner**; the notification bridge to the session's extensions is installed for every session, and `MCPManager.setInstance(manager)` still runs for every top-level session.

**Host model (19.0)**: servers no longer run one-per-manager. `MCPManager` talks to an MCP host — the omp daemon's `mcp` module when `mcp.shared` is on and a daemon answers, else an in-process host (`src/mcp/host/access.ts`, `local.ts`). One host unit is one upstream server:

- a **modern** (2026-07-28) server is stateless and shared by every manager; the unit idles out after `idleMs` (`mcp.idleStopMinutes`), `0` never stops it;
- a **legacy** (handshake-era) server keeps its session in the process, so each manager gets its own unit (`mcpUnitKey` = identity + manager owner id) and it stops when the manager lets go;
- `mcpIdentity` = command + args + cwd + declared env + credential-looking inherited env (so different working directories are different units).

There is **no `MCPToolCache`** export any more (the tool cache lives in the host's store); `new MCPManager(cwd, loadConfigs?, idleMs?)`.

Tools follow the shared manager the way omp's subagents do — both now take a scope:

```ts
// from: dist/types/task/executor.d.ts:368-408,383,408 — import specifier "@oh-my-pi/pi-coding-agent/task/executor"
export declare function createMCPProxyTools(mcpManager: MCPManagerApi, scope: MCPToolScope): CustomTool[];
export interface MCPToolView { scope: MCPToolScope; seed?: MCPToolScope; }
export declare function followMCPTools(mcpManager: MCPManagerApi, view: MCPToolView, reservedNames?: ReadonlySet<string>): MCPToolFollower;
```

Subscribe (`followMCPTools`) **before** building proxies; `bind(session)` replays any change seen in between and registers the unsubscribe as a session disposer. Proxies re-resolve the source tool by server + tool name on every call, so a reconnect that replaced the tool instance is picked up. A tool a server adds while another session's call runs reaches a session only after that session's own call to the server, so one session loading tools never rewrites another's tool list.

```ts
// from: dist/types/session/agent-session.d.ts:100 — import specifier "@oh-my-pi/pi-coding-agent/session/agent-session"
export declare const MCP_DISCOVERY_TURN_WAIT_MS = 1500;
// and on AgentSession: refreshMCPTools(mcpTools), setPendingMCPDiscovery(discovery), setMCPPromptCommands(commands)
```

```ts
// from: dist/types/mcp/manager.d.ts:98-398 — import specifier "@oh-my-pi/pi-coding-agent/mcp/manager"
getTools(scope?: MCPToolScope): CustomTool<TSchema, MCPToolDetails>[];
openToolScope(scope: MCPToolScope, seed?: MCPToolScope): void;
trackToolCall(scope: MCPToolScope, toolCallId: string): () => void;
addConnectionStatusListener(listener: (event: McpConnectionStatusEvent) => void): () => void;
addToolsChangedListener(listener: () => void): () => void;
setOnResourcesChanged(handler: (serverName: string, uri: string) => void): void;
setOnPromptsChanged(handler: (serverName: string) => void): void;
setNotificationsEnabled(enabled: boolean): void;
discoverAndConnect(options?: MCPDiscoverOptions): Promise<MCPLoadResult>;
reconcileProjectConfig(enabled: boolean): Promise<void>;
waitForStartup(timeoutMs: number): Promise<MCPStartupStatus>;
disconnectAll(): Promise<void>;
```

Facts poietica relies on:

- A turn waits for the pending discovery set by `setPendingMCPDiscovery` at most `MCP_DISCOVERY_TURN_WAIT_MS`, and only the first turn pays it. A session that borrows an already-settled manager gets its tools through `refreshMCPTools` before it is handed out, so its first turn waits for nothing.
- `options.mcpTools !== undefined` counts as a changed cache shape and drops the `providerPromptCacheKey` a resumed fork would inherit. Poietica therefore passes only `mcpManager` + `mcpToolScope` and refreshes the tools after creation, which is the path omp's own deferred discovery takes.
- `setOnPromptsChanged` replays at once for servers that already have prompts. `disconnectAll` aborts handshakes in flight, but a discovery still reading configs can connect afterwards, so the owner disconnects again once discovery settles (omp's deferred path does the same).
- Config files are read through a process-wide content cache (`src/capability/fs.ts`) that only `mcp/config-writer` invalidates. Reusing a manager is decided by comparing `loadAllMCPConfigs` output (≈1 ms warm), so it sees exactly what a fresh discovery would see. Tests that write `mcp.json` directly must call `invalidate` from `@oh-my-pi/pi-coding-agent/capability/fs`.
- Because a **modern** unit is shared process-wide, two managers with the same server spec share its process; only a changed spec (including `cwd`) or a legacy server starts another. Our workspace grace period therefore still controls when a manager lets go, but the upstream may linger for `idleMs` if a non-zero value is configured.

## Q. File writes: before/after text lives in the tool result, not on disk

Revoking a turn's file edits needs the text that was there **before** the write (omp knowledge #23, `packages/engine-omp/src/session/file-changes.ts`). It exists in exactly one place and only after the fact: the edit tool's result details. Nothing on the session or filesystem surface hands it back once the file is rewritten.

```ts
// from: TUIROOT/dist/types/tools/edit.d.ts:4-51 — EditToolPerFileResult (one per changed file)
export interface EditToolPerFileResult {
    path: string;
    oldText?: string;
    newText?: string;
    snapshotsPruned?: boolean;
}
```

```ts
// from: TUIROOT/dist/types/tools/edit.d.ts:4-80 — EditToolDetails (single-path edits carry the pair at top level too)
export interface EditToolDetails {
    perFileResults?: EditToolPerFileResult[];
    oldText?: string;
    newText?: string;
    snapshotsPruned?: boolean;
}
```

Facts poietica relies on:

- `oldText` is absent for a create (`op: "create"`) and `newText` is absent for a delete — neither means "empty file". A consumer that reads a missing side as `""` will replace a new file with an empty one on undo.
- A multi-file edit puts one entry per file in `perFileResults`; a single-path edit repeats the same pair at the top level. Reading only `perFileResults` misses single-file edits.
- `pruneOversizedEditSnapshots` drops `oldText`/`newText` from entries once they get large and sets `snapshotsPruned`; that flag is the only way to tell "pruned" from "not applicable".
- The `write` tool's details carry no content at all (`WriteToolResultEvent.details: undefined`), so its after-side must be read from disk. The before-side has to be captured **before** the tool runs — `tool_execution_start` is the last moment it is still there.
- omp writes files only through its own tools (`write`, `edit`, `ast_edit`, `apply_patch`); `bash`/`eval` editing files leave no trace here.
