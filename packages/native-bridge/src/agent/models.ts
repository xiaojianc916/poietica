import {
  commands,
  events,
  type ModelCatalogOperationDto,
  type ProviderInputDto,
  type ProviderModelInputDto,
  type ProviderReplacementDto,
} from '@poietica/contract'
import type {
  ModelCatalogOperation,
  ModelCatalogPort,
  ProviderInput,
  ProviderModelInput,
  ProviderReplacement,
} from '@poietica/settings'
import { throughIpc } from '../ipc-error'

/*
 * 模型目录在桌面端的传输口。
 *
 * 端口类型是 @poietica/settings 的领域形状（可选格），线上类型是生成绑定
 * （可缺席的格一律 null）。两种形状说的是同一件事，差别只在「缺席怎么写」，
 * 所以翻译只有 null 与 undefined 的对齐，没有第二张字段表。回方向逐格同名
 * 同义，直接按端口类型交出去。
 *
 * `cwd` 是**当前活动工作区**，不是这条读的上下文：这条读与工作区无关，但它可能替
 * 整条进程起出第一条连接，那一刻它就是锚。从前这里写死 null，于是锚落在兜底根上，
 * 随后「恢复上次对话」按真工作区重锚就把这条读正在用的连接拆了 —— 首启一次
 * 「agent 连接失败」。锚只有一个产地：活动工作区（与开新对话同一个值）。
 */
export function createModelCatalogPort(cwd: () => string | null): ModelCatalogPort {
  return {
    execute: (operation) =>
      throughIpc(() =>
        commands.agentModelCatalog({
          cwd: cwd(),
          operation: intoDto(operation),
        }),
      ),

    /* 端口要的是 Promise（它按异步清理写）；订阅本身是同步的，所以立刻兑现。 */
    subscribeInvalidation: async (listener) =>
      events.agentSessionEvent((payload) => {
        if (payload.kind === 'modelCatalogChanged') {
          listener()
        }
      }),
  }
}

function intoDto(operation: ModelCatalogOperation): ModelCatalogOperationDto {
  switch (operation.kind) {
    case 'snapshot':
      return { kind: 'snapshot' }
    case 'refreshProviders':
      return { kind: 'refreshProviders' }
    case 'create':
      return { kind: 'create', provider: inputDto(operation.provider) }
    case 'replace':
      return {
        kind: 'replace',
        providerId: operation.providerId,
        provider: replacementDto(operation.provider),
      }
    case 'delete':
      return { kind: 'delete', providerId: operation.providerId }
    case 'importCatalog':
      return {
        kind: 'importCatalog',
        catalogId: operation.catalogId,
        apiKey: operation.apiKey ?? null,
        baseUrl: operation.baseUrl ?? null,
        id: operation.id ?? null,
      }
    case 'setDefault':
      return { kind: 'setDefault', modelId: operation.modelId }
  }
}

function modelInputDto(model: ProviderModelInput): ProviderModelInputDto {
  return {
    model: model.model,
    maxContextSize: model.maxContextSize,
    displayName: model.displayName ?? null,
    capabilities: model.capabilities === undefined ? null : [...model.capabilities],
    maxOutputSize: model.maxOutputSize ?? null,
    supportEfforts: model.supportEfforts === undefined ? null : [...model.supportEfforts],
    adaptiveThinking: model.adaptiveThinking ?? null,
  }
}

function inputDto(provider: ProviderInput): ProviderInputDto {
  return {
    id: provider.id,
    providerType: provider.providerType,
    apiKey: provider.apiKey ?? null,
    baseUrl: provider.baseUrl ?? null,
    defaultModel: provider.defaultModel ?? null,
    models: provider.models.map(modelInputDto),
  }
}

function replacementDto(provider: ProviderReplacement): ProviderReplacementDto {
  return {
    newId: provider.newId ?? null,
    providerType: provider.providerType,
    apiKey: provider.apiKey ?? null,
    baseUrl: provider.baseUrl ?? null,
    defaultModel: provider.defaultModel ?? null,
    models: provider.models.map(modelInputDto),
  }
}
