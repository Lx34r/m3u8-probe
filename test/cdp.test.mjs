import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import {
  findBrowser,
  buildLaunchArgs,
  pickPageTarget,
  createCdpSession,
  waitForPageTarget,
  stopBrowser,
} from '../cdp.mjs';

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'm3u8-probe-test-'));
}

function touch(dir, name) {
  const p = path.join(dir, name);
  fs.writeFileSync(p, '');
  return p;
}

// break: silently falling back to a bundled guess instead of honouring --exe
test('findBrowser: an explicit existing path wins over candidates', () => {
  const dir = tempDir();
  try {
    const explicit = touch(dir, 'my-browser.exe');
    const other = touch(dir, 'candidate.exe');
    assert.equal(findBrowser({ exe: explicit, candidates: [other] }), explicit);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// break: a typo in --exe being swallowed and some other browser launched instead
test('findBrowser: an explicit missing path throws and names the path', () => {
  const dir = tempDir();
  try {
    const missing = path.join(dir, 'nope.exe');
    assert.throws(() => findBrowser({ exe: missing, candidates: [] }), (err) => {
      assert.ok(err.message.includes(missing), `message did not name the path: ${err.message}`);
      return true;
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// break: returning a candidate that does not exist
test('findBrowser: picks the first candidate that exists', () => {
  const dir = tempDir();
  try {
    const missing = path.join(dir, 'absent.exe');
    const present = touch(dir, 'present.exe');
    assert.equal(findBrowser({ candidates: [missing, present] }), present);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// break: returning undefined and letting spawn fail with a confusing error
test('findBrowser: throws when no candidate exists', () => {
  const dir = tempDir();
  try {
    assert.throws(() => findBrowser({ candidates: [path.join(dir, 'a.exe'), path.join(dir, 'b.exe')] }), /browser/i);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// break: debugging port not passed, so nothing can attach
test('buildLaunchArgs: passes the requested debugging port', () => {
  const args = buildLaunchArgs({ port: 9333, userDataDir: 'C:/tmp/profile' });
  assert.ok(args.includes('--remote-debugging-port=9333'), args.join(' '));
});

// break: omitting user-data-dir, which would attach to the real Edge profile and its logged-in sessions
test('buildLaunchArgs: always uses a dedicated user-data-dir', () => {
  const args = buildLaunchArgs({ port: 9222, userDataDir: 'C:/tmp/probe-profile' });
  assert.ok(args.includes('--user-data-dir=C:/tmp/probe-profile'), args.join(' '));
});

// break: the start URL being treated as a flag, or appended before the flags
test('buildLaunchArgs: the start URL is the last argument', () => {
  const args = buildLaunchArgs({ port: 9222, userDataDir: 'C:/tmp/p', url: 'http://localhost:5173/' });
  assert.equal(args[args.length - 1], 'http://localhost:5173/');
});

// break: injecting an empty argument that Edge interprets as a blank search
test('buildLaunchArgs: no URL means no trailing empty argument', () => {
  const args = buildLaunchArgs({ port: 9222, userDataDir: 'C:/tmp/p' });
  assert.ok(args.every((a) => a.length > 0), JSON.stringify(args));
  assert.ok(!args.some((a) => a.startsWith('http')), JSON.stringify(args));
});

// break: attaching to a service worker or background target instead of the page
test('pickPageTarget: prefers a page target over other types', () => {
  const targets = [
    { type: 'service_worker', url: 'http://local.test/sw.js', webSocketDebuggerUrl: 'ws://sw' },
    { type: 'page', url: 'http://local.test/', webSocketDebuggerUrl: 'ws://page' },
  ];
  assert.equal(pickPageTarget(targets).webSocketDebuggerUrl, 'ws://page');
});

// break: attaching to the devtools window itself
test('pickPageTarget: skips devtools pages', () => {
  const targets = [
    { type: 'page', url: 'devtools://devtools/bundled/inspector.html', webSocketDebuggerUrl: 'ws://devtools' },
    { type: 'page', url: 'http://local.test/', webSocketDebuggerUrl: 'ws://real' },
  ];
  assert.equal(pickPageTarget(targets).webSocketDebuggerUrl, 'ws://real');
});

// break: throwing or returning a non-page target when the browser has no page yet
test('pickPageTarget: returns null when there is no usable page', () => {
  assert.equal(pickPageTarget([]), null);
  assert.equal(pickPageTarget([{ type: 'browser', url: '', webSocketDebuggerUrl: 'ws://b' }]), null);
});

function sessionWithRecorder() {
  const sent = [];
  const session = createCdpSession((text) => sent.push(text));
  return { session, sent };
}

// break: reusing id 1 for every call, so responses resolve the wrong promise
test('cdp session: ids increment and method/params are forwarded verbatim', async () => {
  const { session, sent } = sessionWithRecorder();
  const a = session.send('Network.enable', { maxTotalBufferSize: 10 });
  const b = session.send('Page.navigate', { url: 'http://local.test/' });
  const first = JSON.parse(sent[0]);
  const second = JSON.parse(sent[1]);
  assert.equal(first.id, 1);
  assert.equal(second.id, 2);
  assert.equal(first.method, 'Network.enable');
  assert.deepEqual(first.params, { maxTotalBufferSize: 10 });
  assert.deepEqual(second.params, { url: 'http://local.test/' });
  session.handleText(JSON.stringify({ id: 2, result: { frameId: 'F' } }));
  session.handleText(JSON.stringify({ id: 1, result: {} }));
  assert.deepEqual(await b, { frameId: 'F' });
  assert.deepEqual(await a, {});
});

// break: resolving with the raw envelope instead of the result payload
test('cdp session: resolves with the result payload', async () => {
  const { session } = sessionWithRecorder();
  const pending = session.send('Network.getResponseBody', { requestId: 'R1' });
  session.handleText(JSON.stringify({ id: 1, result: { body: '#EXTM3U', base64Encoded: false } }));
  assert.deepEqual(await pending, { body: '#EXTM3U', base64Encoded: false });
});

// break: hanging forever when the browser refuses a command
test('cdp session: an error response rejects with the CDP message', async () => {
  const { session } = sessionWithRecorder();
  const pending = session.send('Network.getResponseBody', { requestId: 'gone' });
  session.handleText(JSON.stringify({ id: 1, error: { code: -32000, message: 'No resource with given identifier found' } }));
  await assert.rejects(pending, /No resource with given identifier found/);
});

// break: never delivering events, so the recorder sees nothing
test('cdp session: events reach subscribers with their params', () => {
  const { session } = sessionWithRecorder();
  const seen = [];
  session.on('Network.responseReceived', (params) => seen.push(params));
  session.handleText(JSON.stringify({ method: 'Network.responseReceived', params: { requestId: 'R2', response: { url: 'http://local.test/a.m3u8' } } }));
  assert.equal(seen.length, 1);
  assert.equal(seen[0].response.url, 'http://local.test/a.m3u8');
});

// break: only the first subscriber being notified
test('cdp session: every subscriber of an event is notified', () => {
  const { session } = sessionWithRecorder();
  let a = 0;
  let b = 0;
  session.on('Network.loadingFinished', () => { a += 1; });
  session.on('Network.loadingFinished', () => { b += 1; });
  session.handleText(JSON.stringify({ method: 'Network.loadingFinished', params: { requestId: 'R3' } }));
  assert.equal(a, 1);
  assert.equal(b, 1);
});

// break: an unrelated event crashing the recorder
test('cdp session: an event with no subscriber is ignored', () => {
  const { session } = sessionWithRecorder();
  session.handleText(JSON.stringify({ method: 'Network.requestWillBeSent', params: {} }));
});

// break: a late response for an already-settled id throwing
test('cdp session: a response with an unknown id is ignored', () => {
  const { session } = sessionWithRecorder();
  session.handleText(JSON.stringify({ id: 999, result: {} }));
});

// break: one malformed frame killing the whole recording session
test('cdp session: malformed JSON does not throw', () => {
  const { session } = sessionWithRecorder();
  session.handleText('{not json');
  session.handleText('');
});

// break: pending commands hanging forever after the browser window is closed
test('cdp session: close rejects pending commands', async () => {
  const { session } = sessionWithRecorder();
  const pending = session.send('Network.enable');
  session.close();
  await assert.rejects(pending, /closed/i);
});

// break: polling forever, or never finding the page target
test('waitForPageTarget: resolves against a real debugging endpoint', async () => {
  const server = http.createServer((req, res) => {
    if (req.url === '/json/list') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify([{ type: 'page', url: 'http://local.test/', webSocketDebuggerUrl: 'ws://127.0.0.1/devtools/page/ABC' }]));
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  try {
    const target = await waitForPageTarget(port, { timeoutMs: 3000, intervalMs: 50 });
    assert.equal(target.webSocketDebuggerUrl, 'ws://127.0.0.1/devtools/page/ABC');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

// break: reporting success when the browser never opened its debugging port
test('waitForPageTarget: rejects on timeout when nothing is listening', async () => {
  const server = http.createServer(() => {});
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  await assert.rejects(waitForPageTarget(port, { timeoutMs: 300, intervalMs: 50 }), /timed out|timeout/i);
});

// break: reporting success while the browser is still shutting down
test('stopBrowser: resolves only after the spawned process has exited', { timeout: 20000 }, async () => {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  await stopBrowser(child);
  assert.ok(child.exitCode !== null || child.signalCode !== null, 'process was still running when stopBrowser resolved');
});

// break: hanging forever on a child that already exited
test('stopBrowser: an already-exited child resolves immediately', { timeout: 20000 }, async () => {
  const child = spawn(process.execPath, ['-e', 'process.exit(0)'], { stdio: 'ignore' });
  await new Promise((resolve) => child.once('exit', resolve));
  await stopBrowser(child);
  assert.ok(child.exitCode !== null || child.signalCode !== null);
});