import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PassThrough } from 'node:stream';
import {
  isLocalTarget,
  validateRunRequest,
  buildProbeArgs,
  sseFrame,
  resolveStaticPath,
  createBridge,
} from '../bridge.mjs';
import { attachStopControl } from '../m3u8-probe.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

// break: the tool becoming a scraper for arbitrary third-party sites
test('isLocalTarget: loopback hosts are allowed', () => {
  for (const url of [
    'http://localhost:3000/',
    'http://127.0.0.1:53100/hls/',
    'http://[::1]:8080/',
    'http://sub.localhost:5173/',
    'https://localhost:8443/',
    'http://127.0.0.2/',
    'http://localhost.:3000/',
  ]) {
    assert.equal(isLocalTarget(url), true, url);
  }
});

// break: an evasion form slipping past a naive string match
test('isLocalTarget: alternative IPv4 spellings normalise to loopback and stay allowed', () => {
  for (const url of ['http://2130706433/', 'http://0x7f000001/', 'http://0177.0.0.1/', 'http://127.1/']) {
    assert.equal(isLocalTarget(url), true, url);
  }
});

test('isLocalTarget: everything that is not loopback is refused', () => {
  for (const url of [
    'https://www.thisav02.net/cn/vec-550-uncensored-leak',
    'https://example.com/',
    'http://192.168.1.5/',
    'http://10.0.0.1/',
    'http://127.0.0.1.evil.com/',
    'http://evil.com/?next=127.0.0.1',
    'http://localhost.evil.com/',
    'http://0.0.0.0/',
    'http://[::ffff:127.0.0.1]/',
    'http://[2001:db8::1]/',
    'file:///C:/Users/me/site/index.html',
    'javascript:alert(1)',
    'data:text/html,hi',
    'ftp://localhost/',
    'not a url at all',
  ]) {
    assert.equal(isLocalTarget(url), false, url);
  }
});

test('isLocalTarget: no start URL means a blank page, which is allowed', () => {
  assert.equal(isLocalTarget(null), true);
  assert.equal(isLocalTarget(''), true);
});

test('validateRunRequest: defaults match the CLI defaults', () => {
  const r = validateRunRequest({});
  assert.equal(r.ok, true, r.error);
  assert.deepEqual(r.config, {
    url: null,
    port: 9222,
    exe: null,
    userDataDir: null,
    sniff: true,
    timeoutMs: 0,
    open: false,
    keepOpen: false,
  });
});

test('validateRunRequest: a remote target is refused and the message says why', () => {
  const r = validateRunRequest({ url: 'https://example.com/video' });
  assert.equal(r.ok, false);
  assert.match(r.error, /localhost|127\.0\.0\.1|本地/);
  assert.match(r.error, /example\.com/, 'the refusal must name the offending host');
});

test('validateRunRequest: bad port, timeout and types are refused by name', () => {
  assert.match(validateRunRequest({ port: 0 }).error, /port/);
  assert.match(validateRunRequest({ port: 70000 }).error, /port/);
  assert.match(validateRunRequest({ port: 'abc' }).error, /port/);
  assert.match(validateRunRequest({ timeoutMs: -1 }).error, /timeout/);
  assert.match(validateRunRequest({ sniff: 'yes' }).error, /sniff/);
  assert.match(validateRunRequest({ url: 42 }).error, /url/);
});

// break: a typo'd control silently doing nothing
test('validateRunRequest: an unknown key is refused rather than ignored', () => {
  const r = validateRunRequest({ prot: 9222 });
  assert.equal(r.ok, false);
  assert.match(r.error, /prot/);
});

test('validateRunRequest: a non-object body is refused', () => {
  for (const body of [null, 'x', 42, []]) {
    assert.equal(validateRunRequest(body).ok, false, JSON.stringify(body));
  }
});

test('buildProbeArgs: always asks for ndjson and maps every control to its flag', () => {
  const { config } = validateRunRequest({
    url: 'http://127.0.0.1:53100/',
    port: 9333,
    exe: 'C:/Edge/msedge.exe',
    userDataDir: 'C:/tmp/prof',
    sniff: false,
    timeoutMs: 15000,
    open: true,
    keepOpen: true,
  });
  const args = buildProbeArgs(config, { jsonPath: 'C:/r/hits.json', htmlPath: 'C:/r/report.html' });
  assert.ok(args.includes('--ndjson'), args.join(' '));
  const value = (flag) => args[args.indexOf(flag) + 1];
  assert.equal(value('--port'), '9333');
  assert.equal(value('--exe'), 'C:/Edge/msedge.exe');
  assert.equal(value('--user-data-dir'), 'C:/tmp/prof');
  assert.equal(value('--timeout'), '15000');
  assert.equal(value('--json'), 'C:/r/hits.json');
  assert.equal(value('--html'), 'C:/r/report.html');
  assert.ok(args.includes('--no-sniff'));
  assert.ok(args.includes('--open'));
  assert.ok(args.includes('--keep-open'));
  assert.equal(args.at(-1), 'http://127.0.0.1:53100/', 'the start URL must be the last argument');
});

test('buildProbeArgs: defaults produce no empty or undefined arguments', () => {
  const { config } = validateRunRequest({});
  const args = buildProbeArgs(config, { jsonPath: 'j.json', htmlPath: 'r.html' });
  assert.ok(args.every((a) => typeof a === 'string' && a.length > 0), JSON.stringify(args));
  assert.equal(args.includes('--no-sniff'), false);
  assert.equal(args.includes('--open'), false);
  assert.equal(args.includes('--keep-open'), false);
  assert.equal(args.includes('--exe'), false);
  assert.equal(args.includes('--user-data-dir'), false);
  assert.equal(args.includes('--timeout'), false, 'timeout 0 means record until stopped, not a 0ms timer');
});

test('sseFrame: names the event and keeps the payload on one data line', () => {
  const frame = sseFrame('hit', { url: 'http://h/a.m3u8' });
  assert.equal(frame, 'event: hit\ndata: {"url":"http://h/a.m3u8"}\n\n');
});

test('sseFrame: a payload containing newlines cannot break out of the frame', () => {
  const frame = sseFrame('log', { text: 'a\n\nevent: evil' });
  assert.equal(frame.split('\n\n').length, 2, 'payload injected a frame boundary');
  assert.equal(frame.startsWith('event: log\ndata: '), true);
});

test('resolveStaticPath: serves files under the ui root', () => {
  const root = path.join(ROOT, 'ui');
  assert.equal(resolveStaticPath(root, '/'), path.join(root, 'index.html'));
  assert.equal(resolveStaticPath(root, '/app.js'), path.join(root, 'app.js'));
  assert.equal(resolveStaticPath(root, '/assets/x.css'), path.join(root, 'assets', 'x.css'));
});

// break: ../../etc/passwd reading the user's disk through the static handler
test('resolveStaticPath: traversal, absolute paths and encoded escapes are refused', () => {
  const root = path.join(ROOT, 'ui');
  for (const p of [
    '/../m3u8-probe.mjs',
    '/../../Windows/win.ini',
    '/..%2fm3u8-probe.mjs',
    '/%2e%2e/m3u8-probe.mjs',
    '/assets/../../package.json',
    'C:/Windows/win.ini',
    '/%00',
  ]) {
    assert.equal(resolveStaticPath(root, p), null, p);
  }
});

test('attachStopControl: a stop line fires once, across chunk boundaries', () => {
  const stream = new PassThrough();
  let calls = 0;
  attachStopControl(stream, () => { calls += 1; });
  stream.write('sto');
  assert.equal(calls, 0);
  stream.write('p\n');
  assert.equal(calls, 1);
  stream.write('stop\n');
  assert.equal(calls, 1, 'a second stop must not re-enter finish');
});

test('attachStopControl: other lines are ignored', () => {
  const stream = new PassThrough();
  let calls = 0;
  attachStopControl(stream, () => { calls += 1; });
  stream.write('hello\nstatus\n\n');
  assert.equal(calls, 0);
  stream.write('stop\n');
  assert.equal(calls, 1);
});

function tempUi() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'm3u8-bridge-ui-'));
  fs.writeFileSync(path.join(dir, 'index.html'), '<!DOCTYPE html><title>ui</title>');
  fs.mkdirSync(path.join(dir, 'assets'));
  fs.writeFileSync(path.join(dir, 'assets', 'app.js'), 'export const x = 1;\n');
  return dir;
}

async function withBridge(fn, opts = {}) {
  const uiDir = tempUi();
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'm3u8-bridge-runs-'));
  const runsDir = path.join(workDir, 'runs');
  fs.mkdirSync(runsDir);
  let probePath = path.join(ROOT, 'm3u8-probe.mjs');
  if (opts.fakeProbe) {
    probePath = path.join(workDir, 'fake-probe.mjs');
    fs.writeFileSync(probePath, opts.fakeProbe);
  }
  const bridge = createBridge({ uiDir, runsDir, probePath });
  await bridge.listen(0, '127.0.0.1');
  const base = `http://127.0.0.1:${bridge.port()}`;
  try {
    return await fn({ base, bridge, uiDir, runsDir });
  } finally {
    await bridge.close();
    fs.rmSync(uiDir, { recursive: true, force: true });
    fs.rmSync(workDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
}

test('bridge: health answers so the UI can tell live mode from demo mode', async () => {
  await withBridge(async ({ base }) => {
    const res = await fetch(`${base}/api/health`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.name, 'm3u8-probe-bridge');
    assert.ok(Array.isArray(body.browsers) && body.browsers.length > 0, JSON.stringify(body));
  });
});

test('bridge: serves the ui and refuses to leave it', async () => {
  await withBridge(async ({ base }) => {
    const index = await fetch(`${base}/`);
    assert.equal(index.status, 200);
    assert.match(index.headers.get('content-type'), /text\/html/);
    assert.match(await index.text(), /<title>ui<\/title>/);

    const js = await fetch(`${base}/assets/app.js`);
    assert.equal(js.status, 200);
    assert.match(js.headers.get('content-type'), /javascript/);

    const escape = await fetch(`${base}/%2e%2e/m3u8-probe.mjs`);
    assert.equal(escape.status, 404, 'traversal was served');
    const deep = await fetch(`${base}/assets/%2e%2e/%2e%2e/package.json`);
    assert.equal(deep.status, 404, 'encoded traversal was served');
    const missing = await fetch(`${base}/nope.js`);
    assert.equal(missing.status, 404);
  });
});

// break: the bridge accepting a third-party target and becoming the refused scraper
test('bridge: POST /api/runs refuses a non-local target with 400', async () => {
  await withBridge(async ({ base }) => {
    const res = await fetch(`${base}/api/runs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: 'https://example.com/watch' }),
    });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.match(body.error, /example\.com/);
  });
});

test('bridge: a run streams ndjson events over SSE and replays them to a late subscriber', async () => {
  const fake = `
    process.stdout.write(JSON.stringify({ t: 'log', text: '录制中' }) + '\\n');
    process.stdout.write(JSON.stringify({ t: 'hit', hit: { url: 'http://127.0.0.1:1/a.m3u8' } }) + '\\n');
    process.stdin.resume();
    process.stdin.on('data', (d) => {
      if (String(d).includes('stop')) {
        process.stdout.write(JSON.stringify({ t: 'summary', meta: { requests: 3 }, hits: [] }) + '\\n');
        process.exit(0);
      }
    });
  `;
  await withBridge(async ({ base, bridge }) => {
    const res = await fetch(`${base}/api/runs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: 'http://127.0.0.1:53100/', timeoutMs: 0 }),
    });
    const created = await res.text();
    assert.equal(res.status, 201, created);
    const { runId } = JSON.parse(created);
    assert.ok(runId);

    // the fake probe is already running; subscribing now must still replay the first events
    await new Promise((r) => setTimeout(r, 400));
    const events = [];
    const stream = await fetch(`${base}/api/runs/${runId}/events`);
    assert.equal(stream.status, 200);
    assert.match(stream.headers.get('content-type'), /text\/event-stream/);
    const reader = stream.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    const readUntil = async (predicate, ms) => {
      const deadline = Date.now() + ms;
      while (Date.now() < deadline) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let idx;
        while ((idx = buf.indexOf('\n\n')) !== -1) {
          const frame = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          const name = /^event: (.*)$/m.exec(frame)?.[1];
          const data = /^data: (.*)$/m.exec(frame)?.[1];
          if (name === undefined) continue; // retry/comment preamble, not an event
          events.push({ name, data: data === undefined ? null : JSON.parse(data) });
        }
        if (predicate(events)) return;
      }
      throw new Error(`timed out waiting for events; got ${JSON.stringify(events)}`);
    };

    await readUntil((ev) => ev.some((e) => e.name === 'hit'), 5000);
    assert.equal(events[0].name, 'started', 'the bridge must announce the run before any probe output');
    assert.ok(events.some((e) => e.name === 'log' && e.data.text === '录制中'),
      `the log emitted before subscribing was not replayed: ${JSON.stringify(events)}`);
    assert.equal(events.find((e) => e.name === 'hit').data.hit.url, 'http://127.0.0.1:1/a.m3u8');

    const stop = await fetch(`${base}/api/runs/${runId}/stop`, { method: 'POST' });
    assert.equal(stop.status, 200, await stop.text());
    await readUntil((ev) => ev.some((e) => e.name === 'end'), 8000);
    const summary = events.find((e) => e.name === 'summary');
    assert.ok(summary, 'stop did not produce a summary: the probe was killed instead of finished');
    assert.equal(summary.data.meta.requests, 3);
    assert.equal(events.find((e) => e.name === 'end').data.code, 0);
    const active = await (await fetch(`${base}/api/runs/active`)).json();
    assert.equal(active.runId, null, 'the run was not cleared after it ended');
    await reader.cancel().catch(() => {});
  }, { fakeProbe: fake });
});

test('bridge: only one run at a time, and the refusal names the active run', async () => {
  const fake = 'process.stdin.resume(); process.stdin.on("data", (d) => { if (String(d).includes("stop")) process.exit(0); }); setTimeout(() => process.exit(0), 30000);';
  await withBridge(async ({ base }) => {
    const first = await fetch(`${base}/api/runs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    const created = await first.text();
    assert.equal(first.status, 201, created);
    const { runId } = JSON.parse(created);
    const second = await fetch(`${base}/api/runs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    assert.equal(second.status, 409);
    assert.match((await second.json()).error, new RegExp(runId));
    await fetch(`${base}/api/runs/${runId}/stop`, { method: 'POST' });
  }, { fakeProbe: fake });
});

test('bridge: stopping an unknown run is a 404, not a crash', async () => {
  await withBridge(async ({ base }) => {
    const res = await fetch(`${base}/api/runs/does-not-exist/stop`, { method: 'POST' });
    assert.equal(res.status, 404);
    const events = await fetch(`${base}/api/runs/does-not-exist/events`);
    assert.equal(events.status, 404);
  });
});

test('bridge: a probe that dies on stderr surfaces as an error event', async () => {
  const fake = "process.stderr.write('boom: cannot find browser\\n'); process.exit(1);";
  await withBridge(async ({ base }) => {
    const res = await fetch(`${base}/api/runs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    const { runId } = await res.json();
    const stream = await fetch(`${base}/api/runs/${runId}/events`);
    const text = await stream.text();
    assert.match(text, /event: error/);
    assert.match(text, /boom: cannot find browser/);
    assert.match(text, /event: end/);
    assert.match(text, /"code":1/);
  }, { fakeProbe: fake });
});

// break: the export buttons pointing at files the probe was never told to write
test('bridge: the run artifacts are written where the probe was told and are downloadable', async () => {
  const fake = `
    import fs from 'node:fs';
    const args = process.argv.slice(2);
    const val = (f) => args[args.indexOf(f) + 1];
    fs.writeFileSync(val('--json'), JSON.stringify({ meta: { requests: 7 }, hits: [] }));
    fs.writeFileSync(val('--html'), '<!DOCTYPE html><title>report</title>');
    process.stdout.write(JSON.stringify({ t: 'summary', meta: { requests: 7 }, hits: [] }) + '\\n');
    process.exit(0);
  `;
  await withBridge(async ({ base }) => {
    const res = await fetch(`${base}/api/runs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: 'http://localhost:3000/' }),
    });
    const { runId } = await res.json();
    const text = await (await fetch(`${base}/api/runs/${runId}/events`)).text();
    assert.match(text, /event: end/);

    const json = await fetch(`${base}/api/runs/${runId}/artifact/hits.json`);
    const jsonText = await json.text();
    assert.equal(json.status, 200, jsonText);
    assert.equal(JSON.parse(jsonText).meta.requests, 7);

    const html = await fetch(`${base}/api/runs/${runId}/artifact/report.html`);
    assert.equal(html.status, 200);
    assert.match(html.headers.get('content-type'), /text\/html/);
    assert.match(await html.text(), /<title>report<\/title>/);

    for (const name of ['..%2f..%2fpackage.json', 'profile', 'hits.json%00.png']) {
      const bad = await fetch(`${base}/api/runs/${runId}/artifact/${name}`);
      assert.equal(bad.status, 404, name);
    }
  }, { fakeProbe: fake });
});

// break: EventSource reconnecting and replaying the whole run, duplicating every card
test('bridge: Last-Event-ID resumes after the last seen frame instead of replaying everything', async () => {
  const fake = `
    for (const n of [1, 2, 3]) process.stdout.write(JSON.stringify({ t: 'log', text: 'line' + n }) + '\\n');
    process.stdin.resume();
    process.stdin.on('data', (d) => { if (String(d).includes('stop')) process.exit(0); });
    setTimeout(() => process.exit(0), 30000);
  `;
  await withBridge(async ({ base }) => {
    const res = await fetch(`${base}/api/runs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    const { runId } = await res.json();
    await new Promise((r) => setTimeout(r, 400));

    const framesOf = async (headers, want) => {
      const stream = await fetch(`${base}/api/runs/${runId}/events`, { headers });
      const reader = stream.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      const seen = [];
      const deadline = Date.now() + 3000;
      const readBounded = () => {
        let timer;
        const expired = new Promise((resolve) => {
          timer = setTimeout(() => resolve({ done: true, value: undefined }), Math.max(0, deadline - Date.now()));
        });
        return Promise.race([reader.read(), expired]).finally(() => clearTimeout(timer));
      };
      while (Date.now() < deadline && seen.length < want) {
        const { value, done } = await readBounded();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let idx;
        while ((idx = buf.indexOf('\n\n')) !== -1) {
          const frame = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          const id = /^id: (\d+)$/m.exec(frame)?.[1];
          const name = /^event: (.*)$/m.exec(frame)?.[1];
          if (name === undefined) continue;
          seen.push({ id: Number(id), name });
        }
      }
      await reader.cancel().catch(() => {});
      return seen;
    };

    const all = await framesOf({}, 4);
    assert.deepEqual(all.map((f) => f.name), ['started', 'log', 'log', 'log'], JSON.stringify(all));
    assert.deepEqual(all.map((f) => f.id), [0, 1, 2, 3], 'frames must carry sequential ids');

    const resumed = await framesOf({ 'last-event-id': '1' }, 2);
    assert.equal(resumed[0].id, 2, 'resume must start right after the last seen id');
    assert.ok(resumed.every((f) => f.id > 1), `resume replayed frames the client already had: ${JSON.stringify(resumed)}`);
    assert.deepEqual(resumed.map((f) => f.name), ['log', 'log']);

    await fetch(`${base}/api/runs/${runId}/stop`, { method: 'POST' });
  }, { fakeProbe: fake });
});

test('bridge: the active run reports its config so a reloaded UI can reattach', async () => {
  const fake = 'process.stdin.resume(); process.stdin.on("data", (d) => { if (String(d).includes("stop")) process.exit(0); }); setTimeout(() => process.exit(0), 30000);';
  await withBridge(async ({ base }) => {
    const idle = await (await fetch(`${base}/api/runs/active`)).json();
    assert.equal(idle.runId, null);

    const res = await fetch(`${base}/api/runs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: 'http://127.0.0.1:53100/', port: 9444 }),
    });
    const { runId } = await res.json();
    const active = await (await fetch(`${base}/api/runs/active`)).json();
    assert.equal(active.runId, runId);
    assert.equal(active.config.port, 9444);
    assert.equal(active.config.url, 'http://127.0.0.1:53100/');
    assert.ok(active.startedAt, JSON.stringify(active));
    await fetch(`${base}/api/runs/${runId}/stop`, { method: 'POST' });
  }, { fakeProbe: fake });
});