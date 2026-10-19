// 全仓唯一的 CSS 模块声明。
//
// 这个仓库里 .css 只做副作用导入：允许 import 一个 .css 路径，但不提供任何导出，因为类名映射
// 只存在于 CSS Modules，而本仓库没有用它。
//
// 「.css 能被 import」是构建工具链的事实（Vite / Bun 打包器处理它），不是哪个包的 API，所以它住在
// tsconfig 预设旁边，由 dom.json 的 `files` 带进每个 DOM 工程（tooling 与测试工程各自的 tsconfig 也列了它）。
// 此前它住在 design-system 的 src 里，18 个文件用 `/// <reference path="../../../../packages/design-system/…">`
// 按相对路径钻进别的包，绕过了包的 exports 与依赖声明。
//
// 通配符模块声明是全局的，全仓只能有这一份：此前它散在四个包里，给出三种互相矛盾的定义（简写
// any、空模块、导出具名 content），哪一份生效取决于当前编译到哪个包。现在由 biome 插件
// tooling/checks/wildcard-modules.grit 看着（只放行本文件）。

declare module '*.css' {}
