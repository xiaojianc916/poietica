import { type SettingView, settingsErrors } from '@poietica/feature-settings/contract'
import type { SettingsProvider } from '@poietica/feature-settings/core-api'
import { AppError } from '@poietica/foundation'
import type { SettingDescriptor, SettingsPort } from '@poietica/runtime-protocol'

const PREFIX = 'omp.'
const PYTHON_KEY = 'omp.python.interpreter'
const PYTHON_PATH = 'python.interpreter'

const typeOf = (descriptor: SettingDescriptor): SettingView['definition']['type'] =>
  descriptor.type === 'enum' ? 'select' : descriptor.type

const viewOf = (descriptor: SettingDescriptor): SettingView => {
  const definition: SettingView['definition'] = {
    key: `${PREFIX}${descriptor.path}`,
    label: descriptor.label,
    description: descriptor.description,
    type: typeOf(descriptor),
    scopes: ['global'],
    defaultValue: descriptor.defaultValue,
    ...(descriptor.options === null
      ? {}
      : {
          options: descriptor.options.map((option) => ({
            value: option.value,
            label: option.label,
          })),
        }),
    sensitive: descriptor.secret,
    restart: false,
  }
  return {
    definition,
    value: descriptor.secret ? null : descriptor.value,
    source: descriptor.hasValue ? 'global' : 'default',
    configured: descriptor.hasValue,
  }
}

/**
 * omp 自有设置的只读/直写后端（§17）：值仍在 omp 配置里，注册表不复制。
 * 凭据类设置只进引擎运行时覆盖层（ADR-008），这里也只转发 injectSecret。
 */
export function createOmpSettingsProvider(settings: SettingsPort): SettingsProvider {
  const writeCatalog = async (path: string, value: unknown): Promise<void> => {
    const descriptor = (await settings.catalog()).find((entry) => entry.path === path)
    if (descriptor === undefined) throw new AppError(settingsErrors.unknown_key, `omp 设置不存在：${path}`)
    if (descriptor.secret) {
      if (value !== null && typeof value !== 'string') {
        throw new AppError(settingsErrors.invalid_value, `凭据设置 ${path} 只接受字符串或 null`)
      }
      await settings.injectSecret(path, value)
      return
    }
    if (value === descriptor.defaultValue) {
      await settings.reset(path)
      return
    }
    await settings.set(path, value)
  }

  return {
    id: 'omp',
    owns: (key) => key.startsWith(PREFIX),
    async describe() {
      const catalog = (await settings.catalog()).map(viewOf)
      const interpreter = await settings.getPythonInterpreter()
      return [
        ...catalog,
        {
          definition: {
            key: PYTHON_KEY,
            label: 'Python 解释器',
            description: '内置 Python 环境或自定义解释器路径',
            type: 'string',
            scopes: ['global'],
            defaultValue: null,
            sensitive: false,
            restart: false,
          },
          value: interpreter,
          source: interpreter === null ? 'default' : 'global',
          configured: interpreter !== null,
        },
      ]
    },
    async set(input) {
      if (input.scope !== 'global') throw new AppError(settingsErrors.invalid_scope, 'omp 设置只支持 global 作用域')
      const path = input.key.slice(PREFIX.length)
      if (path === PYTHON_PATH) {
        if (input.value !== null && typeof input.value !== 'string') {
          throw new AppError(settingsErrors.invalid_value, 'Python 解释器只接受路径或 null')
        }
        await settings.setPythonInterpreter(input.value)
        return
      }
      await writeCatalog(path, input.value)
    },
  }
}
