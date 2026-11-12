import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

export const DEFAULT_BROWSER_CANDIDATES = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  path.join(os.homedir(), 'AppData/Local/Google/Chrome/Application/chrome.exe'),
  path.join(os.homedir(), 'AppData/Local/Microsoft/Edge/Application/msedge.exe'),
];

export function defaultUserDataDir() {
  return path.join(os.tmpdir(), 'm3u8-probe-profile');
}

export function findBrowser({ exe, candidates = DEFAULT_BROWSER_CANDIDATES } = {}) {
  if (exe) {
    if (fs.existsSync(exe)) return exe;
    throw new Error(`browser not found at the --exe path: ${exe}`);
  }
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  throw new Error('no browser found; pass --exe <path to msedge.exe or chrome.exe>');
}

export function buildLaunchArgs({ port, userDataDir, url }) {
  const args = [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${userDataDir}`,
    '--no-first-run',
    '--no-default-browser-check',
  ];
  if (url) args.push(url);
  return args;
}

export function pickPageTarget(targets) {
  if (!Array.isArray(targets)) return null;
  const page = targets.find(
    (t) => t && t.type === 'page' && typeof t.webSocketDebuggerUrl === 'string' && !/^devtools:\/\//i.test(t.url || ''),
  );
  return page ?? null;
}

export function createCdpSession(transport) {
  let nextId = 1;
  let closed = false;
  const pending = new Map();
  const listeners = new Map();

  function send(method, params = {}) {
    if (closed) return Promise.reject(new Error('CDP session is closed'));
    const id = nextId;
    nextId += 1;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      transport(JSON.stringify({ id, method, params }));
    });
  }

  function handleText(text) {
    let msg;
    try {
      msg = JSON.parse(text);
    } catch {
      return;
    }
    if (!msg || typeof msg !== 'object') return;

    if (typeof msg.id === 'number') {
      const entry = pending.get(msg.id);
      if (!entry) return;
      pending.delete(msg.id);
      if (msg.error) entry.reject(new Error(msg.error.message || 'CDP command failed'));
      else entry.resolve(msg.result);
      return;
    }

    if (typeof msg.method === 'string') {
      const subscribers = listeners.get(msg.method);
      if (subscribers) for (const handler of subscribers) handler(msg.params ?? {});
    }
  }

  function on(method, handler) {
    if (!listeners.has(method)) listeners.set(method, []);
    listeners.get(method).push(handler);
  }

  function close() {
    if (closed) return;
    closed = true;
    for (const entry of pending.values()) entry.reject(new Error('CDP session closed'));
    pending.clear();
  }

  return { send, handleText, on, close };
}

export function connectCdp(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let session = null;

    ws.addEventListener('open', () => {
      const base = createCdpSession((text) => ws.send(text));
      session = {
        ...base,
        close() {
          base.close();
          ws.close();
        },
      };
      resolve(session);
    });

    ws.addEventListener('message', (event) => {
      if (session) session.handleText(typeof event.data === 'string' ? event.data : String(event.data));
    });

    ws.addEventListener('error', () => {
      if (session) session.close();
      else reject(new Error(`CDP WebSocket connection failed: ${wsUrl}`));
    });

    ws.addEventListener('close', () => {
      if (session) session.close();
    });
  });
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function waitForPageTarget(port, { timeoutMs = 15000, intervalMs = 250 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(2000) });
      if (res.ok) {
        const page = pickPageTarget(await res.json());
        if (page) return page;
      }
    } catch (err) {
      lastError = err;
    }
    await sleep(intervalMs);
  }
  const detail = lastError ? ` (last error: ${lastError.message})` : '';
  throw new Error(`timed out waiting for a page target on debugging port ${port}${detail}`);
}

export function launchBrowser({ exe, port, userDataDir, url }) {
  return spawn(exe, buildLaunchArgs({ port, userDataDir, url }), { stdio: 'ignore' });
}

export function stopBrowser(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  const exited = new Promise((resolve) => child.once('exit', resolve));
  if (process.platform === 'win32') {
    spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
  } else {
    child.kill('SIGTERM');
  }
  return Promise.race([exited, sleep(5000)]);
}