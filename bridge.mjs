import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DEFAULT_BROWSER_CANDIDATES } from './cdp.mjs';
import { isLocalTarget } from './ui/local-target.js';

export { isLocalTarget };

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RUN_KEYS = new Set(['url', 'port', 'exe', 'userDataDir', 'sniff', 'timeoutMs', 'open', 'keepOpen']);
const ARTIFACTS = new Map([
  ['hits.json', 'application/json; charset=utf-8'],
  ['report.html', 'text/html; charset=utf-8'],
]);
const CONTENT_TYPES = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.mjs', 'text/javascript; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.svg', 'image/svg+xml'],
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.ico', 'image/x-icon'],
  ['.woff2', 'font/woff2'],
  ['.map', 'application/json; charset=utf-8'],
  ['.txt', 'text/plain; charset=utf-8'],
]);

export function validateRunRequest(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, error: '请求体必须是 JSON 对象' };
  }
  for (const key of Object.keys(body)) {
    if (!RUN_KEYS.has(key)) return { ok: false, error: `不认识的字段: ${key}` };
  }

  const config = {
    url: null,
    port: 9222,
    exe: null,
    userDataDir: null,
    sniff: true,
    timeoutMs: 0,
    open: false,
    keepOpen: false,
  };

  if (body.url !== undefined && body.url !== null && body.url !== '') {
    if (typeof body.url !== 'string') return { ok: false, error: 'url 必须是字符串' };
    if (!isLocalTarget(body.url)) {
      return { ok: false, error: `只接受本地地址（localhost / 127.0.0.1 / [::1]），拒绝：${body.url}` };
    }
    config.url = body.url;
  }
  if (body.port !== undefined) {
    if (!Number.isInteger(body.port) || body.port < 1 || body.port > 65535) {
      return { ok: false, error: `port 必须是 1-65535 的整数，收到 ${body.port}` };
    }
    config.port = body.port;
  }
  if (body.timeoutMs !== undefined) {
    if (!Number.isFinite(body.timeoutMs) || body.timeoutMs < 0) {
      return { ok: false, error: `timeoutMs 必须是 >= 0 的毫秒数，收到 ${body.timeoutMs}` };
    }
    config.timeoutMs = body.timeoutMs;
  }
  for (const key of ['sniff', 'open', 'keepOpen']) {
    if (body[key] !== undefined) {
      if (typeof body[key] !== 'boolean') return { ok: false, error: `${key} 必须是布尔值` };
      config[key] = body[key];
    }
  }
  for (const key of ['exe', 'userDataDir']) {
    if (body[key] !== undefined && body[key] !== null) {
      if (typeof body[key] !== 'string' || body[key].trim() === '') {
        return { ok: false, error: `${key} 必须是非空字符串` };
      }
      config[key] = body[key];
    }
  }
  return { ok: true, config };
}

export function buildProbeArgs(config, { jsonPath, htmlPath }) {
  const args = ['--ndjson', '--port', String(config.port), '--json', jsonPath, '--html', htmlPath];
  if (config.exe) args.push('--exe', config.exe);
  if (config.userDataDir) args.push('--user-data-dir', config.userDataDir);
  if (!config.sniff) args.push('--no-sniff');
  if (config.timeoutMs > 0) args.push('--timeout', String(config.timeoutMs));
  if (config.open) args.push('--open');
  if (config.keepOpen) args.push('--keep-open');
  if (config.url) args.push(config.url);
  return args;
}

export function sseFrame(event, data) {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

export function resolveStaticPath(root, urlPath) {
  let decoded;
  try {
    decoded = decodeURIComponent(String(urlPath).split('?')[0].split('#')[0]);
  } catch {
    return null;
  }
  if (decoded.includes('\0')) return null;
  const rel = decoded === '/' ? 'index.html' : decoded.replace(/^\/+/, '');
  const abs = path.resolve(root, rel);
  const rootAbs = path.resolve(root);
  if (abs !== rootAbs && !abs.startsWith(rootAbs + path.sep)) return null;
  return abs;
}

function contentTypeOf(file) {
  return CONTENT_TYPES.get(path.extname(file).toLowerCase()) || 'application/octet-stream';
}

function sendJson(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(text);
}

function readJsonBody(req, limit = 65536) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error('请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
      } catch {
        reject(new Error('请求体不是合法 JSON'));
      }
    });
    req.on('error', reject);
  });
}

function lineSplitter(onLine) {
  let buf = '';
  return (chunk) => {
    buf += chunk;
    let idx;
    while ((idx = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, idx);
      buf = buf.slice(idx + 1);
      if (line.trim() !== '') onLine(line);
    }
  };
}

export function createBridge({ uiDir, runsDir, probePath }) {
  const runs = new Map();
  let active = null;

  function push(run, event, data) {
    const id = run.frames.length;
    const frame = `id: ${id}\n${sseFrame(event, data)}`;
    run.frames.push(frame);
    for (const res of run.subscribers) res.write(frame);
  }

  function endRun(run, code, signal) {
    if (run.ended) return;
    run.ended = true;
    run.code = code;
    push(run, 'end', { code, signal: signal ?? null });
    if (active === run) active = null;
    for (const res of run.subscribers) res.end();
    run.subscribers.clear();
  }

  function startRun(config) {
    const id = randomUUID();
    const dir = path.join(runsDir, id);
    fs.mkdirSync(dir, { recursive: true });
    const jsonPath = path.join(dir, 'hits.json');
    const htmlPath = path.join(dir, 'report.html');
    const args = buildProbeArgs(config, { jsonPath, htmlPath });
    const child = spawn(process.execPath, [probePath, ...args], {
      cwd: path.dirname(probePath),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const run = { id, config, dir, child, frames: [], subscribers: new Set(), ended: false, code: null, startedAt: new Date().toISOString() };
    runs.set(id, run);
    active = run;

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', lineSplitter((line) => {
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        push(run, 'log', { text: line });
        return;
      }
      push(run, typeof event.t === 'string' ? event.t : 'log', event);
    }));

    child.stderr.setEncoding('utf8');
    child.stderr.on('data', lineSplitter((line) => push(run, 'error', { text: line })));

    child.on('error', (err) => {
      push(run, 'error', { text: `启动探针失败: ${err.message}` });
      endRun(run, null, null);
    });
    // 'close' 而不是 'exit'：等 stdio 全部冲完，最后的 summary 才不会丢
    child.on('close', (code, signal) => endRun(run, code, signal));
    push(run, 'started', { runId: id, config, args });
    return run;
  }

  function openEvents(req, res, run) {
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    res.write('retry: 3000\n\n');
    const last = Number(req.headers['last-event-id']);
    const from = Number.isInteger(last) && last >= 0 ? last + 1 : 0;
    for (const frame of run.frames.slice(from)) res.write(frame);
    if (run.ended) {
      res.end();
      return;
    }
    run.subscribers.add(res);
    req.on('close', () => run.subscribers.delete(res));
  }

  async function handle(req, res) {
    const url = new URL(req.url, 'http://127.0.0.1');
    const parts = url.pathname.split('/').filter(Boolean).map((p) => {
      try {
        return decodeURIComponent(p);
      } catch {
        return p;
      }
    });

    if (parts[0] === 'api') {
      if (parts[1] === 'health' && req.method === 'GET') {
        sendJson(res, 200, {
          ok: true,
          name: 'm3u8-probe-bridge',
          version: 1,
          browsers: DEFAULT_BROWSER_CANDIDATES.filter((p) => fs.existsSync(p)),
          probe: probePath,
        });
        return;
      }
      if (parts[1] === 'runs' && parts[2] === 'active' && req.method === 'GET') {
        sendJson(res, 200, active
          ? { runId: active.id, config: active.config, startedAt: active.startedAt }
          : { runId: null });
        return;
      }
      if (parts[1] === 'runs' && parts.length === 2 && req.method === 'POST') {
        if (active) {
          sendJson(res, 409, { error: `已经有一个录制在跑（${active.id}）；先停掉它再开新的` });
          return;
        }
        let body;
        try {
          body = await readJsonBody(req);
        } catch (err) {
          sendJson(res, 400, { error: err.message });
          return;
        }
        const verdict = validateRunRequest(body);
        if (!verdict.ok) {
          sendJson(res, 400, { error: verdict.error });
          return;
        }
        const run = startRun(verdict.config);
        sendJson(res, 201, { runId: run.id, config: run.config, startedAt: run.startedAt });
        return;
      }
      if (parts[1] === 'runs' && parts[2] && parts[3] === 'events' && req.method === 'GET') {
        const run = runs.get(parts[2]);
        if (!run) return sendJson(res, 404, { error: `没有这个录制: ${parts[2]}` });
        openEvents(req, res, run);
        return;
      }
      if (parts[1] === 'runs' && parts[2] && parts[3] === 'stop' && req.method === 'POST') {
        const run = runs.get(parts[2]);
        if (!run) return sendJson(res, 404, { error: `没有这个录制: ${parts[2]}` });
        if (!run.ended) run.child.stdin.write('stop\n');
        sendJson(res, 200, { ok: true, ended: run.ended });
        return;
      }
      if (parts[1] === 'runs' && parts[2] && parts[3] === 'artifact' && parts[4] && req.method === 'GET') {
        const run = runs.get(parts[2]);
        const type = ARTIFACTS.get(parts[4]);
        if (!run || !type) return sendJson(res, 404, { error: '没有这个产物' });
        const file = path.join(run.dir, parts[4]);
        if (!fs.existsSync(file)) return sendJson(res, 404, { error: '产物还没生成' });
        res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store' });
        res.end(fs.readFileSync(file));
        return;
      }
      sendJson(res, 404, { error: `不认识的接口: ${req.method} ${url.pathname}` });
      return;
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      sendJson(res, 405, { error: `静态文件只接受 GET，收到 ${req.method}` });
      return;
    }
    const file = resolveStaticPath(uiDir, url.pathname);
    if (file === null || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('404');
      return;
    }
    res.writeHead(200, { 'content-type': contentTypeOf(file), 'cache-control': 'no-store' });
    res.end(req.method === 'HEAD' ? undefined : fs.readFileSync(file));
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch((err) => {
      if (!res.headersSent) sendJson(res, 500, { error: err.message });
      else res.end();
    });
  });

  return {
    listen(port = 8787, host = '127.0.0.1') {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => {
          server.removeListener('error', reject);
          resolve(server.address().port);
        });
      });
    },
    port() {
      return server.address()?.port ?? null;
    },
    async close() {
      if (active) {
        const run = active;
        const done = new Promise((resolve) => run.child.once('close', resolve));
        run.child.stdin.write('stop\n');
        await Promise.race([done, new Promise((r) => setTimeout(r, 15000))]);
        if (!run.ended) run.child.kill();
      }
      for (const run of runs.values()) {
        for (const res of run.subscribers) res.end();
        run.subscribers.clear();
      }
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

const HELP = `m3u8-probe bridge — 把 CLI 包成本地网页控制台

用法: node bridge.mjs [--port <n>]

  --port <n>   控制台端口，默认 8787（只监听 127.0.0.1）
  -h, --help   显示本帮助

打开 http://127.0.0.1:<port>/ 就是控制台。点"开始录制"会启动一个独立 profile 的
Edge/Chrome 窗口，你在那个窗口里操作到视频播放，再点"停止并出报告"。
只接受 localhost / 127.0.0.1 / [::1] 的起始地址。`;

async function main() {
  const argv = process.argv.slice(2);
  let port = 8787;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      process.stdout.write(`${HELP}\n`);
      return;
    }
    if (arg === '--port' || arg.startsWith('--port=')) {
      const value = arg.includes('=') ? arg.slice(arg.indexOf('=') + 1) : argv[(i += 1)];
      const n = Number(value);
      if (!Number.isInteger(n) || n < 1 || n > 65535) {
        process.stderr.write(`invalid port: ${value}\n`);
        process.exitCode = 2;
        return;
      }
      port = n;
      continue;
    }
    process.stderr.write(`unknown flag: ${arg}\n`);
    process.exitCode = 2;
    return;
  }

  const bridge = createBridge({
    uiDir: path.join(HERE, 'ui'),
    runsDir: path.join(HERE, '.runs'),
    probePath: path.join(HERE, 'm3u8-probe.mjs'),
  });
  try {
    await bridge.listen(port, '127.0.0.1');
  } catch (err) {
    process.stderr.write(`控制台起不来: ${err.message}\n`);
    process.exitCode = 1;
    return;
  }
  process.stdout.write(`控制台: http://127.0.0.1:${bridge.port()}/\n`);
  process.stdout.write('只监听 127.0.0.1，别的机器连不上。Ctrl-C 退出。\n');
  process.on('SIGINT', () => {
    bridge.close().then(() => process.exit(0));
  });
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}