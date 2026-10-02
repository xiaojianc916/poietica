import {
  createHighlighterCore,
  type HighlighterCore,
  type ThemedTokenWithVariants,
} from 'shiki/core'
import { createOnigurumaEngine } from 'shiki/engine/oniguruma'
import css from 'shiki/langs/css.mjs'
import html from 'shiki/langs/html.mjs'
import javascript from 'shiki/langs/javascript.mjs'
import json from 'shiki/langs/json.mjs'
import jsx from 'shiki/langs/jsx.mjs'
import markdown from 'shiki/langs/markdown.mjs'
import python from 'shiki/langs/python.mjs'
import rust from 'shiki/langs/rust.mjs'
import shellscript from 'shiki/langs/shellscript.mjs'
import toml from 'shiki/langs/toml.mjs'
import tsx from 'shiki/langs/tsx.mjs'
import typescript from 'shiki/langs/typescript.mjs'
import yaml from 'shiki/langs/yaml.mjs'
import githubDark from 'shiki/themes/github-dark.mjs'
import githubLight from 'shiki/themes/github-light.mjs'

/*
 * 着色器的那一份 shiki。
 *
 * 默认入口（'shiki'）把 308 个语法、65 个主题与整块 oniguruma wasm 都算作可达。worker
 * 是不可分包的 IIFE，那一整套会原样内联：9.6 MB 里九成来自这里。下面只点名语法着色
 * 真正用到的 13 个语法与 2 个主题，逐个从 shiki/langs 与 shiki/themes 取。
 *
 * 引擎仍是 oniguruma。JavaScript 正则引擎能省掉 607 KB 的 wasm，但分词边界不同 ——
 * typescript 的 `number): string {` 会被并成一个词元 —— 颜色跟着变，所以不换。
 *
 * 键名即语法注册名，也就是 suffix 表要交回 shiki 的 id：两者同源，加一种语法只在这里
 * 加一行，syntax.ts 的后缀表由 PaintedLanguage 兜住。
 */
const GRAMMARS = {
  css,
  html,
  javascript,
  json,
  jsx,
  markdown,
  python,
  rust,
  shellscript,
  toml,
  tsx,
  typescript,
  yaml,
} as const

/** 已注册的语法 id。写进后缀表时由它兜住，写错在 typecheck 就报。 */
export type PaintedLanguage = keyof typeof GRAMMARS

const THEME_REGISTRATIONS = [githubDark, githubLight]

/* 两套主题的名字：与 THEME_REGISTRATIONS 的注册名一致。 */
const THEMES = { dark: 'github-dark', light: 'github-light' } as const

let pending: Promise<HighlighterCore> | null = null

/* 实例只建一次：wasm 编译与语法注册都贵，每个文件重来一遍等于乘以改动数。 */
function highlighter(): Promise<HighlighterCore> {
  pending ??= createHighlighterCore({
    engine: createOnigurumaEngine(import('shiki/wasm')),
    langs: Object.values(GRAMMARS),
    themes: THEME_REGISTRATIONS,
  })

  return pending
}

/** 一段正文在两套主题下的词元，按行切好。 */
export async function tokenize(
  code: string,
  lang: PaintedLanguage,
): Promise<ThemedTokenWithVariants[][]> {
  return (await highlighter()).codeToTokensWithThemes(code, { lang, themes: THEMES })
}
