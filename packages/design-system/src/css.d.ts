// 全仓唯一的 CSS 模块声明。
//
// 这个仓库里 .css 只做副作用导入：允许 import 一个 .css 路径，但不提供任何导出，
// 因为类名映射只存在于 CSS Modules，而本仓库没有用它。
//
// 由 ./index.ts 顶部的三斜线引用带进每个消费者的程序图 —— 四个需要它的包
// （agent-ui / settings / workspace / desktop）都依赖 @poietica/design-system，
// 所以不需要任何 tsconfig 里的 include 特技。
//
// 通配符模块声明是全局的，全仓只能有这一份。此前它散在四个包里，给出三种互相
// 矛盾的定义（简写 any、空模块、导出具名 content），哪一份生效取决于当前编译到
// 哪个包。现在由架构规则 wildcard-module-declarations 看着。

declare module '*.css' {}
