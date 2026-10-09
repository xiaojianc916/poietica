export type Runtime = 'neutral' | 'dom' | 'node' | 'bun' | 'electron-main'
export type FeaturePart = 'core' | 'core-api' | 'host' | 'ui' | 'ui-api'
export type FileMap = Record<string, string>

export const KEBAB = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/
export const RUNTIMES: readonly Runtime[] = ['neutral', 'dom', 'node', 'bun', 'electron-main']
export const FEATURE_PARTS: readonly FeaturePart[] = ['core', 'core-api', 'host', 'ui', 'ui-api']

const json = (v: unknown) => `${JSON.stringify(v, null, 2)}\n`
export const camel = (id: string) => id.replace(/-([a-z0-9])/g, (_, c: string) => c.toUpperCase())

function runtimeDevDeps(runtime: Runtime): Record<string, string> {
  switch (runtime) {
    case 'bun':
      return { '@types/bun': 'catalog:' }
    case 'node':
      return { '@types/node': 'catalog:' }
    case 'electron-main':
      return { '@types/node': 'catalog:', electron: 'catalog:' }
    case 'dom':
      return { '@types/react': 'catalog:' }
    case 'neutral':
      return {}
  }
}

export function renderPackage(name: string, runtime: Runtime): FileMap {
  return {
    [`packages/${name}/package.json`]: json({
      name: `@poietica/${name}`,
      version: '0.0.0',
      private: true,
      type: 'module',
      exports: { '.': './src/index.ts' },
      dependencies: {},
      devDependencies: runtimeDevDeps(runtime),
    }),
    [`packages/${name}/tsconfig.json`]: json({
      extends: `../../tooling/tsconfig/${runtime}.json`,
      include: ['src'],
      references: [],
    }),
    [`packages/${name}/src/index.ts`]: `// @poietica/${name}\nexport {}\n`,
    [`packages/${name}/README.md`]: `# @poietica/${name}\n\n（一句话说明职责；见架构文档 03 页 §2.2。）\n`,
  }
}

const PART_RUNTIME: Record<FeaturePart | 'contract', Runtime> = {
  contract: 'neutral',
  'core-api': 'neutral',
  core: 'bun',
  host: 'electron-main',
  ui: 'dom',
  'ui-api': 'dom',
}

function partSource(id: string, part: FeaturePart | 'contract'): FileMap {
  const c = camel(id)
  switch (part) {
    case 'contract':
      return {
        'index.ts': `import { defineContract } from '@poietica/contract-kit'\nimport { ${c}Errors } from './errors'\n\nexport * from './entities'\nexport { ${c}Errors } from './errors'\n\nexport const ${c}Contract = defineContract({\n  id: '${id}',\n  namespaces: ['${c}'],\n  methods: [],\n  notifications: [],\n  errors: ${c}Errors,\n})\n`,
        'entities.ts': `// ${id} 的 zod 实体（07 页对应小节）\nexport {}\n`,
        'errors.ts': `import { defineErrors } from '@poietica/contract-kit'\n\nexport const ${c}Errors = defineErrors('${id}', {})\n`,
      }
    case 'core':
      return {
        'index.ts': `import { defineCoreModule } from '@poietica/core-kernel'\nimport { ${c}Contract } from '../contract'\n\nexport default defineCoreModule({\n  id: '${id}',\n  contract: ${c}Contract,\n  setup(_ctx) {},\n})\n`,
      }
    case 'host':
      return {
        'index.ts': `import { defineHostModule } from '@poietica/host-kernel'\nimport { ${c}Contract } from '../contract'\n\nexport default defineHostModule({\n  id: '${id}',\n  contract: ${c}Contract,\n  setup(_ctx) {},\n})\n`,
      }
    case 'ui':
      return {
        'index.ts': `import { defineUiFeature } from '@poietica/ui-kernel'\n\nexport default defineUiFeature({\n  id: '${id}',\n  setup(_ctx) {},\n})\n`,
      }
    case 'core-api':
    case 'ui-api':
      return { 'index.ts': `// ${id} 的 ${part}：只导出类型、令牌、事件或贡献点\nexport {}\n` }
  }
}

function partDeps(part: FeaturePart | 'contract'): { deps: Record<string, string>; dev: Record<string, string> } {
  switch (part) {
    case 'contract':
      return {
        deps: { '@poietica/contract-kit': 'workspace:*', '@poietica/foundation': 'workspace:*', zod: 'catalog:' },
        dev: {},
      }
    case 'core-api':
      return { deps: { '@poietica/foundation': 'workspace:*', '@poietica/core-kernel': 'workspace:*' }, dev: {} }
    case 'core':
      return { deps: { '@poietica/core-kernel': 'workspace:*' }, dev: { '@types/bun': 'catalog:' } }
    case 'host':
      return {
        deps: { '@poietica/host-kernel': 'workspace:*' },
        dev: { '@types/node': 'catalog:', electron: 'catalog:' },
      }
    case 'ui':
      return {
        deps: {
          '@poietica/ui-kernel': 'workspace:*',
          '@poietica/design-system': 'workspace:*',
          react: 'catalog:',
          zustand: 'catalog:',
        },
        dev: { '@types/react': 'catalog:', '@testing-library/react': 'catalog:' },
      }
    case 'ui-api':
      return { deps: { '@poietica/ui-kernel': 'workspace:*', react: 'catalog:' }, dev: { '@types/react': 'catalog:' } }
  }
}

export function renderFeature(id: string, parts: readonly FeaturePart[]): FileMap {
  const all: Array<FeaturePart | 'contract'> = ['contract', ...FEATURE_PARTS.filter((p) => parts.includes(p))]
  const base = `features/${id}`
  const files: FileMap = {}
  const deps: Record<string, string> = {}
  const dev: Record<string, string> = {}
  const exportsMap: Record<string, string> = {}
  for (const part of all) {
    const d = partDeps(part)
    Object.assign(deps, d.deps)
    Object.assign(dev, d.dev)
    exportsMap[`./${part}`] = `./src/${part}/index.ts`
    files[`${base}/src/${part}/tsconfig.json`] = json({
      extends: `../../../../tooling/tsconfig/${PART_RUNTIME[part]}.json`,
      include: ['.'],
      references: [],
    })
    for (const [file, content] of Object.entries(partSource(id, part))) files[`${base}/src/${part}/${file}`] = content
  }
  const sortKeys = (o: Record<string, string>) =>
    Object.fromEntries(Object.entries(o).sort(([a], [b]) => a.localeCompare(b)))
  files[`${base}/package.json`] = json({
    name: `@poietica/feature-${id}`,
    version: '0.0.0',
    private: true,
    type: 'module',
    exports: exportsMap,
    dependencies: sortKeys(deps),
    devDependencies: sortKeys(dev),
  })
  files[`${base}/README.md`] =
    `# @poietica/feature-${id}\n\n（一段话：这个功能做什么；子入口：${all.join('、')}；对外 API。详见架构文档 07 页。）\n`
  return files
}
