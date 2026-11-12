const JSON_HEADERS = { 'content-type': 'application/json' };

async function jsonOrThrow(res) {
  const text = await res.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = null;
  }
  if (!res.ok) throw new Error(body?.error || `HTTP ${res.status}`);
  return body;
}

export async function detectBridge() {
  try {
    const res = await fetch('api/health', { signal: AbortSignal.timeout(2000), cache: 'no-store' });
    if (!res.ok) return null;
    const body = await res.json();
    return body?.ok ? body : null;
  } catch {
    return null;
  }
}

export async function startRun(config) {
  return jsonOrThrow(await fetch('api/runs', { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify(config) }));
}

export async function stopRun(runId) {
  return jsonOrThrow(await fetch(`api/runs/${encodeURIComponent(runId)}/stop`, { method: 'POST' }));
}

export async function getActive() {
  try {
    return await jsonOrThrow(await fetch('api/runs/active', { cache: 'no-store' }));
  } catch {
    return { runId: null };
  }
}

export function artifactUrl(runId, name) {
  return `api/runs/${encodeURIComponent(runId)}/artifact/${name}`;
}

// EventSource 自己的连接错误没有 data；探针发来的 error 事件有。两者要分开。
export function openEvents(runId, onEvent, onConnection) {
  const source = new EventSource(`api/runs/${encodeURIComponent(runId)}/events`);
  const names = ['started', 'log', 'hit', 'resolved', 'progress', 'summary', 'error', 'end'];
  for (const name of names) {
    source.addEventListener(name, (e) => {
      if (e.data === undefined) return;
      let payload;
      try {
        payload = JSON.parse(e.data);
      } catch {
        return;
      }
      onEvent(name, payload);
    });
  }
  source.onerror = () => {
    if (source.readyState === EventSource.CLOSED) onConnection('closed');
    else onConnection('retrying');
  };
  return () => source.close();
}

export function playDemo(events, onEvent, intervalMs = 260) {
  let i = 0;
  let timer = null;
  const step = () => {
    if (i >= events.length) {
      timer = null;
      return;
    }
    const event = events[i];
    i += 1;
    onEvent(event.t, event);
    timer = setTimeout(step, intervalMs);
  };
  timer = setTimeout(step, 120);
  return () => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
  };
}