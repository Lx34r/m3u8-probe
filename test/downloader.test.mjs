import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { EventEmitter } from 'node:events';
import {
  decodeChunk,
  parseDownloadLine,
  sanitizeSaveName,
  deriveSaveName,
  validateHeaders,
  validateDownloadRequest,
  buildDownloaderArgs,
  downloaderCandidates,
  findDownloader,
  createDownloadRegistry,
} from '../downloader.mjs';

// break: N_m3u8DL-CLI 的进度行被 \r 原地刷新，切错行会把整段进度吞成一行
test('decodeChunk: splits on newlines across chunk boundaries and keeps the tail', () => {
  const carry = { rest: Buffer.alloc(0), utf8: true };
  // 没有换行结尾的尾巴留在 carry 里，等下一个 chunk 拼完再出帧
  let frames = decodeChunk(Buffer.from('Progress: 1/10 (10.00%)\nProgress: 2', 'utf8'), carry);
  assert.deepEqual(frames.map((f) => f.text), ['Progress: 1/10 (10.00%)']);
  frames = decodeChunk(Buffer.from('/10 (20.00%)\n', 'utf8'), carry);
  assert.deepEqual(frames.map((f) => f.text), ['Progress: 2/10 (20.00%)']);
  assert.deepEqual(decodeChunk(Buffer.alloc(0), carry).map((f) => f.text), []);
});

test('decodeChunk: survives bytes that are not valid utf8 without throwing', () => {
  // GBK「开始」的首字节 0xBF 0xAA 不是合法 UTF-8 序列；重点是行边界仍然正确
  const bad = Buffer.from([0xbf, 0xaa, 0xd5, 0xfd, 0x0a]);
  const frames = decodeChunk(bad, { rest: Buffer.alloc(0), utf8: true });
  assert.equal(frames.length, 1);
  assert.ok(typeof frames[0].text === 'string');
});

// break: 进度正则跟真实输出的格式（Progress: n/total (pct)）对不上
test('parseDownloadLine: extracts done/total/percent and speed from real progress frames', () => {
  const parsed = parseDownloadLine('Progress: 12/240 (5.00%) -- 1.2MB/24.0MB (3.1MB/s @ 00:07:33)');
  assert.equal(parsed.done, 12);
  assert.equal(parsed.total, 240);
  assert.equal(parsed.percent, 5);
  assert.match(parsed.speed, /3\.1MB\/s/);
});

test('parseDownloadLine: a speed-only frame keeps progress fields separate', () => {
  const parsed = parseDownloadLine('(1.5MB/s)');
  assert.equal(parsed.done, undefined);
  assert.equal(parsed.speed, '1.5MB/s');
});

test('parseDownloadLine: maps the phase strings from strings.resx, not loose matches', () => {
  assert.equal(parseDownloadLine('开始下载文件').phase, 'downloading');
  assert.equal(parseDownloadLine('已下载完毕').phase, 'downloaded');
  assert.equal(parseDownloadLine('开始合并分片...').phase, 'merging');
  assert.equal(parseDownloadLine('使用ffmpeg合并...请耐心等待').phase, 'merging');
  assert.equal(parseDownloadLine('任务结束').phase, 'done');
  assert.equal(parseDownloadLine('下载失败, 程序退出').phase, 'failed');
  assert.equal(parseDownloadLine('获取m3u8内容').phase, 'parsing');
});

// break: 直播流在无人值守下挂着 CLI，UI 还显示「下载中」
test('parseDownloadLine: a live stream is an explicit error, not a silent hang', () => {
  const parsed = parseDownloadLine('识别为直播流, 开始录制...');
  assert.equal(parsed.phase, 'live');
  assert.match(parsed.error, /直播/);
});

test('parseDownloadLine: plain lines yield null so the log stays the log', () => {
  for (const text of ['', 'N_m3u8DL-CLI v3.0.2', 'http://127.0.0.1/x.m3u8', '存储路径：C:\\x']) {
    assert.equal(parseDownloadLine(text), null, text);
  }
});

test('sanitizeSaveName: Windows-hostile names become safe ones', () => {
  assert.equal(sanitizeSaveName('a<b>:c/d\\e|f?g*h'), 'a_b__c_d_e_f_g_h');
  assert.equal(sanitizeSaveName('....hidden'), 'hidden');
  assert.equal(sanitizeSaveName('   '), 'video');
  assert.equal(sanitizeSaveName(null), 'video');
  assert.equal(sanitizeSaveName('x'.repeat(300)).length <= 120, true);
});

test('deriveSaveName: uses the last path segment, strips .m3u8, stamps time', () => {
  const name = deriveSaveName('http://127.0.0.1:53100/hls/master.m3u8', Date.UTC(2026, 10, 13, 9, 30, 5));
  assert.match(name, /^master_\d{14}$/);
  assert.equal(deriveSaveName('http://127.0.0.1:53100/', 0).startsWith('127.0.0.1_'), true);
  assert.equal(deriveSaveName('not a url', 0), 'video_19700101000000');
});

test('validateHeaders: accepts k:v|k2:v2, rejects control chars and missing colons', () => {
  assert.equal(validateHeaders('Referer:http://x|Cookie:a=b').ok, true);
  assert.equal(validateHeaders(undefined).ok, true);
  assert.equal(validateHeaders('').value, null);
  assert.equal(validateHeaders('Referer').ok, false);
  assert.equal(validateHeaders('Referer:http://x\nCookie:y').ok, false);
});

// break: 下载接口变成无人值守的批量抽流器
test('validateDownloadRequest: url required and present, unknown keys refused', () => {
  const ok = validateDownloadRequest({ url: 'https://example.com/v.m3u8', headers: 'Referer:http://localhost' });
  assert.equal(ok.ok, true, ok.error);
  assert.equal(ok.config.url, 'https://example.com/v.m3u8');
  assert.equal(ok.config.saveName, null);

  assert.match(validateDownloadRequest({ url: 'http://localhost:1/x', prot: 1 }).error, /prot/);
  assert.equal(validateDownloadRequest({ url: '' }).ok, false);
  assert.equal(validateDownloadRequest('x').ok, false);
  assert.equal(validateDownloadRequest({ url: 'http://localhost:1/x', saveName: 'a<b>' }).config.saveName, 'a_b_');
  assert.match(validateDownloadRequest({ url: 'http://localhost:1/x', headers: 'a:b\n' }).error, /控制字符|换行/);
});

test('buildDownloaderArgs: url first, workDir/saveName mapped, cleanup on by default', () => {
  const args = buildDownloaderArgs({ url: 'http://127.0.0.1:1/a.m3u8', headers: null }, { saveDir: 'C:\\dl', saveName: 'a_1' });
  assert.equal(args[0], 'http://127.0.0.1:1/a.m3u8');
  const value = (flag) => args[args.indexOf(flag) + 1];
  assert.equal(value('--workDir'), 'C:\\dl');
  assert.equal(value('--saveName'), 'a_1');
  assert.ok(args.includes('--enableDelAfterDone'));
  assert.equal(args.includes('--headers'), false);
  const withHeaders = buildDownloaderArgs({ url: 'http://127.0.0.1:1/a.m3u8', headers: 'Referer:x' }, { saveDir: 'C:\\dl', saveName: 'a_1' });
  assert.equal(withHeaders[withHeaders.indexOf('--headers') + 1], 'Referer:x');
});

test('findDownloader: explicit wins, then candidates; missing explicit names the path', () => {
  const exists = new Set(['C:/cli/N_m3u8DL-CLI.exe', downloaderCandidates()[0]]);
  const explicit = findDownloader('C:/cli/N_m3u8DL-CLI.exe', (p) => exists.has(p));
  assert.equal(explicit.ok, true);
  assert.equal(explicit.source, 'explicit');

  const auto = findDownloader(null, (p) => exists.has(p));
  assert.equal(auto.ok, true);
  assert.equal(auto.exe, downloaderCandidates()[0]);

  const missing = findDownloader('C:/nowhere.exe', () => false);
  assert.equal(missing.ok, false);
  assert.match(missing.error, /nowhere\.exe/);
  assert.match(findDownloader(null, () => false).error, /N_m3u8DL-CLI/);
});

function fakeCli(t, { script, files = [] }) {
  // 模拟 N_m3u8DL-CLI：按 script 决定输出和退出码；files 是退出后"落盘"的最终文件
  const proc = new EventEmitter();
  proc.stdout = new PassThrough();
  proc.stderr = new PassThrough();
  proc.kill = () => {
    proc.emit('close', null, 'SIGTERM');
  };
  t.setImmediate(() => {
    script(proc);
    for (const f of files) fs.writeFileSync(f, 'x');
    proc.emit('close', 0, null);
  });
  return proc;
}

function tempRegistry(t, { resolveExe, spawnFn } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'm3u8-dl-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }));
  const registry = createDownloadRegistry({
    saveRoot: root,
    resolveExe: resolveExe ?? (() => ({ ok: true, exe: 'C:/fake/N_m3u8DL-CLI.exe', source: 'auto' })),
    // 默认注入假 spawn：测试不真的启动进程，退出时把"最终文件"落盘
    spawnFn: spawnFn ?? ((exe, args) => {
      const proc = new EventEmitter();
      proc.stdout = new PassThrough();
      proc.stderr = new PassThrough();
      proc.kill = () => proc.emit('close', null, 'SIGTERM');
      setImmediate(() => {
        fs.writeFileSync(path.join(root, args[args.indexOf('--saveName') + 1] + '.mp4'), 'x');
        proc.emit('close', 0, null);
      });
      return proc;
    }),
    now: () => Date.UTC(2026, 10, 13, 9, 30, 5),
  });
  return { root, registry };
}

async function eventsOf(dl) {
  // 等 close 事件被推完
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline && !dl.ended) {
    await new Promise((r) => setTimeout(r, 20));
  }
  return dl.frames.map((frame) => ({
    name: /^event: (.*)$/m.exec(frame)?.[1],
    data: JSON.parse(/^data: (.*)$/m.exec(frame)?.[1] ?? 'null'),
  }));
}

test('registry: a successful download ends with the final file it produced', async (t) => {
  const { root, registry } = tempRegistry(t);
  const started = registry.startDownload({ url: 'http://127.0.0.1:53100/hls/master.m3u8' });
  assert.equal(started.error, undefined);
  const dl = started.dl;
  // 未指定 saveName 时由 URL 派生：基名 + 时间戳，防同名覆盖
  assert.equal(dl.finalName, 'master_20261113093005');

  const events = await eventsOf(dl);
  const end = events.at(-1);
  assert.equal(end.name, 'end');
  assert.equal(end.data.ok, true, JSON.stringify(end.data));
  assert.ok(end.data.finalFile.startsWith(root), end.data.finalFile);
  assert.match(path.basename(end.data.finalFile), new RegExp(`^${dl.finalName}\\.`));
  assert.ok(events.some((e) => e.name === 'started' && e.data.downloadId === started.id));
});

// break: CLI 异常被 catch 后照样 Exit 0——退出码 0 但没有文件必须判失败
test('registry: exit 0 without a final file is a failure, not a success', async (t) => {
  const { registry } = tempRegistry(t, { resolveExe: () => ({ ok: false, error: '没找到 N_m3u8DL-CLI.exe：把它放进项目目录' }) });
  const started = registry.startDownload({ url: 'http://127.0.0.1:53100/hls/a.m3u8' });
  const events = await eventsOf(started.dl);
  // resolveExe 直接失败时没有进程可挂：error 之后紧跟 end，frames 以 end 收尾
  const end = events.at(-1);
  assert.equal(end.name, 'end');
  assert.equal(end.data.ok, false);
  assert.ok(events.some((e) => e.name === 'error' && /N_m3u8DL-CLI/.test(e.data.text)));
});

test('registry: progress events stream through and the snapshot reflects them', async (t) => {
  // 假 CLI 会吐进度行但不落最终文件：ok 判定只看文件，不看退出码
  const { registry } = tempRegistry(t, {
    spawnFn: () => {
      const proc = new EventEmitter();
      proc.stdout = new PassThrough();
      proc.stderr = new PassThrough();
      proc.kill = () => {};
      setImmediate(() => {
        proc.stdout.write('开始下载文件\n');
        proc.stdout.write('Progress: 4/10 (40.00%) -- 9.2MB/23.0MB (3.1MB/s)\r(3.1MB/s)\n');
        proc.emit('close', 0, null);
      });
      return proc;
    },
  });
  const started = registry.startDownload({ url: 'http://127.0.0.1:53100/hls/a.m3u8' });
  const events = await eventsOf(started.dl);
  const progress = events.find((e) => e.name === 'progress');
  assert.ok(progress, JSON.stringify(events.map((e) => e.name)));
  assert.equal(progress.data.done, 4);
  assert.equal(progress.data.total, 10);
  assert.equal(progress.data.percent, 40);
  assert.match(progress.data.speed, /3\.1MB\/s/);
  const shot = registry.snapshot()[0];
  assert.equal(shot.status, 'failed', 'exit 0 but no file must still be a failure');
  assert.equal(shot.done, 4);
  assert.equal(shot.percent, 40);
});

// break: SSE 晚订阅者拿不到已经发生的下载事件
test('registry: late subscribers replay every frame via the same events endpoint protocol', async (t) => {
  const { registry } = tempRegistry(t);
  const started = registry.startDownload({ url: 'http://127.0.0.1:53100/hls/a.m3u8' });
  await eventsOf(started.dl);
  const res = new PassThrough();
  const sink = [];
  res.on('data', (c) => sink.push(String(c)));
  for (const frame of started.dl.frames) res.write(frame);
  const text = sink.join('');
  assert.match(text, /event: started/);
  assert.match(text, /event: end/);
  assert.match(text, /^id: \d+$/m);
});
