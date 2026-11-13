import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PROBE = path.join(ROOT, 'm3u8-probe.mjs');

const MASTER = '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=640x360,CODECS="avc1.42c01e"\n360.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=1600000,RESOLUTION=1280x720,CODECS="avc1.4d401f"\n720.m3u8\n';
const MEDIA = '#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXT-X-PLAYLIST-TYPE:VOD\n#EXTINF:6.0,\nseg0.ts\n#EXTINF:6.0,\nseg1.ts\n#EXT-X-ENDLIST\n';

const PAGE = '<!DOCTYPE html><html><head><meta charset="utf-8"><title>fixture</title></head><body><video id="v" controls></video><script src="/js/player.js"></script></body></html>';
const SILENT_PAGE = '<!DOCTYPE html><html><head><meta charset="utf-8"><title>silent</title></head><body><p>no requests here</p></body></html>';
const PLAYER_JS = "(async () => {\n  const res = await fetch('/api/manifest');\n  const { src } = await res.json();\n  document.getElementById('v').src = src;\n  await fetch(src);\n  await (await fetch('/api/inline')).text();\n  await fetch('/api/inline-unread');\n  await fetch('/stream/playlist');\n})();\n";

function startFixture() {
  const server = http.createServer((req, res) => {
    const url = req.url.split('?')[0];
    const send = (type, body) => {
      res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store' });
      res.end(body);
    };
    if (url === '/') return send('text/html; charset=utf-8', PAGE);
    if (url === '/silent') return send('text/html; charset=utf-8', SILENT_PAGE);
    if (url === '/js/player.js') return send('text/javascript; charset=utf-8', PLAYER_JS);
    if (url === '/api/manifest') return send('application/json', JSON.stringify({ src: '/hls/master.m3u8' }));
    if (url === '/hls/master.m3u8') return send('application/vnd.apple.mpegurl', MASTER);
    if (url === '/hls/360.m3u8' || url === '/hls/720.m3u8') return send('application/vnd.apple.mpegurl', MEDIA);
    if (url === '/api/inline' || url === '/api/inline-unread') return send('text/plain; charset=utf-8', MEDIA);
    if (url === '/stream/playlist') return send('application/x-mpegURL', MEDIA);
    if (url === '/hls/seg0.ts' || url === '/hls/seg1.ts') return send('video/mp2t', Buffer.alloc(16));
    res.writeHead(404).end('not found');
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, base: `http://127.0.0.1:${server.address().port}` }));
  });
}

function freePort() {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const p = srv.address().port;
      srv.close(() => resolve(p));
    });
  });
}

function runProbe(args, timeoutMs = 90000, onEvent = null) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [PROBE, ...args], { cwd: ROOT, stdio: [onEvent ? 'pipe' : 'ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    let pending = '';
    child.stdout.on('data', (d) => {
      out += d;
      if (!onEvent) return;
      pending += d;
      let nl;
      while ((nl = pending.indexOf('\n')) !== -1) {
        const line = pending.slice(0, nl);
        pending = pending.slice(nl + 1);
        if (line === '') continue;
        try {
          onEvent(JSON.parse(line), child);
        } catch {
          // 非 JSON 行不在这里判，交给用例的逐行解析断言
        }
      }
    });
    child.stderr.on('data', (d) => { err += d; });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`probe timed out\n--- stdout ---\n${out}\n--- stderr ---\n${err}`));
    }, timeoutMs);
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('exit', (code) => { clearTimeout(timer); resolve({ code, out, err }); });
  });
}

// 浏览器退干净之后，Windows 还要一会儿才放开 profile 里的内存映射文件：实测空闲
// 1.4 秒，与整套用例并发时 3.7 / 8.4 / 18.1 秒。rmSync 的 maxRetries 不为 EPERM
// 重试——用 FileShare.None 夹具量过，0/5/100 次都是 1ms 就抛——所以自己等。
async function removeWorkspace(dir, budgetMs = 30000) {
  const deadline = Date.now() + budgetMs;
  for (;;) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      return;
    } catch (err) {
      if (Date.now() >= deadline) throw err;
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
  }
}

async function withWorkspace(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'm3u8-probe-e2e-'));
  const { server, base } = await startFixture();
  let failed = false;
  try {
    return await fn({ dir, base });
  } catch (err) {
    failed = true;
    throw err;
  } finally {
    await new Promise((resolve) => server.close(resolve));
    try {
      await removeWorkspace(dir);
    } catch (cleanupErr) {
      if (!failed) throw cleanupErr;
      console.error(`(cleanup failed, keeping the real assertion error: ${cleanupErr.message})`);
    }
  }
}

// break: the recorder never seeing runtime-generated requests, or losing initiator attribution
test('e2e: captures a runtime-generated m3u8 with its initiator and parses the master', { timeout: 150000 }, async () => {
  await withWorkspace(async ({ dir, base }) => {
    const port = await freePort();
    const jsonPath = path.join(dir, 'hits.json');
    const { code, out, err } = await runProbe([
      `${base}/`, '--port', String(port), '--json', jsonPath,
      '--user-data-dir', path.join(dir, 'profile'), '--timeout', '12000',
    ]);
    assert.equal(code, 0, `probe exited ${code}\n${out}\n${err}`);
    assert.ok(fs.existsSync(jsonPath), `no JSON written\n${out}\n${err}`);
    const { meta, hits } = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));

    assert.ok(meta.requests > 0, 'recorder observed zero requests');
    const master = hits.find((h) => h.url === `${base}/hls/master.m3u8`);
    assert.ok(master, `master not captured. hits=${JSON.stringify(hits.map((h) => h.url))}\n${out}`);
    assert.equal(master.detectedBy, 'url');
    assert.match(master.initiator, /player\.js:\d+/, `initiator was ${master.initiator}`);
    assert.equal(master.playlist.kind, 'master');
    assert.equal(master.playlist.variants.length, 2);
    assert.equal(master.playlist.variants[1].url, `${base}/hls/720.m3u8`);
    assert.equal(master.playlist.variants[1].resolution, '1280x720');
    assert.equal(master.refetch.ok, true);
  });
});

// break: only the URL leg working, so playlists hidden behind plain paths are missed
test('e2e: detects playlists by mimeType and by response body', { timeout: 150000 }, async () => {
  await withWorkspace(async ({ dir, base }) => {
    const port = await freePort();
    const jsonPath = path.join(dir, 'hits.json');
    const { code, out, err } = await runProbe([
      `${base}/`, '--port', String(port), '--json', jsonPath,
      '--user-data-dir', path.join(dir, 'profile'), '--timeout', '12000',
    ]);
    assert.equal(code, 0, `probe exited ${code}\n${out}\n${err}`);
    const { meta, hits } = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));

    const byBody = hits.find((h) => h.url === `${base}/api/inline`);
    assert.ok(byBody, `body-sniffed playlist missing. hits=${JSON.stringify(hits.map((h) => [h.url, h.detectedBy]))}\n${out}`);
    assert.equal(byBody.detectedBy, 'body');
    assert.equal(byBody.playlist.segments, 2);

    const byMime = hits.find((h) => h.url === `${base}/stream/playlist`);
    assert.ok(byMime, `mimeType-detected playlist missing. hits=${JSON.stringify(hits.map((h) => [h.url, h.detectedBy]))}\n${out}`);
    assert.equal(byMime.detectedBy, 'mime');

    // CDP boundary, re-measured after the refetch fallback: a fetch body the page
    // never read still cannot be pulled via getResponseBody ("No data found"),
    // but the recorder now refetches localhost URLs directly. The hit still
    // lands on the body leg, and it is honestly labelled as a refetch instead
    // of pretending CDP returned the body.
    const unread = hits.find((h) => h.url === `${base}/api/inline-unread`);
    assert.ok(unread, `unread inline candidate should now hit via refetch. hits=${JSON.stringify(hits.map((h) => [h.url, h.detectedBy]))}`);
    assert.equal(unread.detectedBy, 'body');
    assert.equal(unread.playlist?.segments, 2);
    assert.ok(meta.sniffed >= 2, `both inline candidates should have been sniffed, got ${meta.sniffed}`);
  });
});

// negative control: break = a vacuous recorder that always reports zero hits
test('e2e: a page that makes no media requests reports zero hits but non-zero observations', { timeout: 150000 }, async () => {
  await withWorkspace(async ({ dir, base }) => {
    const port = await freePort();
    const jsonPath = path.join(dir, 'hits.json');
    const { code, out, err } = await runProbe([
      `${base}/silent`, '--port', String(port), '--json', jsonPath,
      '--user-data-dir', path.join(dir, 'profile'), '--timeout', '10000',
    ]);
    assert.equal(code, 0, `probe exited ${code}\n${out}\n${err}`);
    const { meta, hits } = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
    assert.equal(hits.length, 0, `expected no hits, got ${JSON.stringify(hits.map((h) => h.url))}`);
    assert.ok(meta.requests >= 1, `recorder saw no requests at all, so the zero is not trustworthy: ${JSON.stringify(meta)}`);
    assert.match(out, /命中 0/, out);
  });
});

// break: silently attaching to somebody else's already-running debugging browser
test('e2e: refuses a debugging port that is already serving another browser', { timeout: 60000 }, async () => {
  const squatter = http.createServer((req, res) => {
    if (req.url === '/json/version') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ Browser: 'SomeoneElses/1.0' }));
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise((resolve) => squatter.listen(0, '127.0.0.1', resolve));
  const port = squatter.address().port;
  try {
    const { code, out, err } = await runProbe(['--port', String(port), '--timeout', '3000'], 30000);
    assert.equal(code, 1, `expected refusal, got ${code}\n${out}\n${err}`);
    assert.match(`${out}${err}`, /已被另一个浏览器占用/, `${out}${err}`);
  } finally {
    await new Promise((resolve) => squatter.close(resolve));
  }
});

// break: the UI's Stop button killing the probe and orphaning the browser it launched
test('e2e: the bridge drives a real capture and Stop finishes it gracefully', { timeout: 180000 }, async () => {
  const { createBridge } = await import('../bridge.mjs');
  await withWorkspace(async ({ dir, base }) => {
    const port = await freePort();
    const uiDir = path.join(dir, 'ui');
    fs.mkdirSync(uiDir);
    fs.writeFileSync(path.join(uiDir, 'index.html'), '<!DOCTYPE html><title>console</title>');
    const runsDir = path.join(dir, 'runs');
    fs.mkdirSync(runsDir);
    const bridge = createBridge({ uiDir, runsDir, probePath: PROBE });
    await bridge.listen(0, '127.0.0.1');
    const api = `http://127.0.0.1:${bridge.port()}`;
    try {
      const created = await fetch(`${api}/api/runs`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          url: `${base}/`,
          port,
          userDataDir: path.join(dir, 'profile'),
          timeoutMs: 0,
        }),
      });
      const createdText = await created.text();
      assert.equal(created.status, 201, createdText);
      const { runId } = JSON.parse(createdText);

      const stream = await fetch(`${api}/api/runs/${runId}/events`);
      const reader = stream.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      const events = [];
      const pump = async (predicate, ms) => {
        const deadline = Date.now() + ms;
        while (Date.now() < deadline) {
          let timer;
          const expired = new Promise((resolve) => { timer = setTimeout(() => resolve({ done: true }), Math.max(0, deadline - Date.now())); });
          const { value, done } = await Promise.race([reader.read(), expired]).finally(() => clearTimeout(timer));
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          let idx;
          while ((idx = buf.indexOf('\n\n')) !== -1) {
            const frame = buf.slice(0, idx);
            buf = buf.slice(idx + 2);
            const name = /^event: (.*)$/m.exec(frame)?.[1];
            const data = /^data: (.*)$/m.exec(frame)?.[1];
            if (name === undefined) continue;
            events.push({ name, data: JSON.parse(data) });
          }
          if (predicate(events)) return;
        }
        throw new Error(`timed out; events so far: ${JSON.stringify(events.map((e) => e.name))}`);
      };

      // 前提：页面把三个请求都发完了才停。只等 master 解析完就停会截掉后面的 body/mime 两条腿。
      const wanted = [`${base}/hls/master.m3u8`, `${base}/api/inline`, `${base}/stream/playlist`];
      await pump((ev) => {
        const seen = new Set(ev.filter((e) => e.name === 'hit').map((e) => e.data.hit.url));
        return wanted.every((u) => seen.has(u))
          && ev.some((e) => e.name === 'resolved' && e.data.hit?.playlist?.kind === 'master');
      }, 60000);
      const master = events.find((e) => e.name === 'resolved' && e.data.hit.playlist?.kind === 'master');
      assert.equal(master.data.hit.playlist.variants.length, 2);
      assert.match(master.data.hit.initiator, /player\.js:\d+/);

      const stop = await fetch(`${api}/api/runs/${runId}/stop`, { method: 'POST' });
      assert.equal(stop.status, 200);
      await pump((ev) => ev.some((e) => e.name === 'end'), 60000);

      const summary = events.find((e) => e.name === 'summary');
      assert.ok(summary, 'Stop killed the probe instead of letting it finish: no summary event');
      assert.ok(summary.data.meta.requests > 0);
      assert.ok(summary.data.hits.length >= 3, `expected url+mime+body hits, got ${summary.data.hits.length}`);
      assert.equal(events.find((e) => e.name === 'end').data.code, 0);
      assert.ok(summary.data.hits.every((h) => !('requestHeaders' in h) && !('body' in h)), 'credentials reached the UI');

      const report = await fetch(`${api}/api/runs/${runId}/artifact/report.html`);
      assert.equal(report.status, 200, 'the HTML report was not written');
      assert.match(await report.text(), /master\.m3u8/);
      const json = await fetch(`${api}/api/runs/${runId}/artifact/hits.json`);
      assert.equal(json.status, 200);
      assert.ok((await json.json()).hits.length >= 3);
      await reader.cancel().catch(() => {});
    } finally {
      await bridge.close();
    }
  });
});

// break: the UI bridge getting a stream it cannot parse, or losing the final summary to process.exit
test('e2e: --ndjson emits one parseable event per line and ends with a complete summary', { timeout: 150000 }, async () => {
  await withWorkspace(async ({ dir, base }) => {
    const port = await freePort();
    // 前提要在用例里构造：等三条腿都解析完再收尾，而不是赌固定墙钟够跑完夹具序列。
    // --timeout 只当兜底，机器慢时它不再决定量到的是半截还是整场。
    const wanted = ['/hls/master.m3u8', '/api/inline', '/stream/playlist'].map((p) => base + p);
    const seen = new Set();
    let stopped = false;
    const { code, out, err } = await runProbe([
      `${base}/`, '--port', String(port), '--ndjson',
      '--user-data-dir', path.join(dir, 'profile'), '--timeout', '60000',
    ], 90000, (e, child) => {
      if (stopped || e.t !== 'resolved' || !e.hit) return;
      if (wanted.includes(e.hit.url)) seen.add(e.hit.url);
      if (seen.size === wanted.length) {
        stopped = true;
        child.stdin.write('stop\n');
      }
    });
    assert.equal(code, 0, `probe exited ${code}\n${out}\n${err}`);
    assert.ok(stopped, '事件驱动的收尾没触发：三条腿没在兜底超时前凑齐');

    const lines = out.split('\n').filter((l) => l.length > 0);
    assert.ok(lines.length >= 4, `expected several events, got ${lines.length}\n${out}`);
    const events = lines.map((l, i) => {
      try {
        return JSON.parse(l);
      } catch {
        throw new Error(`line ${i + 1} is not JSON (human text leaked into the event stream): ${l}`);
      }
    });

    const kinds = new Set(events.map((e) => e.t));
    for (const k of ['log', 'hit', 'resolved', 'summary']) {
      assert.ok(kinds.has(k), `no ${k} event; saw ${[...kinds].join(',')}`);
    }
    assert.equal(events.at(-1).t, 'summary', 'the summary must be the last event, not a truncated write');

    // break: counters only existing in the summary, so a live console reads 请求 0 until the run ends
    const progress = events.filter((e) => e.t === 'progress');
    assert.ok(progress.length > 0, `no progress event before the summary; saw ${[...kinds].join(',')}`);
    assert.ok(progress.some((e) => e.requests > 0), `every progress frame reported zero requests: ${JSON.stringify(progress)}`);
    assert.ok(events.indexOf(progress.at(-1)) < events.length - 1, 'progress must not come after the summary');
    assert.equal(progress.at(-1).requests, events.at(-1).meta.requests, 'the last progress frame must agree with the summary');

    const summary = events.at(-1);
    assert.ok(summary.meta.requests > 0, 'recorder observed zero requests');
    assert.ok(summary.hits.length >= 3, `expected url+mime+body hits, got ${summary.hits.length}`);
    assert.ok(Array.isArray(summary.meta.mediaHints), 'summary must carry mediaHints for the zero-hit diagnosis');

    const master = events.find((e) => e.t === 'resolved' && e.hit.url === `${base}/hls/master.m3u8`);
    assert.ok(master, `no resolved master event\n${out}`);
    assert.equal(master.hit.playlist.kind, 'master');
    assert.equal(master.hit.playlist.variants.length, 2);
    assert.equal(master.hit.playlist.variants[1].url, `${base}/hls/720.m3u8`);
    assert.match(master.hit.initiator, /player\.js:\d+/);

    // every hit event precedes its resolved event, so the UI can render a card then fill it
    const hitUrls = events.filter((e) => e.t === 'hit').map((e) => e.hit.url);
    const resolvedUrls = events.filter((e) => e.t === 'resolved').map((e) => e.hit.url);
    assert.deepEqual([...resolvedUrls].sort(), [...hitUrls].sort(), 'hit and resolved events do not pair up');

    for (const e of events) {
      if (!e.hit) continue;
      assert.equal('requestHeaders' in e.hit, false, `requestHeaders leaked on the wire: ${e.hit.url}`);
      assert.equal('body' in e.hit, false, `raw body leaked on the wire: ${e.hit.url}`);
    }
  });
});

// break: a fatal error reaching the UI as an unparseable stderr blob instead of an event
test('e2e: --ndjson reports a fatal error as an event on stdout', { timeout: 60000 }, async () => {
  const squatter = http.createServer((req, res) => {
    if (req.url === '/json/version') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ Browser: 'SomeoneElses/1.0' }));
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise((resolve) => squatter.listen(0, '127.0.0.1', resolve));
  const port = squatter.address().port;
  try {
    const { code, out } = await runProbe(['--port', String(port), '--ndjson', '--timeout', '3000'], 30000);
    assert.equal(code, 1, `expected refusal, got ${code}\n${out}`);
    const events = out.split('\n').filter(Boolean).map((l) => JSON.parse(l));
    const failure = events.find((e) => e.t === 'error');
    assert.ok(failure, `no error event\n${out}`);
    assert.match(failure.text, /已被另一个浏览器占用/);
  } finally {
    await new Promise((resolve) => squatter.close(resolve));
  }
});