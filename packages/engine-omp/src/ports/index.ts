// 端口的显式命名 re-export（12 页 §10）。这里刻意不用 `export *`：
// 端口是引擎对外的门面，多导出一样东西就是多一条别人可以绕过的缝。
export { type McpPortDeps, OmpMcpPort } from './mcp'
export { type ModelsPortDeps, OmpModelsPort } from './models'
export {
  CustomProvidersFile,
  type CustomProvidersFileDeps,
  type ModelsFileProvider,
  modelsFilePath,
} from './models-file'
export { OmpPluginsPort, type PluginsPortDeps } from './plugins'
export { OmpSessionFilesPort, type SessionFilesPortDeps } from './session-files'
export { OmpSettingsPort, type SettingsPortDeps } from './settings'
export {
  descriptionOf,
  GROUP_LABELS,
  groupLabelOf,
  isProductSetting,
  labelOf,
  memorySettingOf,
  optionLabelOf,
  ownedElsewhereOf,
  personaSettingOf,
  SETTING_DESCRIPTIONS,
  SETTING_LABELS,
  sectionOf,
} from './settings-catalog'
export { OmpSkillsPort, type SkillsPortDeps } from './skills'
