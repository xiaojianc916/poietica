// 全仓唯一的 `?raw` 模块声明：`import text from './file?raw'` 把文件原样读成字符串。
//
// 与 css-imports.d.ts 同理：「带 ?raw 的说明符能被 import」是构建工具链的事实（Vite 的 vite:asset 与 Bun 的加载器
// 都支持），不是哪个包的 API，所以它住在 tsconfig 预设旁边，由 electron-main.json 的 `files` 带进 Host 工程
// （测试工程的 tsconfig.tests.json 也列了它）。目前只有 intelligent-ui 的 Host 用它把随包的 UMD 库读进来。
//
// 通配符模块声明由 biome 插件 tooling/checks/wildcard-modules.grit 看着：只放行本文件与 css-imports.d.ts。

declare module '*?raw' {
  const text: string
  export default text
}
