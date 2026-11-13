import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DL_KEYS = new Set(['url', 'saveName', 'saveDir', 'headers', 'exe']);

// N_m3u8DL-CLI 的输出是 .NET 重定向流，中文 Windows 上默认系统代码页（GBK）而不是 UTF-8。
// 同一段字节先用两种解码各试一遍：UTF-8 严，GBK 松——UTF-8 解得通就一定是 UTF-8。
function looksLikeValidUtf8(text) {
  // Buffer.toString('utf8') 遇到坏字节会替换成 U+FFFD；出现替换符就说明这不是 UTF-8
  return !text.includes('\uFFFD');
}

export function decodeChunk(buf, carry = { rest: Buffer.alloc(0), utf8: true }) {
  // 只按换行切，\r 留给行内解析：N_m3u8DL-CLI 的进度行用 \r 原地刷新，一行可能连着很多帧
  const all = Buffer.concat([carry.rest, buf]);
  const frames = [];
  let start = 0;
  for (let i = 0; i < all.length; i += 1) {
    if (all[i] === 0x0a) {
      frames.push(all.subarray(start, i));
      start = i + 1;
    }
  }
  carry.rest = all.subarray(start);
  return frames.map((frame) => {
    let text = frame.toString('utf8');
    if (!looksLikeValidUtf8(text)) {
      text = frame.toString('latin1'); // Node 没有 gbk 解码器；latin1 至少不丢字节不报错
      // GBK 高位字节落在 latin1 里会变成乱码但可控；真正的 GBK 需要完整双字节表，
      // 这里采用保守策略：latin1 化只为了让进度行（纯 ASCII）和文件名透传。
    }
    return { text: text.replace(/\r\n$/, '').replace(/\r$/, ''), raw: frame };
  });
}

const PROGRESS_RE = /Progress:\s*(\d+)\s*\/\s*(\d+)\s*\(([\d.]+)%\)/;
const SPEED_RE = /\(([\d.]+\s*[KMG]?B\/s[^)]*)\)/;

// 一行输出 → 一次状态更新。N_m3u8DL-CLI 把进度和速度放在 \r 连着的同一物理行里。
export function parseDownloadLine(text) {
  const out = {};
  const progress = PROGRESS_RE.exec(text);
  if (progress) {
    out.done = Number(progress[1]);
    out.total = Number(progress[2]);
    out.percent = Number(progress[3]);
  }
  const speed = SPEED_RE.exec(text);
  if (speed) out.speed = speed[1].trim();
  // 阶段串来自 strings.resx（zh-CN 原文），避开泛匹配误伤地址回显
  if (text.includes('开始下载文件')) out.phase = 'downloading';
  else if (text.includes('已下载完毕')) out.phase = 'downloaded';
  else if (text.includes('开始合并分片')) out.phase = 'merging';
  else if (text.includes('使用ffmpeg合并')) out.phase = 'merging';
  else if (text.includes('二进制合并')) out.phase = 'merging';
  else if (text.includes('任务结束')) out.phase = 'done';
  else if (text.includes('下载失败')) out.phase = 'failed';
  else if (text.includes('识别为直播流')) {
    out.phase = 'live';
    out.error = '直播流不支持自动下载（CLI 在重定向 stdin 下会挂起）；请换点播地址';
  } else if (text.includes('获取m3u8内容') || text.includes('解析m3u8内容')) out.phase = 'parsing';
  else if (text.includes('无效的m3u8') || text.includes('地址无效')) {
    out.phase = 'failed';
    out.error = 'CLI 无法解析这个地址（无效的 m3u8）';
  }
  return Object.keys(out).length > 0 ? out : null;
}

const WINDOWS_BAD = /[<>:"/\\|?*\u0000-\u001f]/g;

export function sanitizeSaveName(name) {
  const cleaned = String(name ?? '').replace(WINDOWS_BAD, '_').replace(/^\.+/, '').trim();
  return cleaned === '' ? 'video' : cleaned.slice(0, 120);
}

export function deriveSaveName(url, now = Date.now()) {
  let base = 'video';
  try {
    const parsed = new URL(url);
    const last = parsed.pathname.split('/').filter(Boolean).pop() ?? '';
    base = last.replace(/\.m3u8?$/i, '') || parsed.hostname || 'video';
  } catch {
    base = 'video';
  }
  const stamp = new Date(now).toISOString().replace(/[-:T]/g, '').slice(0, 14);
  return sanitizeSaveName(`${base}_${stamp}`);
}

export function validateHeaders(headers) {
  if (headers === undefined || headers === null || headers === '') return { ok: true, value: null };
  if (typeof headers !== 'string') return { ok: false, error: 'headers 必须是字符串（格式 key:value|key2:value2）' };
  if (/[\u0000-\u0008\u000a-\u001f]/.test(headers)) return { ok: false, error: 'headers 里不能有换行或控制字符' };
  const parts = headers.split('|').filter((p) => p.trim() !== '');
  if (parts.length === 0) return { ok: true, value: null };
  for (const part of parts) {
    if (!part.includes(':')) return { ok: false, error: `headers 段缺少冒号：${part}（格式 key:value，多段用 | 分隔）` };
  }
  return { ok: true, value: headers };
}

export function validateDownloadRequest(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, error: '请求体必须是 JSON 对象' };
  }
  for (const key of Object.keys(body)) {
    if (!DL_KEYS.has(key)) return { ok: false, error: `不认识的字段: ${key}` };
  }
  if (typeof body.url !== 'string' || body.url.trim() === '') {
    return { ok: false, error: 'url 必须是非空字符串' };
  }
  const url = body.url.trim();
  // 和录制同一个边界：一次一个、由用户亲手点出来的地址。只要求是合法 http(s) URL，
  // 别的协议（file:、data:）CLI 也吃不下。
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, error: `不是合法的 URL：${url}` };
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { ok: false, error: `只接受 http(s) 地址，拒绝：${url}` };
  }
  const config = { url, saveName: null, saveDir: null, headers: null, exe: null };
  if (body.saveName !== undefined && body.saveName !== null) {
    if (typeof body.saveName !== 'string') return { ok: false, error: 'saveName 必须是字符串' };
    config.saveName = sanitizeSaveName(body.saveName);
  }
  if (body.saveDir !== undefined && body.saveDir !== null && body.saveDir !== '') {
    if (typeof body.saveDir !== 'string') return { ok: false, error: 'saveDir 必须是字符串' };
    if (body.saveDir.includes('\0')) return { ok: false, error: 'saveDir 不能包含空字符' };
    config.saveDir = body.saveDir.trim();
  }
  const headers = validateHeaders(body.headers);
  if (!headers.ok) return headers;
  config.headers = headers.value;
  if (body.exe !== undefined && body.exe !== null && body.exe !== '') {
    if (typeof body.exe !== 'string') return { ok: false, error: 'exe 必须是字符串' };
    config.exe = body.exe.trim();
  }
  return { ok: true, config };
}

export function buildDownloaderArgs(config, { saveDir, saveName }) {
  const args = [config.url, '--workDir', saveDir, '--saveName', saveName, '--enableDelAfterDone'];
  if (config.headers) args.push('--headers', config.headers);
  return args;
}

// 探测顺序：显式指定 > 项目根 > tools/ > PATH > 常见下载位置。
// existsFn 注入是为了测试；默认 fs.existsSync。
export function downloaderCandidates() {
  const home = process.env.USERPROFILE ?? process.env.HOME ?? '';
  const dirs = [
    HERE,
    path.join(HERE, 'tools'),
    path.join(HERE, 'N_m3u8DL-CLI'),
    ...(home ? [path.join(home, 'Desktop', 'N_m3u8DL-CLI'), path.join(home, 'Downloads', 'N_m3u8DL-CLI'), path.join(home, 'Downloads')] : []),
  ];
  const names = ['N_m3u8DL-CLI.exe', 'N_m3u8DL-CLI_x64.exe', 'n_m3u8dl-cli.exe'];
  const out = [];
  for (const dir of dirs) {
    for (const name of names) out.push(path.join(dir, name));
  }
  for (const dir of (process.env.PATH ?? '').split(path.delimiter).filter(Boolean)) {
    out.push(path.join(dir, 'N_m3u8DL-CLI.exe'));
  }
  return out;
}

export function findDownloader(explicit, existsFn = (p) => fs.existsSync(p)) {
  if (explicit && typeof explicit === 'string' && explicit.trim() !== '') {
    const p = explicit.trim();
    if (!existsFn(p)) return { ok: false, error: `指定的下载器不存在：${p}` };
    return { ok: true, exe: p, source: 'explicit' };
  }
  for (const p of downloaderCandidates()) {
    if (existsFn(p)) return { ok: true, exe: p, source: 'auto' };
  }
  return { ok: false, error: '没找到 N_m3u8DL-CLI.exe：把它放进项目目录，或在下载面板里填完整路径' };
}

function listFinalFiles(saveDir, saveName) {
  try {
    return fs.readdirSync(saveDir)
      .filter((f) => f.toLowerCase().startsWith(saveName.toLowerCase()) && /\.[a-z0-9]{1,5}$/i.test(f))
      .map((f) => path.join(saveDir, f));
  } catch {
    return [];
  }
}

// 与 bridge 的 runs 同款结构：frames 全量留存 + SSE 重放，晚订阅者不丢事件。
export function createDownloadRegistry({ saveRoot, resolveExe, spawnFn = spawn, now = Date.now }) {
  const downloads = new Map();
  let seq = 0;

  function push(dl, event, data) {
    const id = dl.frames.length;
    const frame = `id: ${id}\nevent: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    dl.frames.push(frame);
    for (const res of dl.subscribers) res.write(frame);
  }

  function finish(dl, code, signal) {
    if (dl.ended) return;
    dl.ended = true;
    dl.code = code;
    // 成败判定不能只看退出码：CLI 异常被 catch 后照样 Exit 0，文件在不在才算数
    const files = dl.finalName ? listFinalFiles(dl.saveDir, dl.finalName) : [];
    dl.finalFile = files[0] ?? null;
    push(dl, 'end', {
      code,
      signal: signal ?? null,
      ok: files.length > 0,
      finalFile: dl.finalFile,
      saveDir: dl.saveDir,
    });
    for (const res of dl.subscribers) res.end();
    dl.subscribers.clear();
  }

  function startDownload(config) {
    const verdict = resolveExe(config.exe);
    seq += 1;
    const id = `d${seq}-${randomUUID().slice(0, 8)}`;
    if (!verdict.ok) {
      // 没有进程可挂，但事件流必须和正常任务同形：error 之后照样以 end 收尾
      const dl = {
        id, config, frames: [], subscribers: new Set(), ended: false, code: null,
        finalName: null, finalFile: null, saveDir: null, startedAt: new Date(now()).toISOString(),
      };
      downloads.set(id, dl);
      push(dl, 'started', { downloadId: id, config });
      push(dl, 'error', { text: verdict.error });
      finish(dl, null, null);
      return { id, error: verdict.error, dl };
    }
    const saveDir = config.saveDir ?? saveRoot;
    const finalName = config.saveName ?? deriveSaveName(config.url, now());
    fs.mkdirSync(saveDir, { recursive: true });
    const args = buildDownloaderArgs(config, { saveDir, saveName: finalName });
    const child = spawnFn(verdict.exe, args, { cwd: path.dirname(verdict.exe), stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    const dl = {
      id, config, exe: verdict.exe, args, child,
      frames: [], subscribers: new Set(), ended: false, code: null,
      finalName, finalFile: null, saveDir, startedAt: new Date(now()).toISOString(),
    };
    downloads.set(id, dl);
    push(dl, 'started', { downloadId: id, config: { ...config, saveDir, saveName: finalName, exe: verdict.exe }, args });

    const carry = { rest: Buffer.alloc(0), utf8: true };
    const onOutput = (chunk) => {
      for (const { text } of decodeChunk(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), 'utf8'), carry)) {
        if (text.trim() === '') continue;
        const parsed = parseDownloadLine(text);
        push(dl, 'log', { text });
        if (parsed?.error) push(dl, 'error', { text: parsed.error });
        if (parsed?.phase) push(dl, 'phase', { phase: parsed.phase });
        if (parsed && (parsed.done !== undefined || parsed.speed)) {
          push(dl, 'progress', {
            done: parsed.done ?? dl.done ?? 0,
            total: parsed.total ?? dl.total ?? 0,
            percent: parsed.percent ?? dl.percent ?? 0,
            speed: parsed.speed ?? dl.speed ?? null,
          });
          if (parsed.done !== undefined) dl.done = parsed.done;
          if (parsed.total !== undefined) dl.total = parsed.total;
          if (parsed.percent !== undefined) dl.percent = parsed.percent;
          if (parsed.speed !== undefined) dl.speed = parsed.speed;
        }
      }
    };
    child.stdout.on('data', onOutput);
    child.stderr.on('data', onOutput);

    child.on('error', (err) => {
      push(dl, 'error', { text: `启动下载器失败: ${err.message}` });
      finish(dl, null, null);
    });
    child.on('close', (code, signal) => finish(dl, code, signal));
    push(dl, 'log', { text: `下载器: ${verdict.exe}` });
    return { id, dl };
  }

  function stopDownload(id) {
    const dl = downloads.get(id);
    if (!dl || dl.ended) return false;
    // 先杀进程再清临时目录：CLI 的 --enableDelAfterDone 只在正常收尾时生效
    try { dl.child.kill(); } catch { /* 已经死了 */ }
    if (dl.saveDir && dl.finalName) {
      const tmp = path.join(dl.saveDir, dl.finalName);
      try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* 目录可能不存在 */ }
    }
    return true;
  }

  function snapshot() {
    return [...downloads.values()].map((dl) => ({
      id: dl.id,
      url: dl.config.url,
      saveName: dl.finalName,
      saveDir: dl.saveDir,
      status: dl.ended ? (dl.finalFile ? 'done' : 'failed') : 'running',
      code: dl.code,
      done: dl.done ?? 0,
      total: dl.total ?? 0,
      percent: dl.percent ?? 0,
      speed: dl.speed ?? null,
      finalFile: dl.finalFile,
      startedAt: dl.startedAt,
    }));
  }

  return {
    startDownload,
    stopDownload,
    get(id) { return downloads.get(id); },
    list() { return [...downloads.keys()]; },
    snapshot,
    stopAll() {
      for (const id of downloads.keys()) stopDownload(id);
    },
  };
}

export function sseFramesOf(dl) {
  return dl.frames;
}
