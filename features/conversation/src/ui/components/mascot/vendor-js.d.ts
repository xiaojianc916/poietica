/* 吉祥物运行时是随界面迁入的第三方 JS，靠副作用导入往全局挂引擎，没有类型也不需要类型。
 * 四条声明逐条点名，不写宽松的 '*' —— 通配会把别的模块解析错误一起吞掉。 */
declare module '*/vendor/aora-bot/emotion-ball/js/rings.js' {}
declare module '*/vendor/aora-bot/emotion-ball/js/emotions.js' {}
declare module '*/vendor/aora-bot/emotion-ball/js/ball.js' {}
declare module '*/vendor/aora-bot/emotion-ball/js/engine.js' {}
