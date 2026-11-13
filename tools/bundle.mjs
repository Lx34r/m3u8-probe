// 把 ES module 源码按依赖序包成经典脚本（file:// 双击直开用）。
// 每个模块一个独立函数作用域 + 显式 export 对象，语义与 ESM 一致，源代码一个字不用改。
// 改完跑 `node tools/bundle.mjs` 重新生成 ui/bundle.js。只用 Node 内置模块。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const UI = path.join(ROOT, 'ui');

// 依赖序：被依赖者在前
const ORDER = ['local-target.js', 'autostop.js', 'store.js', 'demo.js', 'export.js', 'api.js', 'app.js'];
const VAR = 'm3u8ui';
const MOD = { 'local-target.js': 'localTarget', 'autostop.js': 'autostop', 'store.js': 'store', 'demo.js': 'demo', 'export.js': 'exportMod', 'api.js': 'apiMod', 'app.js': 'appMod' }; // 各模块导出对象所在的名字空间

function exportsOf(src) {
  const names = [];
  for (const m of src.matchAll(/^export\s+(async\s+)?(function|const|let|var)\s+([A-Za-z_$][\w$]*)/gm)) {
    names.push(m[3]);
  }
  return names;
}

function stripImports(src) {
  return src
    .replace(/^import\s+\{[^}]*\}\s+from\s+'\.\/[a-z-]+\.js';\s*$/gms, '')
    .replace(/^import\s+\*\s+as\s+api\s+from\s+'\.\/api\.js';\s*$/gm, '');
}

const mods = ORDER.map((file) => {
  const raw = stripImports(fs.readFileSync(path.join(UI, file), 'utf8'));
  const names = exportsOf(raw); // 先收名字再剥 export 前缀
  const src = raw.replace(/^export\s+/gm, '');
  const isLast = file === 'app.js';
  const body = isLast ? src.replace(/^boot\(\);\s*$/m, `${VAR}.app = true; boot();`) : src;
  // 函数直接存引用（调用方要拿到的就是它本身）；let 值用 getter 才能读到最新值
  const isFuncNames = new Set(names.filter((n) => new RegExp(`^export\\s+(async\\s+)?function\\s+${n}\\b`, 'm').test(raw)));
  const exportsLine = names.length
    ? `${VAR}[${JSON.stringify(MOD[file])}] = { ${names.map((n) => (isFuncNames.has(n) ? `${n}: ${n}` : `${n}: () => ${n}, ${n}_getter: () => ${n}`)).join(', ')} };`
    : '';
  return { file, names, body, exportsLine, isLast, isFuncNames };
});

// 命名导入：{ 目标模块: [导入名] }，api.js 还要一个 namespace 导入
const NEEDS = {
  'api.js': {
    named: { 'local-target.js': ['canReachBridge'] },
    namespace: null,
  },
  'app.js': {
    named: {
      'store.js': ['DEFAULT_CONFIG', 'initialState', 'reduce', 'selectVisible', 'toRunRequest', 'serialize', 'hydrate', 'reorderIds'],
      'demo.js': ['demoEvents', 'demoDownloadEvents'],
      'export.js': ['exportJson', 'exportCsv', 'exportAddresses'],
      'autostop.js': ['autoStopDecision', 'collectAddresses', 'AUTO_STOP_DEFAULTS'],
    },
    namespace: 'api.js',
  },
};

// namespace 导入（import * as api）在函数作用域里还原成局部对象
function importLines(file) {
  const need = NEEDS[file];
  if (!need) return '';
  const decls = [];
  for (const [from, names] of Object.entries(need.named)) {
    const mod = MOD[from];
    const modData = mods.find((m) => m.file === from);
    for (const n of names) {
      const ref = modData.isFuncNames.has(n) ? `${VAR}[${JSON.stringify(mod)}].${n}` : `${VAR}[${JSON.stringify(mod)}].${n}_getter()`;
      decls.push(`const ${n} = ${ref};`);
    }
  }
  if (need.namespace) {
    const apiNames = mods.find((m) => m.file === need.namespace).names;
    const entries = apiNames.map((n) => `${n}: ${VAR}[${JSON.stringify(MOD[need.namespace])}].${n}`).join(', ');
    decls.push(`const api = { ${entries} };`);
  }
  return decls.join('\n') + '\n';
}

const head = `(() => {
'use strict';
// file:// 直开用的打包产物：由 tools/bundle.mjs 从 ui/*.js 源码生成，别手改。
// stage/err 给 file:// 排障用：页面停在「检测中…」时能直接读 window.__m3u8Stage。
try {
  window.__m3u8Stage = 'start';
  window.addEventListener('error', (e) => { window.__m3u8Err = String(e.message ?? e.error); });
  window.addEventListener('unhandledrejection', (e) => { window.__m3u8Err = 'rejection: ' + String(e.reason?.message ?? e.reason); });
} catch {}
const ${VAR} = {};
window.__m3u8 = ${VAR};
`;

const parts = mods.map((m, mi) => [
  `// ----- ${m.file} -----`,
  `${VAR}[${JSON.stringify(MOD[m.file])}] = {};`,
  importLines(m.file),
  `window.__m3u8Stage = "${m.file}";
(() => {`,
  m.body,
  m.exportsLine,
  `})();`,
].filter(Boolean).join('\n'));

const bundle = head + parts.join('\n\n') + `\n})();\n`;
fs.writeFileSync(path.join(UI, 'bundle.js'), bundle, 'utf8');
console.log(`bundle.js: ${(Buffer.byteLength(bundle) / 1024).toFixed(1)} KiB from ${ORDER.length} modules`);