// 依赖规则：03 页 §9。层级规则由 layers.json 生成；其余规则为固定正则。
//
// 这里曾 require('./swc-tsx.cjs')：dependency-cruiser 17.4.3 的 swc 解析器把 syntax 固定成
// 'typescript' 且不打开 tsx，.tsx 里的 JSX 会被当成类型断言而解析失败（P3 起仓库里出现了 .tsx）。
// dependency-cruiser 18.5.0 的 src/extract/swc/parse.mjs 加了 getOptionsFor()，对 .tsx/.jsx
// 自动带上 tsx: true，补丁已无必要，shim 随之删除（见 docs/refactor-log.md 待决问题 Q2）。

const layers = require('./layers.json')

// dependency-cruiser 用 safe-regex 校验规则正则：'(^|/)node_modules/(.+/)?' 会被判为病态回溯而拒绝启动，
// 'node_modules/.*' 语义等价（resolved 是绝对路径）且通过安全检查。
const NM = 'node_modules/.*'
const names = Object.keys(layers)
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
/** 测试文件：可以使用测试工具包（test-kit 等更高层的包）与 node: 模块，所以层级、纯度规则不检查它们 */
const TEST = '(/__tests__/|\\.test\\.tsx?$)'

/**
 * 同层允许的依赖：这些边由 03 页 §2.2「允许依赖」一栏点名，与「同层禁止依赖」不冲突——
 * 设计表是权威，分层规则只是它的通用表达。表外的同层依赖仍然报错。
 */
const sameLayer = require('./same-layer.json')

/** packages/<p> 只能依赖层级严格更低的包（03 页 §2.2 点名的同层依赖除外） */
const layerRules = names.map((p) => {
  const allowed = new Set(sameLayer[p] ?? [])
  const banned = names.filter((q) => q !== p && layers[q] >= layers[p] && !allowed.has(q))
  return {
    name: `layer-order:${p}`,
    severity: 'error',
    comment: `${p}（L${layers[p]}）只能依赖更低层的包`,
    from: { path: `^packages/${esc(p)}/`, pathNot: TEST },
    to: { path: banned.length > 0 ? `^packages/(${banned.map(esc).join('|')})/` : '^$impossible^' },
  }
})

module.exports = {
  forbidden: [
    ...layerRules,
    {
      name: 'unknown-package-layer',
      severity: 'error',
      comment:
        'packages/ 下每个包都必须在 tooling/depcruise/layers.json 中登记层级（用 bun run new:package 创建包会自动登记）',
      from: { path: '^packages/', pathNot: `^packages/(${names.map(esc).join('|')})/` },
      to: {},
    },
    {
      name: 'omp-confined',
      severity: 'error',
      comment:
        '只有 engine-omp 可以 import @oh-my-pi/*（apps/core/scripts 的构建脚本需要 omp 包内的构建插件与 natives 包，是唯一例外）',
      from: { pathNot: '^(packages/engine-omp/|apps/core/scripts/)' },
      to: { path: `${NM}@oh-my-pi/` },
    },
    {
      name: 'engine-omp-only-in-app',
      severity: 'error',
      comment: 'engine-omp 只能由 apps/core 使用',
      from: { path: '^(features|packages)/', pathNot: '^packages/engine-omp/' },
      to: { path: '^packages/engine-omp/' },
    },
    {
      name: 'packages-no-features',
      severity: 'error',
      comment: '平台包不认识任何功能（protocol 除外，且只能 import 功能的 contract）',
      from: { path: '^packages/', pathNot: '^packages/protocol/' },
      to: { path: '^features/' },
    },
    {
      /*
       * 06 页 §0 铁律 2 的专名闸门（A-K1 的验证方式就是按这个名字查）：
       * 三个内核与外壳只渲染贡献点，不出现任何具体功能。
       *
       * 语义上 `packages-no-features` 已覆盖它（workbench 与内核都是 packages/*），
       * 这里再列一条同名规则，是为了让 06 页的验收标准 A-K1 能按计划点名的规则验证，
       * 而不是让执行者去推断「哪条规则等效」。
       */
      name: 'workbench-agnostic',
      severity: 'error',
      comment: '内核与外壳不认识任何具体功能（workbench、*-kernel 不得依赖 @poietica/feature-*）',
      from: { path: '^packages/(workbench|core-kernel|host-kernel|ui-kernel)/' },
      to: { path: '^features/' },
    },
    {
      name: 'protocol-only-contracts',
      severity: 'error',
      from: { path: '^packages/protocol/' },
      to: { path: '^features/[^/]+/src/', pathNot: '^features/[^/]+/src/contract/' },
    },
    {
      name: 'features-no-shell',
      severity: 'error',
      comment: '功能包不得依赖 workbench、protocol、apps',
      from: { path: '^features/' },
      to: { path: '^(packages/(workbench|protocol)/|apps/)' },
    },
    {
      name: 'feature-cross-impl',
      severity: 'error',
      comment: '功能之间只能经 contract / core-api / ui-api 协作（测试文件除外）',
      /*
       * 测试文件豁免的理由与其它规则同一条：14 页 §0.4 要求 core 模块用 createCoreHarness
       * 启动「只含被测模块**及其依赖**的真实内核」，所以 conversation 的模块测试必须能 import
       * workspaces / attachments 的 Core 模块定义。产品代码里这条边仍然是零（已逐条核对）。
       */
      from: { path: '^features/([^/]+)/', pathNot: TEST },
      to: { path: '^features/[^/]+/src/(core|host|ui)/', pathNot: '^features/$1/' },
    },
    {
      name: 'feature-subentry-ui',
      severity: 'error',
      from: { path: '^features/([^/]+)/src/(ui|ui-api)/' },
      to: { path: '^features/$1/src/(core|core-api|host)/' },
    },
    {
      name: 'feature-subentry-ui-runtime',
      severity: 'error',
      comment: 'UI 子入口不得依赖 electron / node-pty / electron-updater（测试文件除外，见 TEST 的说明）',
      from: { path: '^features/[^/]+/src/(ui|ui-api)/', pathNot: TEST },
      to: { path: `${NM}(electron|@lydell/node-pty|electron-updater)/` },
    },
    {
      name: 'feature-subentry-core',
      severity: 'error',
      from: { path: '^features/([^/]+)/src/core/' },
      to: { path: '^features/$1/src/(ui|ui-api|host)/' },
    },
    {
      name: 'feature-subentry-core-runtime',
      severity: 'error',
      comment: 'core 子入口不得依赖 react / electron / zustand（测试文件除外）',
      from: { path: '^features/[^/]+/src/core/', pathNot: TEST },
      to: { path: `${NM}(react|react-dom|electron|zustand)/` },
    },
    {
      name: 'feature-subentry-host',
      severity: 'error',
      from: { path: '^features/([^/]+)/src/host/' },
      to: { path: '^features/$1/src/(core|core-api|ui|ui-api)/' },
    },
    {
      name: 'feature-subentry-host-runtime',
      severity: 'error',
      comment: 'host 子入口不得依赖 react / zustand / bun:（测试文件除外：测试跑在 bun test 下）',
      from: { path: '^features/[^/]+/src/host/', pathNot: TEST },
      to: { path: `(${NM}(react|react-dom|zustand)/|^bun:)` },
    },
    {
      name: 'contract-pure',
      severity: 'error',
      comment:
        'contract / core-api 只能依赖 contract-kit、foundation、transcript、engine、core-kernel/events、zod 与功能 contract',
      from: { path: '^features/([^/]+)/src/(contract|core-api)/', pathNot: TEST },
      to: {
        pathNot: [
          '^features/$1/src/(contract|core-api)/',
          '^features/[^/]+/src/contract/',
          '^packages/(contract-kit|foundation|transcript|engine)/',
          '^packages/core-kernel/src/events-def\\.ts$',
          `${NM}zod/`,
        ],
      },
    },
    {
      name: 'renderer-pure',
      severity: 'error',
      from: { path: '^apps/desktop/src/renderer/' },
      to: { path: `(${NM}electron/|^features/[^/]+/src/(core|host)/)` },
    },
    {
      name: 'renderer-no-node-core',
      severity: 'error',
      comment: '渲染进程与 neutral 包不得依赖 Node core 模块（测试与构建脚本除外）',
      from: {
        path: '^(apps/desktop/src/renderer/|features/[^/]+/src/(ui|ui-api|contract|core-api)/|packages/(foundation|contract-kit|rpc|transcript|engine|ui-kernel|design-system|workbench|protocol)/)',
        pathNot: `(${TEST}|/scripts/)`,
      },
      to: { dependencyTypes: ['core'] },
    },
    {
      name: 'no-circular',
      severity: 'error',
      from: {},
      to: { circular: true },
    },
    {
      name: 'no-legacy',
      severity: 'error',
      from: {},
      to: { path: 'poietica-legacy' },
    },
    {
      name: 'not-to-unresolvable',
      severity: 'error',
      from: {},
      to: { couldNotResolve: true, pathNot: ['^bun:', '^electron$', '\\?(raw|url|asset)$'] },
    },
    {
      name: 'not-to-undeclared',
      severity: 'error',
      comment: '只能 import 本包 package.json 声明过的依赖',
      from: {},
      to: { dependencyTypes: ['npm-no-pkg', 'npm-unknown'] },
    },
  ],
  options: {
    /*
     * `exclude` 与 `doNotFollow` 的分工（两者缺一不可，写错会让规则**静默失效**）：
     *
     * - `exclude` 把节点从图里整个删掉。只放**我们自己的构建产物与不作图的目录**。
     *   这里曾把 `dist` 一并排除，而 `@oh-my-pi/*` 的 `types` 条件恰好指向它自己的
     *   `dist/types/*.d.ts` —— 那些依赖被解析到 `dist/` 后 matchesDoNotFollow 为真、
     *   valid 为假，`omp-confined` 于是对**包名写法**永远不触发（只有相对路径写法才会报）。
     *   实测：修这条之前全仓 depcruise 看到 0 条 @oh-my-pi 边，修之后看到 29 条。
     *
     * - `doNotFollow` 只声明「不往这个节点内部继续走」，节点本身仍在图里，
     *   于是针对它的规则（omp-confined / layer-order / not-to-undeclared）照常判定。
     *   node_modules 与 vendor 属于此类：vendor 是随界面迁入的第三方 JS
     *   （features/conversation/vendor），不参与我们的依赖图，也不该被 swc 解析
     *   （那份代码不是 ES module，解析必失败）。
     */
    doNotFollow: { path: '(^|/)(node_modules|\\.tsbuild|dist|out|release|coverage|vendor)/' },
    exclude: { path: '(^|/)(\\.tsbuild|out|release|coverage|vendor)/' },
    parser: 'swc',
    tsPreCompilationDeps: true,
    preserveSymlinks: false,
    combinedDependencies: false,
    tsConfig: { fileName: 'tsconfig.tests.json' },
    enhancedResolveOptions: {
      exportsFields: ['exports'],
      conditionNames: ['bun', 'import', 'node', 'default', 'types'],
      mainFields: ['module', 'main', 'types'],
      extensions: ['.ts', '.tsx', '.js', '.mjs', '.cjs', '.json'],
    },
  },
}
