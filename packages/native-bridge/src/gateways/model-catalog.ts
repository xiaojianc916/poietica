import {
  commands,
  events,
  type JsonValue,
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
import { throughIpc } from '../error'

/*
 * 模型目录在桌面端的传输口。
 *
 * 端口类型是 @poietica/settings 的领域形状（可选格），线上类型是生成绑定
 * （可缺席的格一律 null）。两种形状说的是同一件事，差别只在「缺席怎么写」，
 * 所以翻译只有 null 与 undefined 的对齐，没有第二张字段表。回方向逐格同名
 * 同义，直接按端口类型交出去。
 */
export function createModelCatalogPort(): ModelCatalogPort {
  return {
    execute: (agentId, operation) =>
      throughIpc(() =>
        commands.agentModelCatalog({
          launch: { agentId },
          cwd: null,
          operation: intoDto(operation),
        }),
      ),

    subscribeInvalidation: (listener) =>
      events.agentSessionEvent.listen((event) => {
        if (event.payload.kind === 'modelCatalogChanged') {
          listener()
        }
      }),
  }
}

function intoDto(operation: ModelCatalogOperation): ModelCatalogOperationDto {
  switch (operation.kind) {
    case 'snapshot':
      return { kind: 'snapshot' }
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
    case 'importRegistry':
      return { kind: 'importRegistry', url: operation.url, apiKey: operation.apiKey ?? null }
    case 'setDefault':
      return { kind: 'setDefault', modelId: operation.modelId }
    case 'patchConfig':
      /* 端口侧只说「一张补丁」，线上形状是 JsonValue：翻译层这一处断言对齐两种写法。 */
      return { kind: 'patchConfig', patch: operation.patch as JsonValue }
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
