import type { AssetHandler } from '@poietica/host-kernel'
import { WIDGET_LIBRARY_ORIGINS, WIDGET_SHELL_FILE } from '../contract'

/*
 * 对话内组件的外壳文档（审查 R-18）：poietica-asset://widget/shell-1.html。
 *
 * 为什么要一个外壳，而不是 <iframe srcdoc>：srcdoc / blob: / data: 文档**继承父文档的 CSP**，
 * 主窗口的 script-src 不给 'unsafe-inline'，组件里的脚本一行都跑不起来；放开主窗口的 CSP 又等于
 * 给整个应用开口子。外壳走资源协议，有自己的响应头，CSP 只管它自己。
 *
 * 流程：UI 的 iframe（sandbox="allow-scripts allow-forms"，不给 allow-same-origin）加载外壳 →
 * 外壳发 poietica:ready → UI 回 poietica:render { html, css, theme, bare } → 外壳把基础样式、
 * 令牌、小桥脚本拼进组件 HTML，document.open/write 换成组件自己的文档。document.open 会清掉
 * 外壳的监听器，所以小桥要作为组件文档里的第一段脚本重新装一遍。
 *
 * 安全靠三层：iframe 的 sandbox（不同源：碰不到父窗口、存储、cookie）；本文件的 CSP（除公共
 * CDN 外连不出去；响应头里再带一次 sandbox，外壳被直接打开时也是不透明源）；UI 侧只认来自
 * 这个 iframe 的消息，send 还要求用户正在操作它（widget-card.tsx）。
 */

const LIBRARIES = WIDGET_LIBRARY_ORIGINS.join(' ')

export const WIDGET_CSP = [
  "default-src 'none'",
  `script-src 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval' blob: ${LIBRARIES}`,
  `style-src 'unsafe-inline' ${LIBRARIES}`,
  `font-src data: ${LIBRARIES}`,
  'img-src data: blob:',
  'media-src data: blob:',
  `connect-src ${LIBRARIES}`,
  'worker-src blob:',
  "frame-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  'sandbox allow-scripts allow-forms',
].join('; ')

/*
 * 预置样式：不写类名也像长在 Poietica 里。全部包在 :where() 里，特异性为零 —— 组件自己写的
 * 任何样式都压得过它。颜色、字体、圆角只用令牌（UI 求值后放进 #poietica-tokens）。
 */
const BASE_CSS = `
*,*::before,*::after{box-sizing:border-box}
:where(html){font-family:var(--font-sans);font-size:var(--text-base);line-height:1.6;color:var(--color-text);background:transparent;-webkit-font-smoothing:antialiased;text-size-adjust:100%}
:where(body){margin:0}
:where(h1,h2,h3,h4){margin:1.1em 0 .5em;line-height:1.3;font-weight:600;color:var(--color-text)}
:where(h1){font-size:1.375em}:where(h2){font-size:1.15em}:where(h3){font-size:1em}:where(h4){font-size:.95em}
:where(h1,h2,h3,h4):first-child{margin-top:0}
:where(p,ul,ol){margin:.5em 0}
:where(a){color:var(--color-link);text-decoration:none}:where(a:hover){text-decoration:underline}
:where(small,figcaption){color:var(--color-text-muted);font-size:.875em}
:where(code,kbd,samp,pre){font-family:var(--font-mono);font-size:.9em}
:where(:not(pre)>code){background:var(--color-surface);border-radius:4px;padding:.1em .35em}
:where(pre){background:var(--color-surface);border-radius:var(--radius);padding:12px 14px;overflow:auto}
:where(hr){border:0;border-top:1px solid var(--color-border);margin:16px 0}
:where(button){font:inherit;font-size:.9375em;color:var(--color-text);background:var(--color-surface-raised);border:1px solid var(--color-border-strong);border-radius:var(--radius-sm);height:32px;padding:0 12px;cursor:pointer;transition:background-color .12s,border-color .12s}
:where(button:hover){background:var(--color-hover)}
:where(button.primary,button[type=submit]){background:var(--color-accent);border-color:transparent;color:var(--color-accent-text)}
:where(button.primary:hover,button[type=submit]:hover){background:var(--color-accent);filter:brightness(1.06)}
:where(button:disabled){opacity:.5;cursor:default}
:where(input:not([type=checkbox],[type=radio],[type=range],[type=color],[type=file]),select,textarea){font:inherit;color:var(--color-text);background:var(--color-surface-raised);border:1px solid var(--color-border-strong);border-radius:var(--radius-sm);min-height:32px;padding:5px 10px}
:where(textarea){min-height:72px;resize:vertical}
:where(input,textarea)::placeholder{color:var(--color-text-subtle)}
:where(input[type=checkbox],input[type=radio],input[type=range],progress,meter){accent-color:var(--color-accent)}
:where(button,input,select,textarea,a,[tabindex]):focus-visible{outline:2px solid var(--color-focus);outline-offset:1px}
:where(label){color:var(--color-text)}
:where(fieldset){border:1px solid var(--color-border);border-radius:var(--radius);padding:12px 14px;margin:0}
:where(legend){padding:0 4px;color:var(--color-text-muted)}
:where(table){border-collapse:collapse;width:100%;font-size:.95em;font-variant-numeric:tabular-nums}
:where(th,td){border-bottom:1px solid var(--color-border);padding:8px 10px;text-align:left;vertical-align:top}
:where(th){color:var(--color-text-muted);font-weight:600}
:where(svg){overflow:visible}
::selection{background:color-mix(in srgb,var(--color-accent) 28%,transparent)}
`

/*
 * 小桥：组件文档里的第一段脚本。__THEME__ 由外壳换成 "light" / "dark"。
 * 只用 ES5 + 少量 DOM API 写，避免依赖组件里可能被覆盖的全局。
 *
 * 量高度不用 requestAnimationFrame：Chromium 会停掉不可见（零高、visibility:hidden、在视口外）
 * 的跨源 iframe 的渲染循环，rAF 不来，第一次高度就永远报不上去。DOMContentLoaded / load 时
 * 直接量一次，之后交给 ResizeObserver。
 */
const BRIDGE_JS = `(function(){'use strict';
var theme=__THEME__,root=document.documentElement;
function paint(){root.setAttribute('data-theme',theme);root.style.colorScheme=theme}
paint();
function post(m){try{parent.postMessage(m,'*')}catch(e){}}
function memory(){var m=new Map();return{get length(){return m.size},key:function(i){var k=Array.from(m.keys())[i];return k===undefined?null:k},getItem:function(k){k=String(k);return m.has(k)?m.get(k):null},setItem:function(k,v){m.set(String(k),String(v))},removeItem:function(k){m.delete(String(k))},clear:function(){m.clear()}}}
['localStorage','sessionStorage'].forEach(function(name){var ok=false;try{ok=window[name]!=null}catch(e){}if(!ok){try{Object.defineProperty(window,name,{value:memory(),configurable:true})}catch(e){}}});
var api={send:function(t){post({type:'poietica:send',text:String(t)})},draft:function(t){post({type:'poietica:draft',text:String(t)})},open:function(u){post({type:'poietica:open',url:String(u)})}};
Object.defineProperty(api,'theme',{get:function(){return theme},enumerable:true});
Object.defineProperty(window,'poietica',{value:Object.freeze(api)});
addEventListener('message',function(e){var d=e.data;if(e.source!==parent||!d||d.type!=='poietica:theme')return;theme=d.theme==='dark'?'dark':'light';paint();var s=document.getElementById('poietica-tokens');if(s)s.textContent=String(d.css);dispatchEvent(new CustomEvent('poietica:theme',{detail:{theme:theme}}))});
var last=-1;
function measure(){var b=document.body,h=root.getBoundingClientRect().height;if(b)h=Math.max(h,b.getBoundingClientRect().bottom+window.scrollY);h=Math.ceil(h);if(h!==last){last=h;post({type:'poietica:height',height:h})}}
var ro=new ResizeObserver(measure);ro.observe(root);
document.addEventListener('DOMContentLoaded',function(){if(document.body)ro.observe(document.body);measure()});
addEventListener('load',measure);
document.addEventListener('click',function(e){var t=e.target,a=t&&t.closest?t.closest('a[href]'):null;if(!a||e.defaultPrevented)return;var href=a.getAttribute('href')||'';if(href.charAt(0)==='#'||/^javascript:/i.test(href))return;e.preventDefault();try{var u=new URL(href,document.baseURI);if(u.protocol==='http:'||u.protocol==='https:'||u.protocol==='mailto:')api.open(u.href)}catch(x){}});
function report(m){post({type:'poietica:error',message:String(m).slice(0,500)})}
addEventListener('error',function(e){if(e.target&&e.target!==window&&e.target.tagName){report('资源加载失败：'+(e.target.src||e.target.href||e.target.tagName));return}report(e.message||e.error||'Script error')},true);
addEventListener('unhandledrejection',function(e){var r=e.reason;report(r&&r.message?r.message:r)});
})();`

/* 外壳自己的脚本：等 UI 交来组件，拼好文档后整页换掉。 */
const SHELL_JS = `(function(){'use strict';
var BRIDGE=${JSON.stringify(BRIDGE_JS)},BASE=${JSON.stringify(BASE_CSS)};
function head(m){var theme=m.theme==='dark'?'"dark"':'"light"';
return '<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'
+'<style id="poietica-tokens">'+String(m.css||'').replace(/<\\//g,'')+'</style>'
+(m.bare?'':'<style id="poietica-base">'+BASE+'</style>')
+'<script>'+BRIDGE.replace('__THEME__',function(){return theme})+'</'+'script>'}
function compose(m){var html=String(m.html||''),h=head(m);
if(/^\\s*(<!--[\\s\\S]*?-->\\s*)*<(!doctype|html|head)\\b/i.test(html)){
if(/<head\\b[^>]*>/i.test(html))return html.replace(/<head\\b[^>]*>/i,function(t){return t+h});
if(/<html\\b[^>]*>/i.test(html))return html.replace(/<html\\b[^>]*>/i,function(t){return t+'<head>'+h+'</head>'});
return html.replace(/<!doctype[^>]*>/i,function(t){return t+'<head>'+h+'</head>'})}
return '<!doctype html><html><head>'+h+'</head><body>'+html+'</body></html>'}
addEventListener('message',function(e){var d=e.data;if(e.source!==parent||!d||d.type!=='poietica:render')return;var doc=compose(d);document.open();document.write(doc);document.close()});
parent.postMessage({type:'poietica:ready'},'*');
})();`

export const WIDGET_SHELL_HTML = `<!doctype html><html><head><meta charset="utf-8"></head><body><script>${SHELL_JS}</script></body></html>`

/** 资源协议处理器：只认外壳这一个文件 */
export function createWidgetShellHandler(): AssetHandler {
  return (segments) => {
    if (segments.length !== 1 || segments[0] !== WIDGET_SHELL_FILE) return new Response(null, { status: 404 })
    return new Response(WIDGET_SHELL_HTML, {
      status: 200,
      headers: { 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': WIDGET_CSP },
    })
  }
}
