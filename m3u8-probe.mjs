import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { parsePlaylist, looksLikePlaylistUrl, isPlaylistMimeType, isPlaylistBody } from './playlist.mjs';
import {
  findBrowser,
  defaultUserDataDir,
  launchBrowser,
  stopBrowser,
  waitForPageTarget,
  connectCdp,
} from './cdp.mjs';

const VALUE_FLAGS = new Set(['--port', '--exe', '--json', '--html', '--timeout', '--user-data-dir']);
const SNIFF_SKIP_TYPES = new Set(['Script', 'Stylesheet', 'Image', 'Font', 'Media', 'WebSocket', 'EventSource', 'Ping']);
const SNIFF_SKIP_EXT = /\.(?:js|mjs|cjs|css|map|png|jpe?g|gif|svg|webp|avif|ico|woff2?|ttf|otf|eot|mp4|m4s|ts|mp3|aac|wasm|webm|mov|zip|pdf)$/i;
const MEDIA_HINT_EXT = /\.(?:ts|m4s|mpd|mp4)(?:[?#]|$)/i;
const FORWARDED_HEADERS = ['referer', 'origin', 'user-agent', 'cookie'];

const HELP = `m3u8-probe — 本地开发用的网页 m3u8 调试录制器

用法: node m3u8-probe.mjs [起始URL] [选项]

  起始URL            可选。不给就开空白页，你自己在窗口里打开本地站点。
  --port <n>         调试端口，默认 9222
  --exe <path>       指定浏览器可执行文件（默认自动找 Edge / Chrome）
  --user-data-dir <p> 独立 profile 目录，默认 %TEMP%\\m3u8-probe-profile
  --no-sniff         关闭"响应体以 #EXTM3U 开头"的嗅探（只按 URL 和 mimeType 判定）
  --timeout <ms>     到时自动收尾，默认 0 = 一直录到 Ctrl-C
  --json <path>      结果写入 JSON
  --html <path>      结果写入自包含 HTML 报告
  --open             生成 HTML 报告并用默认浏览器打开（默认文件名 m3u8-report.html）
  --keep-open        收尾后不关闭探针浏览器窗口
  --ndjson           改输出 JSON 行事件流（log/hit/resolved/summary/error），给 UI 桥接用
  -h, --help         显示本帮助

在浏览器里操作到视频开始播放，然后 Ctrl-C 结束并出报告。
只使用独立临时 profile，不读取你日常浏览器的登录数据。

判定有三条腿：URL 含 .m3u8、mimeType 是 mpegurl、响应体以 #EXTM3U 开头。
第三条腿受 CDP 限制：页面 fetch 后没读过的响应体取不回来，这种只能靠前两条腿。`;

export function parseArgs(argv) {
  const out = {
    url: null,
    port: 9222,
    exe: null,
    json: null,
    html: null,
    timeoutMs: 0,
    sniff: true,
    open: false,
    keepOpen: false,
    help: false,
    ndjson: false,
    userDataDir: null,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') { out.help = true; continue; }
    if (arg === '--open') { out.open = true; continue; }
    if (arg === '--no-sniff') { out.sniff = false; continue; }
    if (arg === '--keep-open') { out.keepOpen = true; continue; }
    if (arg === '--ndjson') { out.ndjson = true; continue; }

    if (arg.startsWith('-')) {
      const eq = arg.indexOf('=');
      const name = eq === -1 ? arg : arg.slice(0, eq);
      if (!VALUE_FLAGS.has(name)) throw new Error(`unknown flag: ${name}`);
      const value = eq === -1 ? argv[(i += 1)] : arg.slice(eq + 1);
      if (value === undefined) throw new Error(`missing value for ${name}`);
      if (name === '--port') {
        const n = Number(value);
        if (!Number.isInteger(n) || n < 1 || n > 65535) throw new Error(`invalid port: ${value}`);
        out.port = n;
      } else if (name === '--timeout') {
        const n = Number(value);
        if (!Number.isFinite(n) || n < 0) throw new Error(`invalid timeout: ${value}`);
        out.timeoutMs = n;
      } else if (name === '--exe') out.exe = value;
      else if (name === '--json') out.json = value;
      else if (name === '--html') out.html = value;
      else if (name === '--user-data-dir') out.userDataDir = value;
      continue;
    }

    if (out.url !== null) throw new Error(`unexpected extra argument: ${arg}`);
    out.url = arg;
  }

  if (out.open && !out.html) out.html = 'm3u8-report.html';
  return out;
}

function pathnameOf(url) {
  try {
    return new URL(url).pathname;
  } catch {
    return String(url ?? '');
  }
}

export function classifyResponse({ url, mimeType, resourceType } = {}) {
  if (looksLikePlaylistUrl(url) || isPlaylistMimeType(mimeType)) return 'hit';
  if (resourceType && SNIFF_SKIP_TYPES.has(resourceType)) return 'ignore';
  if (SNIFF_SKIP_EXT.test(pathnameOf(url))) return 'ignore';
  return 'sniff';
}

function shortName(url) {
  const base = pathnameOf(url).split('/').filter(Boolean).pop();
  return base || url;
}

export function describeInitiator(initiator) {
  if (!initiator || typeof initiator !== 'object') return 'unknown';
  const type = initiator.type || 'unknown';
  if (type === 'parser') return initiator.url ? `parser ${initiator.url}` : 'parser';
  if (type !== 'script') return type;

  const frame = initiator.stack?.callFrames?.[0];
  if (frame) {
    const name = frame.url ? shortName(frame.url) : '<anonymous>';
    // CDP lineNumber is 0-based, editors are 1-based
    const line = Number.isFinite(frame.lineNumber) ? frame.lineNumber + 1 : null;
    const fn = frame.functionName ? ` ${frame.functionName}` : '';
    return line === null ? `${name}${fn}` : `${name}:${line}${fn}`;
  }
  if (initiator.url) {
    const line = Number.isFinite(initiator.lineNumber) ? initiator.lineNumber + 1 : null;
    return line === null ? shortName(initiator.url) : `${shortName(initiator.url)}:${line}`;
  }
  return 'script';
}

export function buildRefetchHeaders(headers) {
  const out = {};
  if (!headers || typeof headers !== 'object') return out;
  const lower = new Map();
  for (const [key, value] of Object.entries(headers)) lower.set(String(key).toLowerCase(), value);
  for (const name of FORWARDED_HEADERS) {
    const value = lower.get(name);
    if (typeof value === 'string' && value.length > 0) out[name] = value;
  }
  return out;
}

export function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function dedupeHits(hits) {
  const byUrl = new Map();
  for (const hit of hits) {
    const existing = byUrl.get(hit.url);
    if (existing) existing.count += 1;
    else byUrl.set(hit.url, { ...hit, count: 1 });
  }
  return [...byUrl.values()];
}

export function formatRunSummary({ requests, responses, sniffed, hits }) {
  return `观察请求 ${requests} / 响应 ${responses} / 嗅探 ${sniffed} / 命中 ${hits}`;
}

function playlistRows(p) {
  if (!p) return '<p class="warn">未能取得响应体，无法解析。</p>';
  if (!p.valid) return '<p class="warn">响应体不是 m3u8（不以 #EXTM3U 开头）。</p>';
  const facts = [
    ['类型', escapeHtml(p.kind === 'master' ? 'master（码流清单）' : `media（${p.live ? 'live' : 'VOD'}）`)],
    ['分片数', escapeHtml(String(p.segments))],
    ['总时长', escapeHtml(`${p.totalDuration.toFixed(3)} s`)],
    ['TARGETDURATION', escapeHtml(p.targetDuration === null ? '—' : String(p.targetDuration))],
    ['加密', p.encrypted ? p.keys.map((k) => escapeHtml(`${k.method} → ${k.url ?? k.uri ?? '(无 URI)'}`)).join('<br>') : '无'],
    ['EXT-X-MAP', p.map ? escapeHtml(p.map.url) : '无'],
  ];
  let html = `<table class="facts">${facts.map(([k, v]) => `<tr><th>${escapeHtml(k)}</th><td>${v}</td></tr>`).join('')}</table>`;
  if (p.variants.length > 0) {
    html += '<table class="variants"><tr><th>BANDWIDTH</th><th>RESOLUTION</th><th>CODECS</th><th>variant 地址</th></tr>';
    for (const v of p.variants) {
      html += `<tr><td>${escapeHtml(v.bandwidth)}</td><td>${escapeHtml(v.resolution)}</td><td>${escapeHtml(v.codecs)}</td><td class="url">${escapeHtml(v.url)}</td></tr>`;
    }
    html += '</table>';
  }
  for (const w of p.warnings) html += `<p class="warn">${escapeHtml(w)}</p>`;
  return html;
}

export function renderHtmlReport({ hits, meta }) {
  const cards = hits.map((h, i) => {
    const refetch = h.refetch
      ? h.refetch.ok
        ? `复取成功 HTTP ${escapeHtml(h.refetch.status)}${h.refetch.finalUrl && h.refetch.finalUrl !== h.url ? ` → ${escapeHtml(h.refetch.finalUrl)}` : ''}`
        : `复取失败：${escapeHtml(h.refetch.error ?? `HTTP ${h.refetch.status}`)}`
      : '未复取';
    return `<section class="hit">
  <h2>#${i + 1} <span class="badge">${escapeHtml(h.detectedBy)}</span> <span class="badge">×${escapeHtml(h.count)}</span></h2>
  <p class="url big">${escapeHtml(h.url)}</p>
  <table class="facts">
    <tr><th>发起者</th><td>${escapeHtml(h.initiator)}</td></tr>
    <tr><th>录制状态</th><td>${escapeHtml(h.status)} ${escapeHtml(h.mimeType || '未知类型')}</td></tr>
    <tr><th>复取</th><td>${refetch}${h.refetch?.usedRecordedBody ? '（改用录制到的响应体）' : ''}</td></tr>
  </table>
  ${playlistRows(h.playlist)}
</section>`;
  }).join('\n');

  const empty = hits.length === 0
    ? '<section class="hit"><p class="warn">没有命中任何 m3u8。下面的观察计数可以证明录制器确实在工作——若请求数为 0，说明浏览器根本没走网络。</p></section>'
    : '';

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>m3u8-probe 报告</title>
<style>
body{font-family:system-ui,"Segoe UI",sans-serif;margin:0;padding:24px;background:#14161a;color:#e6e6e6;line-height:1.5}
h1{font-size:20px;margin:0 0 4px}
h2{font-size:15px;margin:0 0 8px}
.meta{color:#9aa4b2;font-size:13px;margin-bottom:20px}
.hit{background:#1c1f26;border:1px solid #2c313a;border-radius:8px;padding:16px;margin-bottom:16px}
.badge{background:#2c313a;border-radius:4px;padding:1px 6px;font-size:12px;color:#9aa4b2;font-weight:400}
.url{font-family:ui-monospace,Consolas,monospace;word-break:break-all;color:#7fd1ff}
.big{font-size:14px;margin:0 0 12px}
table{border-collapse:collapse;width:100%;margin:8px 0;font-size:13px}
th,td{border:1px solid #2c313a;padding:5px 8px;text-align:left;vertical-align:top}
th{color:#9aa4b2;font-weight:500;white-space:nowrap}
.facts th{width:130px}
.warn{color:#ffcc66;font-size:13px}
</style>
</head>
<body>
<h1>m3u8-probe 报告</h1>
<p class="meta">${escapeHtml(formatRunSummary({ ...meta, hits: hits.length }))}<br>
起始 URL：${escapeHtml(meta.startUrl ?? '(空白页)')} · 调试端口 ${escapeHtml(meta.port)} · 生成于 ${escapeHtml(meta.generatedAt)}</p>
${empty}
${cards}
</body>
</html>
`;
}

export function createReporter(ndjson, write, writeErr = write) {
  const emit = (obj) => write(`${JSON.stringify(obj)}\n`);
  return {
    log(text) { if (ndjson) emit({ t: 'log', text: String(text) }); else write(`${text}\n`); },
    hit(hit) { if (ndjson) emit({ t: 'hit', hit }); },
    resolved(hit) { if (ndjson) emit({ t: 'resolved', hit }); },
    progress(counters) { if (ndjson) emit({ t: 'progress', ...counters }); },
    summary(meta, hits) { if (ndjson) emit({ t: 'summary', meta, hits }); },
    error(text) { if (ndjson) emit({ t: 'error', text: String(text) }); else writeErr(`${text}\n`); },
  };
}

// 事件流会被 UI 导出成文件，所以会话 cookie 和原始响应体不上线
export function publicHit(hit) {
  const { requestHeaders, body, ...rest } = hit;
  return rest;
}

function printPlaylist(p, say) {
  if (!p) { say('  解析: 无响应体'); return; }
  if (!p.valid) { say('  解析: 响应体不是 m3u8'); return; }
  if (p.kind === 'master') {
    say(`  解析: master，${p.variants.length} 条码流`);
    for (const v of p.variants) {
      say(`    ${v.bandwidth ?? '?'} bps ${v.resolution ?? ''} ${v.codecs ?? ''}`);
      say(`      ${v.url}`);
    }
  } else {
    say(`  解析: media ${p.live ? 'live' : 'VOD'}，分片 ${p.segments}，总时长 ${p.totalDuration.toFixed(3)}s`);
    if (p.firstSegmentUrl) say(`    首片: ${p.firstSegmentUrl}`);
  }
  if (p.encrypted) for (const k of p.keys) say(`    加密: ${k.method} → ${k.url ?? k.uri ?? '(无 URI)'}`);
  if (p.map) say(`    init: ${p.map.url}`);
  for (const w of p.warnings) say(`    警告: ${w}`);
}

// Windows 没法给子进程发 SIGINT，所以被程序驱动时改用 stdin 行命令收尾
export function attachStopControl(stream, onStop) {
  let buf = '';
  let fired = false;
  stream.setEncoding('utf8');
  stream.on('data', (chunk) => {
    if (fired) return;
    buf += chunk;
    let idx;
    while ((idx = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (line === 'stop') {
        fired = true;
        stream.pause();
        onStop();
        return;
      }
    }
  });
}

async function main() {
  // 用法错误也要以事件形式到达 UI，所以 reporter 在 parseArgs 之前就建好
  const report = createReporter(
    process.argv.slice(2).includes('--ndjson'),
    (s) => process.stdout.write(s),
    (s) => process.stderr.write(s),
  );
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    report.error(err.message);
    report.error('用 --help 看用法');
    process.exitCode = 2;
    return;
  }
  if (args.help) { report.log(HELP); return; }

  let exe;
  try {
    exe = findBrowser({ exe: args.exe });
  } catch (err) {
    report.error(err.message);
    process.exitCode = 1;
    return;
  }

  try {
    const res = await fetch(`http://127.0.0.1:${args.port}/json/version`, { signal: AbortSignal.timeout(1500) });
    if (res.ok) {
      report.error(`调试端口 ${args.port} 已被另一个浏览器占用；换一个端口：--port <n>`);
      process.exitCode = 1;
      return;
    }
  } catch {
    // nothing listening on the port, which is what we want
  }

  const userDataDir = args.userDataDir || defaultUserDataDir();
  fs.mkdirSync(userDataDir, { recursive: true });
  // 先开空白页：录制窗口里 Network.enable 之前发生的请求一个都录不到，
  // 起始地址交给命令行会让整个文档加载（可能还有它的子请求）漏在录制窗口外。
  const child = launchBrowser({ exe, port: args.port, userDataDir, url: 'about:blank' });

  report.log(`浏览器: ${exe}`);
  report.log(`profile: ${userDataDir}（独立 profile，不用你日常浏览器的登录数据）`);
  report.log(`调试端口: ${args.port}`);
  report.log(args.url ? `起始页: ${args.url}` : '起始页: 空白，自己在窗口里打开你的本地站点');
  report.log('录制中… 操作到视频开始播放，然后 Ctrl-C 收尾出报告。');

  const state = { requests: 0, responses: 0, sniffed: 0, hits: [], mediaHints: new Set() };
  const requestInfo = new Map();
  const pending = new Set();
  let session = null;
  let finishing = false;

  const track = (promise) => {
    pending.add(promise);
    const done = () => pending.delete(promise);
    promise.then(done, done);
  };

  async function resolveHit(hit) {
    let text = null;
    try {
      const res = await fetch(hit.url, {
        headers: buildRefetchHeaders(hit.requestHeaders),
        redirect: 'follow',
        signal: AbortSignal.timeout(10000),
      });
      hit.refetch = { ok: res.ok, status: res.status, finalUrl: res.url };
      if (res.ok) text = await res.text();
      else hit.refetch.error = `HTTP ${res.status}`;
    } catch (err) {
      hit.refetch = { ok: false, status: null, error: err.message };
    }
    if (text === null && hit.body != null) {
      text = hit.body;
      hit.refetch.usedRecordedBody = true;
    }
    if (text !== null) {
      hit.playlist = parsePlaylist(text, hit.refetch?.finalUrl || hit.url);
      if (!args.ndjson) printPlaylist(hit.playlist, report.log);
    } else {
      report.log('  复取失败且没录到响应体：无法解析，地址可能还要别的请求头');
    }
    report.resolved(publicHit(hit));
  }

  function addHit(entry) {
    const hit = {
      url: entry.url,
      status: entry.status,
      mimeType: entry.mimeType,
      initiator: entry.initiator,
      detectedBy: entry.detectedBy,
      requestHeaders: entry.headers,
      body: entry.body ?? null,
      refetch: null,
      playlist: null,
    };
    state.hits.push(hit);
    if (!args.ndjson) {
      report.log(`\n[命中 ${state.hits.length}] ${hit.url}`);
      report.log(`  发起者: ${hit.initiator} | 状态 ${hit.status} | ${hit.mimeType || '未知类型'} | 判定依据 ${hit.detectedBy}`);
    }
    report.hit(publicHit(hit));
    track(resolveHit(hit));
  }

  // getResponseBody 可能永远不回（渲染进程把响应体丢了或正忙）。嗅探是串行的，
  // 一条挂住会拖死后面所有嗅探（响应体被回收→body 腿漏判），还会卡住 finish 的收尾。
  // 所以每条都限时，超时就跳过这条嗅探，url/mime 两条腿和复取不受影响。
  const BODY_TIMEOUT_MS = 4000;
  async function sniffBody(entry) {
    state.sniffed += 1;
    let body;
    let timer;
    try {
      const res = await Promise.race([
        session.send('Network.getResponseBody', { requestId: entry.requestId }),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('getResponseBody 超时')), BODY_TIMEOUT_MS); }),
      ]);
      body = res.base64Encoded ? Buffer.from(res.body, 'base64').toString('utf8') : res.body;
    } catch {
      // 渲染进程可能已把体回收（尤其机器慢的时候）。本工具只面向 localhost，
      // 直接复取一遍：体像 m3u8 就按 body 腿记，复取过程照常记录在 refetch 里。
      try {
        const res = await fetch(entry.url, { signal: AbortSignal.timeout(BODY_TIMEOUT_MS) });
        const text = await res.text();
        if (isPlaylistBody(text)) addHit({ ...entry, detectedBy: 'body', body: text, refetch: { ok: res.ok, status: res.status, finalUrl: res.url } });
      } catch { /* 复取也失败就放弃这条腿，url/mime 两条腿不受影响 */ }
      return;
    } finally {
      clearTimeout(timer);
    }
    if (isPlaylistBody(body)) addHit({ ...entry, detectedBy: 'body', body });
  }

  function considerResponse(entry) {
    state.responses += 1;
    const verdict = classifyResponse(entry);
    if (MEDIA_HINT_EXT.test(entry.url) && state.mediaHints.size < 20) state.mediaHints.add(entry.url);
    if (verdict === 'hit') {
      addHit({ ...entry, detectedBy: looksLikePlaylistUrl(entry.url) ? 'url' : 'mime' });
    } else if (verdict === 'sniff' && args.sniff) {
      // 响应体只在渲染进程里留一小会儿：串行排队会让后面的嗅探等到体被回收。
      // 每条响应一到就立刻取体（各自限时），收尾统一等 pending。
      track(sniffBody(entry));
    }
  }

  function finish() {
    if (finishing) return Promise.resolve();
    finishing = true;
    if (progressTimer) { clearInterval(progressTimer); progressTimer = null; }
    return (async () => {
      await Promise.allSettled([...pending]);
      const hits = dedupeHits(state.hits);
      const meta = {
        requests: state.requests,
        responses: state.responses,
        sniffed: state.sniffed,
        startUrl: args.url,
        port: args.port,
        generatedAt: new Date().toISOString(),
      };
      if (!args.ndjson) {
        report.log(`\n${formatRunSummary({ ...meta, hits: hits.length })}`);
        if (hits.length === 0) {
          report.log('没有命中 m3u8。');
          if (state.mediaHints.size > 0) {
            report.log('但看到了这些媒体请求，说明播放器在取流，playlist 可能走了别的形状：');
            for (const u of state.mediaHints) report.log(`  ${u}`);
          } else if (state.requests === 0) {
            report.log('请求数为 0：录制器没收到任何网络事件，检查页面是否真的加载了。');
          }
        } else {
          report.log('\n地址清单:');
          hits.forEach((h, i) => report.log(`  ${i + 1}. ${h.url}`));
        }
      }
      report.progress({ requests: meta.requests, responses: meta.responses, sniffed: meta.sniffed });
      report.summary({ ...meta, mediaHints: [...state.mediaHints] }, hits.map(publicHit));
      if (args.json) {
        fs.writeFileSync(args.json, JSON.stringify({ meta, hits }, null, 2));
        report.log(`\nJSON: ${path.resolve(args.json)}`);
      }
      if (args.html) {
        fs.writeFileSync(args.html, renderHtmlReport({ hits, meta }));
        const resolved = path.resolve(args.html);
        report.log(`HTML: ${resolved}`);
        if (args.open) spawn('cmd.exe', ['/c', 'start', '', resolved], { stdio: 'ignore', detached: true });
      }
      if (session) session.close();
      if (!args.keepOpen) await stopBrowser(child);
    })();
  }

  // 计数器只在收尾时才汇总，UI 会整场显示 0，所以录制期间按变化推送
  let progressTimer = null;
  if (args.ndjson) {
    let last = '';
    progressTimer = setInterval(() => {
      const key = `${state.requests}/${state.responses}/${state.sniffed}`;
      if (key === last) return;
      last = key;
      report.progress({ requests: state.requests, responses: state.responses, sniffed: state.sniffed });
    }, 400);
  }

  process.on('SIGINT', () => { finish().then(() => process.exit(0)); });
  child.on('exit', () => { finish().then(() => process.exit(0)); });
  if (args.ndjson && !process.stdin.isTTY) {
    attachStopControl(process.stdin, () => { finish().then(() => process.exit(0)); });
  }

  // about:blank 起步时 /json/list 可能抓到一个即将关闭的过渡 target，
  // WebSocket 一连上就 close。重试直到真的 enable 成功，不把这种瞬时抖动判成死。
  let target;
  const attachDeadline = Date.now() + 20000;
  for (;;) {
    try {
      target = await waitForPageTarget(args.port, { timeoutMs: 5000 });
      session = await connectCdp(target.webSocketDebuggerUrl);
      await session.send('Page.enable', {});
      await session.send('Network.enable', {});
      break;
    } catch (err) {
      if (session) { session.close(); session = null; }
      if (Date.now() >= attachDeadline) {
        report.error(`接不上调试端口: ${err.message}`);
        await stopBrowser(child);
        process.exitCode = 1;
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }

  session.on('Network.requestWillBeSent', (e) => {
    state.requests += 1;
    requestInfo.set(e.requestId, {
      url: e.request?.url ?? e.documentURL,
      initiator: describeInitiator(e.initiator),
      headers: e.request?.headers,
      resourceType: e.type,
    });
    if (e.redirectResponse) {
      considerResponse({
        requestId: e.requestId,
        url: e.redirectResponse.url,
        status: e.redirectResponse.status,
        mimeType: e.redirectResponse.mimeType,
        resourceType: e.type,
        initiator: describeInitiator(e.initiator),
        headers: e.request?.headers,
      });
    }
  });

  session.on('Network.responseReceived', (e) => {
    const info = requestInfo.get(e.requestId) ?? {};
    considerResponse({
      requestId: e.requestId,
      url: e.response?.url ?? info.url,
      status: e.response?.status,
      mimeType: e.response?.mimeType,
      resourceType: e.type ?? info.resourceType,
      initiator: info.initiator ?? 'unknown',
      headers: info.headers,
    });
  });

  if (args.timeoutMs > 0) setTimeout(() => { finish().then(() => process.exit(0)); }, args.timeoutMs);

  // 订阅挂好后再导航，起始页的文档请求才落在录制窗口里
  if (args.url) { await session.send('Page.navigate', { url: args.url }) }
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}