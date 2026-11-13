(() => {
'use strict';
// file:// 直开用的打包产物：由 tools/bundle.mjs 从 ui/*.js 源码生成，别手改。
// stage/err 给 file:// 排障用：页面停在「检测中…」时能直接读 window.__m3u8Stage。
try {
  window.__m3u8Stage = 'start';
  window.addEventListener('error', (e) => { window.__m3u8Err = String(e.message ?? e.error); });
  window.addEventListener('unhandledrejection', (e) => { window.__m3u8Err = 'rejection: ' + String(e.reason?.message ?? e.reason); });
} catch {}
const m3u8ui = {};
window.__m3u8 = m3u8ui;
// ----- local-target.js -----
m3u8ui["localTarget"] = {};
window.__m3u8Stage = "local-target.js";
(() => {
// 这个工具只服务于"你自己的本地站点"。任意第三方地址一律拒绝，别把它变成抽流器。
// 桥接和前端共用这一份判据，避免两边的规则各自漂移。
function isLocalTarget(url) {
  if (url === null || url === undefined || url === '') return true;
  if (typeof url !== 'string') return false;
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
  const host = parsed.hostname.toLowerCase().replace(/\.$/, '');
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  if (host === '[::1]') return true;
  const v4 = /^127\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  return v4 !== null && v4.slice(1).every((n) => Number(n) <= 255);
}

// 页面自己不在 loopback 上时（GitHub Pages、file://），桥接根本够不着，
// 别发那个必然 404 的探针——调试工具不该自己先在控制台报一条红。
function canReachBridge(href) {
  if (typeof href !== 'string' || href === '') return false;
  let parsed;
  try {
    parsed = new URL(href);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
  return isLocalTarget(href);
}
m3u8ui["localTarget"] = { isLocalTarget: isLocalTarget, canReachBridge: canReachBridge };
})();

// ----- autostop.js -----
m3u8ui["autostop"] = {};
window.__m3u8Stage = "autostop.js";
(() => {
// 一键获取的收尾判据：纯函数，方便在没有浏览器的情况下判假。
// 取到地址就停，但不能在还有命中没解析完时停——那会把 master 的码流清单丢在半路。
const AUTO_STOP_DEFAULTS = { settleMs: 1500, maxWaitMs: 30000 };

function autoStopDecision({
  startedAt, now, lastHitAt, hits, resolved,
  settleMs = AUTO_STOP_DEFAULTS.settleMs,
  maxWaitMs = AUTO_STOP_DEFAULTS.maxWaitMs,
}) {
  if (now - startedAt >= maxWaitMs) return 'timeout';
  if (hits === 0) return null;
  if (resolved < hits) return null;
  if (now - lastHitAt >= settleMs) return 'settled';
  return null;
}

// 输出区要的是"能直接拿去用的地址"：命中本身，加上 master 里的各条码流。
// 同一个地址只出现一次，保持首次出现的顺序。
function collectAddresses(hits) {
  const out = [];
  const seen = new Set();
  const push = (url, kind, from) => {
    if (typeof url !== 'string' || url === '' || seen.has(url)) return;
    seen.add(url);
    out.push({ url, kind, from });
  };
  for (const hit of hits) {
    push(hit.url, hit.playlist?.kind ?? 'unknown', hit.detectedBy);
    for (const v of hit.playlist?.variants ?? []) push(v.url, 'variant', hit.detectedBy);
  }
  return out;
}
m3u8ui["autostop"] = { AUTO_STOP_DEFAULTS: () => AUTO_STOP_DEFAULTS, AUTO_STOP_DEFAULTS_getter: () => AUTO_STOP_DEFAULTS, autoStopDecision: autoStopDecision, collectAddresses: collectAddresses };
})();

// ----- store.js -----
m3u8ui["store"] = {};
window.__m3u8Stage = "store.js";
(() => {
const DEFAULT_CONFIG = {
  url: '',
  port: 9222,
  exe: '',
  userDataDir: '',
  sniff: true,
  timeoutMs: 0,
  open: false,
  keepOpen: false,
};

const LOG_LIMIT = 300;
const UNDO_LIMIT = 20;
const ARRAY_FILTERS = new Set(['detectedBy', 'kind']);
const SORT_KEYS = new Set(['time', 'bandwidth', 'segments', 'url', 'manual']);

function initialState() {
  return {
    config: { ...DEFAULT_CONFIG },
    connection: 'unknown',
    sound: false,
    run: { status: 'idle', runId: null, startedAt: null, code: null, error: null },
    counters: { requests: 0, responses: 0, sniffed: 0 },
    hits: [],
    mediaHints: [],
    log: [],
    selected: [],
    query: '',
    filters: { detectedBy: [], kind: [], encrypted: 'any', live: 'any' },
    sort: { key: 'time', dir: 'asc' },
    manualOrder: null,
    views: [],
    undo: [],
    seq: 0,
  };
}

function toRunRequest(config) {
  const text = (v) => (typeof v === 'string' && v.trim() !== '' ? v : null);
  return {
    url: text(config.url),
    port: config.port,
    exe: text(config.exe),
    userDataDir: text(config.userDataDir),
    sniff: Boolean(config.sniff),
    timeoutMs: config.timeoutMs,
    open: Boolean(config.open),
    keepOpen: Boolean(config.keepOpen),
  };
}

function maxBandwidth(hit) {
  const variants = hit.playlist?.variants;
  if (!Array.isArray(variants) || variants.length === 0) return 0;
  return variants.reduce((m, v) => Math.max(m, Number(v.bandwidth) || 0), 0);
}

function haystack(hit) {
  const p = hit.playlist;
  const parts = [hit.url, hit.initiator, hit.mimeType, hit.detectedBy];
  if (p) {
    for (const v of p.variants ?? []) parts.push(v.url, v.codecs, v.resolution, v.name);
    for (const k of p.keys ?? []) parts.push(k.url, k.uri, k.method);
    if (p.map) parts.push(p.map.url);
    parts.push(p.firstSegmentUrl);
  }
  return parts.filter((x) => typeof x === 'string').join('\n').toLowerCase();
}

function matchesFilters(hit, filters) {
  if (filters.detectedBy.length > 0 && !filters.detectedBy.includes(hit.detectedBy)) return false;
  const kind = hit.playlist?.kind ?? null;
  if (filters.kind.length > 0 && !filters.kind.includes(kind)) return false;
  const encrypted = hit.playlist?.encrypted === true;
  if (filters.encrypted === 'yes' && !encrypted) return false;
  if (filters.encrypted === 'no' && encrypted) return false;
  if (filters.live === 'live' && hit.playlist?.live !== true) return false;
  if (filters.live === 'vod' && !(kind === 'media' && hit.playlist.live === false)) return false;
  return true;
}

function selectVisible(state) {
  const q = state.query.trim().toLowerCase();
  const matched = state.hits.filter((h) => matchesFilters(h, state.filters) && (q === '' || haystack(h).includes(q)));
  if (state.sort.key === 'manual' && Array.isArray(state.manualOrder)) {
    const rank = new Map(state.manualOrder.map((id, i) => [id, i]));
    const placed = matched.filter((h) => rank.has(h.id)).sort((a, b) => rank.get(a.id) - rank.get(b.id));
    const rest = matched.filter((h) => !rank.has(h.id));
    return [...placed, ...rest];
  }
  const dir = state.sort.dir === 'desc' ? -1 : 1;
  const value = (h) => {
    switch (state.sort.key) {
      case 'bandwidth': return maxBandwidth(h);
      case 'segments': return h.playlist?.segments ?? 0;
      case 'url': return h.url;
      default: return h.seq;
    }
  };
  return [...matched].sort((a, b) => {
    const va = value(a);
    const vb = value(b);
    const cmp = typeof va === 'string' ? va.localeCompare(vb) : va - vb;
    return cmp !== 0 ? cmp * dir : a.seq - b.seq;
  });
}

function reorderIds(ids, dragId, targetId, after = false) {
  const from = ids.indexOf(dragId);
  const target = ids.indexOf(targetId);
  if (from === -1 || target === -1 || dragId === targetId) return [...ids];
  const next = ids.filter((id) => id !== dragId);
  const shifted = next.indexOf(targetId);
  next.splice(after ? shifted + 1 : shifted, 0, dragId);
  return next;
}

function snapshot(state, label) {
  return { label, hits: state.hits, manualOrder: state.manualOrder, selected: state.selected };
}

function pushUndo(state, entry) {
  return [...state.undo, entry].slice(-UNDO_LIMIT);
}

function mergeHit(state, incoming, mode) {
  const index = state.hits.findIndex((h) => h.url === incoming.url);
  if (index === -1) {
    if (mode === 'resolved') return state;
    const seq = state.seq + 1;
    const hit = { count: 1, ...incoming, id: `h${seq}`, seq, receivedAt: Date.now() };
    return { ...state, seq, hits: [...state.hits, hit] };
  }
  const existing = state.hits[index];
  const merged = { ...existing, ...incoming, id: existing.id, seq: existing.seq, receivedAt: existing.receivedAt };
  // summary 带来的是探针去重后的权威计数，不能再加一次
  if (mode === 'hit') merged.count = (existing.count ?? 1) + 1;
  else if (mode === 'summary') merged.count = incoming.count ?? existing.count ?? 1;
  else merged.count = existing.count ?? 1;
  const hits = [...state.hits];
  hits[index] = merged;
  return { ...state, hits };
}

function reduce(state, action) {
  switch (action.type) {
    case 'CONNECTION_SET':
      return { ...state, connection: action.mode };

    case 'CONFIG_SET':
      return { ...state, config: { ...state.config, [action.key]: action.value } };

    case 'CONFIG_RESET':
      return { ...state, config: { ...DEFAULT_CONFIG } };

    case 'SOUND_SET':
      return { ...state, sound: Boolean(action.value) };

    case 'RUN_STARTED':
      return {
        ...state,
        run: { status: 'recording', runId: action.runId, startedAt: action.startedAt, code: null, error: null },
        hits: [],
        log: [],
        selected: [],
        mediaHints: [],
        counters: { requests: 0, responses: 0, sniffed: 0 },
        manualOrder: null,
        undo: [],
      };

    case 'RUN_STATUS':
      return { ...state, run: { ...state.run, status: action.status } };

    case 'HIT':
      return mergeHit(state, action.hit, 'hit');

    case 'RESOLVED':
      return mergeHit(state, action.hit, 'resolved');

    case 'SUMMARY': {
      let next = {
        ...state,
        counters: {
          requests: action.meta.requests ?? 0,
          responses: action.meta.responses ?? 0,
          sniffed: action.meta.sniffed ?? 0,
        },
        mediaHints: action.meta.mediaHints ?? [],
      };
      for (const h of action.hits) next = mergeHit(next, h, 'summary');
      return next;
    }

    case 'PROGRESS': {
      const c = state.counters;
      return {
        ...state,
        counters: {
          requests: Math.max(c.requests, action.requests ?? 0),
          responses: Math.max(c.responses, action.responses ?? 0),
          sniffed: Math.max(c.sniffed, action.sniffed ?? 0),
        },
      };
    }

    case 'END':
      return {
        ...state,
        run: { ...state.run, status: state.run.status === 'error' ? 'error' : 'finished', code: action.code },
      };

    case 'ERROR':
      return { ...state, run: { ...state.run, status: 'error', error: action.text } };

    case 'LOG':
      return { ...state, log: [...state.log, { text: action.text, at: Date.now() }].slice(-LOG_LIMIT) };

    case 'QUERY_SET':
      return { ...state, query: action.text };

    case 'FILTER_SET': {
      const { key, value } = action;
      if (ARRAY_FILTERS.has(key)) {
        const current = state.filters[key];
        const next = Array.isArray(value)
          ? [...value]
          : (current.includes(value) ? current.filter((v) => v !== value) : [...current, value]);
        return { ...state, filters: { ...state.filters, [key]: next } };
      }
      return { ...state, filters: { ...state.filters, [key]: value } };
    }

    case 'SORT_SET':
      return { ...state, sort: { key: action.key, dir: action.dir } };

    case 'REORDER':
      return { ...state, manualOrder: [...action.ids], sort: { ...state.sort, key: 'manual' } };

    case 'SELECT_TOGGLE': {
      const selected = state.selected.includes(action.id)
        ? state.selected.filter((id) => id !== action.id)
        : [...state.selected, action.id];
      return { ...state, selected };
    }

    case 'SELECT_VISIBLE':
      return { ...state, selected: selectVisible(state).map((h) => h.id) };

    case 'SELECT_NONE':
      return { ...state, selected: [] };

    case 'DELETE': {
      const ids = new Set(action.ids);
      const removed = state.hits.filter((h) => ids.has(h.id));
      if (removed.length === 0) return state;
      return {
        ...state,
        hits: state.hits.filter((h) => !ids.has(h.id)),
        selected: state.selected.filter((id) => !ids.has(id)),
        manualOrder: state.manualOrder ? state.manualOrder.filter((id) => !ids.has(id)) : null,
        undo: pushUndo(state, snapshot(state, `删除 ${removed.length} 条命中`)),
      };
    }

    case 'CLEAR': {
      if (state.hits.length === 0) return state;
      return {
        ...state,
        hits: [],
        selected: [],
        manualOrder: null,
        undo: pushUndo(state, snapshot(state, `清空 ${state.hits.length} 条命中`)),
      };
    }

    case 'UNDO': {
      if (state.undo.length === 0) return state;
      const entry = state.undo.at(-1);
      return {
        ...state,
        hits: entry.hits,
        manualOrder: entry.manualOrder,
        selected: entry.selected,
        undo: state.undo.slice(0, -1),
      };
    }

    case 'VIEW_SAVE': {
      const name = String(action.name ?? '').trim();
      if (name === '') return state;
      const view = {
        id: `v${state.seq + 1}-${state.views.length}`,
        name,
        query: state.query,
        filters: { ...state.filters, detectedBy: [...state.filters.detectedBy], kind: [...state.filters.kind] },
        sort: { ...state.sort },
      };
      return { ...state, seq: state.seq + 1, views: [...state.views, view] };
    }

    case 'VIEW_APPLY': {
      const view = state.views.find((v) => v.id === action.id);
      if (!view) return state;
      return {
        ...state,
        query: view.query,
        filters: { ...view.filters, detectedBy: [...view.filters.detectedBy], kind: [...view.filters.kind] },
        sort: { ...view.sort },
      };
    }

    case 'VIEW_DELETE':
      return { ...state, views: state.views.filter((v) => v.id !== action.id) };

    default:
      return state;
  }
}

function serialize(state) {
  return {
    version: 1,
    config: state.config,
    views: state.views,
    sound: state.sound,
    query: state.query,
    filters: state.filters,
    sort: state.sort,
  };
}

function hydrate(saved) {
  const base = initialState();
  if (!saved || typeof saved !== 'object' || Array.isArray(saved)) return base;

  const config = { ...DEFAULT_CONFIG };
  if (saved.config && typeof saved.config === 'object') {
    for (const key of Object.keys(DEFAULT_CONFIG)) {
      const value = saved.config[key];
      if (value === undefined) continue;
      if (typeof value === typeof DEFAULT_CONFIG[key]) config[key] = value;
    }
  }

  const filters = { ...base.filters };
  if (saved.filters && typeof saved.filters === 'object') {
    for (const key of ['detectedBy', 'kind']) {
      if (Array.isArray(saved.filters[key])) filters[key] = saved.filters[key].filter((v) => typeof v === 'string');
    }
    for (const key of ['encrypted', 'live']) {
      if (['any', 'yes', 'no', 'live', 'vod'].includes(saved.filters[key])) filters[key] = saved.filters[key];
    }
  }

  const sort = SORT_KEYS.has(saved.sort?.key) && ['asc', 'desc'].includes(saved.sort?.dir)
    ? { key: saved.sort.key, dir: saved.sort.dir }
    : base.sort;

  const views = Array.isArray(saved.views)
    ? saved.views.filter((v) => v && typeof v.id === 'string' && typeof v.name === 'string').map((v) => ({
      id: v.id,
      name: v.name,
      query: typeof v.query === 'string' ? v.query : '',
      filters: v.filters && typeof v.filters === 'object' ? { ...base.filters, ...v.filters } : { ...base.filters },
      sort: SORT_KEYS.has(v.sort?.key) ? { key: v.sort.key, dir: v.sort.dir === 'desc' ? 'desc' : 'asc' } : { ...base.sort },
    }))
    : [];

  return {
    ...base,
    config,
    filters,
    sort,
    views,
    sound: saved.sound === true,
    query: typeof saved.query === 'string' ? saved.query : '',
  };
}
m3u8ui["store"] = { DEFAULT_CONFIG: () => DEFAULT_CONFIG, DEFAULT_CONFIG_getter: () => DEFAULT_CONFIG, initialState: initialState, toRunRequest: toRunRequest, selectVisible: selectVisible, reorderIds: reorderIds, reduce: reduce, serialize: serialize, hydrate: hydrate };
})();

// ----- demo.js -----
m3u8ui["demo"] = {};
window.__m3u8Stage = "demo.js";
(() => {
function seededRandom(seed) {
  let a = (Number(seed) >>> 0) || 1;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function sibling(url, name) {
  return `${url.replace(/[^/]+$/, '')}${name}`;
}

function mediaPlaylist(url, { segments, live, encrypted, targetDuration }) {
  return {
    url,
    valid: true,
    kind: 'media',
    version: 3,
    playlistType: live ? null : 'VOD',
    targetDuration,
    mediaSequence: 0,
    endList: !live,
    live,
    segments,
    totalDuration: segments * targetDuration,
    firstSegmentUrl: sibling(url, 'seg0.ts'),
    variants: [],
    keys: encrypted ? [{ method: 'AES-128', uri: 'enc.key', url: sibling(url, 'enc.key'), iv: null, keyFormat: null, keyFormatVersions: null }] : [],
    encrypted,
    map: null,
    warnings: [],
  };
}

function masterPlaylist(url, base) {
  return {
    url,
    valid: true,
    kind: 'master',
    version: 3,
    playlistType: null,
    targetDuration: null,
    mediaSequence: null,
    endList: false,
    live: false,
    segments: 0,
    totalDuration: 0,
    firstSegmentUrl: null,
    variants: [
      { bandwidth: 800000, averageBandwidth: null, resolution: '640x360', codecs: 'avc1.42c01e', frameRate: null, name: null, url: `${base}/hls/360.m3u8` },
      { bandwidth: 1600000, averageBandwidth: null, resolution: '1280x720', codecs: 'avc1.4d401f,mp4a.40.2', frameRate: null, name: null, url: `${base}/hls/720.m3u8` },
    ],
    keys: [],
    encrypted: false,
    map: null,
    warnings: [],
  };
}

// 演示模式不是幻灯片：它按当前配置生成事件，所以每个开关都能看出差别。
function demoEvents(config, seed = 1) {
  const rand = seededRandom(seed);
  const base = (config.url && config.url.trim() !== '' ? config.url : 'http://127.0.0.1:53100/').replace(/\/+$/, '');
  const pick = (n) => Math.floor(rand() * n);
  const events = [];
  const resolvedHits = [];
  const log = (text) => events.push({ t: 'log', text });

  log('浏览器: C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe');
  log(`调试端口: ${config.port}`);
  log(`起始页: ${base}/`);
  log('录制中… 这是演示数据，没有真的启动浏览器。');

  const requests = 40 + pick(140);
  const totals = {
    requests,
    responses: requests - 2,
    sniffed: config.sniff ? 12 + pick(24) : 0,
  };
  let seen = 0;
  const progress = (fraction) => events.push({
    t: 'progress',
    requests: Math.round(totals.requests * fraction),
    responses: Math.round(totals.responses * fraction),
    sniffed: Math.round(totals.sniffed * fraction),
  });

  const addHit = (url, detectedBy, mimeType, initiator, playlist) => {
    const hit = { url, status: 200, mimeType, initiator, detectedBy, refetch: null, playlist: null };
    events.push({ t: 'hit', hit: { ...hit } });
    const resolved = { ...hit, refetch: { ok: true, status: 200, finalUrl: url }, playlist };
    resolvedHits.push(resolved);
    events.push({ t: 'resolved', hit: resolved });
    seen += 1;
    progress(seen / 4);
  };

  addHit(`${base}/hls/master.m3u8`, 'url', 'application/vnd.apple.mpegurl', `player.js:${20 + pick(60)} loadStream`, masterPlaylist(`${base}/hls/master.m3u8`, base));
  addHit(`${base}/hls/720.m3u8`, 'url', 'application/vnd.apple.mpegurl', 'other', mediaPlaylist(`${base}/hls/720.m3u8`, { segments: 2 + pick(6), live: false, encrypted: true, targetDuration: 6 }));
  addHit(`${base}/stream/playlist`, 'mime', 'application/x-mpegURL', 'hls.js:412 onManifestLoaded', mediaPlaylist(`${base}/stream/playlist`, { segments: 3 + pick(4), live: true, encrypted: false, targetDuration: 4 }));
  if (config.sniff) {
    addHit(`${base}/api/inline`, 'body', 'text/plain', `p.js:${1 + pick(9)}`, mediaPlaylist(`${base}/api/inline`, { segments: 2 + pick(3), live: false, encrypted: false, targetDuration: 5 }));
  }

  progress(1);
  events.push({
    t: 'summary',
    meta: {
      ...totals,
      startUrl: `${base}/`,
      port: config.port,
      generatedAt: new Date().toISOString(),
      mediaHints: [`${base}/hls/seg0.ts`, `${base}/hls/seg1.ts`],
    },
    hits: resolvedHits.map((h) => ({ ...h, count: 1 })),
  });

  return events;
}
m3u8ui["demo"] = { seededRandom: seededRandom, demoEvents: demoEvents };
})();

// ----- export.js -----
m3u8ui["exportMod"] = {};
window.__m3u8Stage = "export.js";
(() => {
const CSV_COLUMNS = [
  ['url', (h) => h.url],
  ['detectedBy', (h) => h.detectedBy],
  ['status', (h) => h.status],
  ['mimeType', (h) => h.mimeType],
  ['initiator', (h) => h.initiator],
  ['kind', (h) => h.playlist?.kind ?? ''],
  ['live', (h) => (h.playlist ? String(h.playlist.live) : '')],
  ['segments', (h) => h.playlist?.segments ?? ''],
  ['totalDuration', (h) => h.playlist?.totalDuration ?? ''],
  ['encrypted', (h) => (h.playlist ? String(h.playlist.encrypted) : '')],
  ['keys', (h) => (h.playlist?.keys ?? []).map((k) => k.url ?? k.uri ?? '').join(' ')],
  ['variants', (h) => h.playlist?.variants?.length ?? ''],
  ['maxBandwidth', (h) => (h.playlist?.variants ?? []).reduce((m, v) => Math.max(m, Number(v.bandwidth) || 0), 0)],
  ['count', (h) => h.count ?? 1],
  ['refetch', (h) => (h.refetch ? `${h.refetch.ok ? 'ok' : 'fail'} ${h.refetch.status ?? ''}`.trim() : '')],
];

function csvCell(value) {
  const text = String(value ?? '');
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function exportCsv(hits) {
  const rows = [CSV_COLUMNS.map(([name]) => name).join(',')];
  for (const hit of hits) rows.push(CSV_COLUMNS.map(([, get]) => csvCell(get(hit))).join(','));
  return rows.join('\n');
}

function exportAddresses(hits) {
  return hits.map((h) => h.url).join('\n');
}

function exportJson(state, hits) {
  return JSON.stringify({
    exportedAt: new Date().toISOString(),
    connection: state.connection,
    config: state.config,
    counters: state.counters,
    run: state.run,
    hits,
  }, null, 2);
}
m3u8ui["exportMod"] = { exportCsv: exportCsv, exportAddresses: exportAddresses, exportJson: exportJson };
})();

// ----- api.js -----
m3u8ui["apiMod"] = {};
const canReachBridge = m3u8ui["localTarget"].canReachBridge;

window.__m3u8Stage = "api.js";
(() => {

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

async function detectBridge(href) {
  if (!canReachBridge(href)) return null;
  try {
    const res = await fetch('api/health', { signal: AbortSignal.timeout(2000), cache: 'no-store' });
    if (!res.ok) return null;
    const body = await res.json();
    return body?.ok ? body : null;
  } catch {
    return null;
  }
}

async function startRun(config) {
  return jsonOrThrow(await fetch('api/runs', { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify(config) }));
}

async function stopRun(runId) {
  return jsonOrThrow(await fetch(`api/runs/${encodeURIComponent(runId)}/stop`, { method: 'POST' }));
}

async function getActive() {
  try {
    return await jsonOrThrow(await fetch('api/runs/active', { cache: 'no-store' }));
  } catch {
    return { runId: null };
  }
}

function artifactUrl(runId, name) {
  return `api/runs/${encodeURIComponent(runId)}/artifact/${name}`;
}

// EventSource 自己的连接错误没有 data；探针发来的 error 事件有。两者要分开。
function openEvents(runId, onEvent, onConnection) {
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

function playDemo(events, onEvent, intervalMs = 260) {
  let i = 0;
  let timer = null;
  const step = () => {
    if (i >= events.length) {
      timer = null;
      onEvent('end', { code: 0 });
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
m3u8ui["apiMod"] = { detectBridge: detectBridge, startRun: startRun, stopRun: stopRun, getActive: getActive, artifactUrl: artifactUrl, openEvents: openEvents, playDemo: playDemo };
})();

// ----- app.js -----
m3u8ui["appMod"] = {};
const DEFAULT_CONFIG = m3u8ui["store"].DEFAULT_CONFIG_getter();
const initialState = m3u8ui["store"].initialState;
const reduce = m3u8ui["store"].reduce;
const selectVisible = m3u8ui["store"].selectVisible;
const toRunRequest = m3u8ui["store"].toRunRequest;
const serialize = m3u8ui["store"].serialize;
const hydrate = m3u8ui["store"].hydrate;
const reorderIds = m3u8ui["store"].reorderIds;
const demoEvents = m3u8ui["demo"].demoEvents;
const exportJson = m3u8ui["exportMod"].exportJson;
const exportCsv = m3u8ui["exportMod"].exportCsv;
const exportAddresses = m3u8ui["exportMod"].exportAddresses;
const isLocalTarget = m3u8ui["localTarget"].isLocalTarget;
const autoStopDecision = m3u8ui["autostop"].autoStopDecision;
const collectAddresses = m3u8ui["autostop"].collectAddresses;
const AUTO_STOP_DEFAULTS = m3u8ui["autostop"].AUTO_STOP_DEFAULTS_getter();
const api = { detectBridge: m3u8ui["apiMod"].detectBridge, startRun: m3u8ui["apiMod"].startRun, stopRun: m3u8ui["apiMod"].stopRun, getActive: m3u8ui["apiMod"].getActive, artifactUrl: m3u8ui["apiMod"].artifactUrl, openEvents: m3u8ui["apiMod"].openEvents, playDemo: m3u8ui["apiMod"].playDemo };

window.__m3u8Stage = "app.js";
(() => {






const STORAGE_KEY = 'm3u8-probe-console-v1';
const $ = (id) => document.getElementById(id);

function el(tag, attrs = {}, ...kids) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === null || value === undefined || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = String(value);
    else if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2), value);
    else if (value === true) node.setAttribute(key, '');
    else node.setAttribute(key, String(value));
  }
  for (const kid of kids.flat(Infinity)) {
    if (kid === null || kid === undefined || kid === false) continue;
    node.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  }
  return node;
}

function loadSaved() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
  } catch {
    return null;
  }
}

let state = hydrate(loadSaved());
let drawerId = null;
let dragId = null;
let closeEvents = null;
let cancelDemo = null;
let toastTimer = null;
let audio = null;
let demoSeed = 1;
let busy = false;
// 一键获取：取到地址并解析完就自己收尾，不用人盯着点停止
let autoFetch = null;
let copiedUrl = null;
let copiedTimer = null;

function persist() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(serialize(state)));
  } catch {
    // 隐私模式下写不进去，不影响本次使用
  }
}

function dispatch(action) {
  state = reduce(state, action);
  render();
  persist();
}

/* ---------------- sound ---------------- */
// 默认静音：调试音视频时突然响一声是干扰。打开后每条新命中一声轻响。
function blip() {
  if (!state.sound) return;
  try {
    audio = audio || new (window.AudioContext || window.webkitAudioContext)();
    if (audio.state === 'suspended') audio.resume();
    const osc = audio.createOscillator();
    const gain = audio.createGain();
    osc.type = 'sine';
    osc.frequency.value = 880;
    gain.gain.setValueAtTime(0.0001, audio.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.05, audio.currentTime + 0.012);
    gain.gain.exponentialRampToValueAtTime(0.0001, audio.currentTime + 0.13);
    osc.connect(gain).connect(audio.destination);
    osc.start();
    osc.stop(audio.currentTime + 0.14);
  } catch {
    // 没有 WebAudio 就安静地跳过
  }
}

/* ---------------- clipboard & download ---------------- */
async function copyText(text, label) {
  try {
    await navigator.clipboard.writeText(text);
    toast(`已复制${label}`);
    return true;
  } catch {
    const area = el('textarea', { style: 'position:fixed;left:-9999px;top:0' });
    area.value = text;
    document.body.append(area);
    area.select();
    let ok = false;
    try {
      ok = document.execCommand('copy');
    } catch {
      ok = false;
    }
    area.remove();
    toast(ok ? `已复制${label}` : '复制失败，请手动选择文本', !ok);
    return ok;
  }
}

function download(name, text, type) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = el('a', { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
  toast(`已导出 ${name}`);
}

/* ---------------- toast ---------------- */
function toast(text, canUndo = false) {
  $('toast-text').textContent = text;
  $('toast-undo').hidden = !canUndo;
  $('toast').hidden = false;
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { $('toast').hidden = true; }, canUndo ? 9000 : 3200);
}

/* ---------------- run control ---------------- */
function stopStreaming() {
  if (closeEvents) { closeEvents(); closeEvents = null; }
  if (cancelDemo) { cancelDemo(); cancelDemo = null; }
}

function handleEvent(name, payload) {
  switch (name) {
    case 'started':
      dispatch({ type: 'RUN_STARTED', runId: payload.runId, startedAt: payload.startedAt ?? new Date().toISOString() });
      break;
    case 'log':
      dispatch({ type: 'LOG', text: payload.text ?? '' });
      break;
    case 'hit':
      dispatch({ type: 'HIT', hit: payload.hit });
      if (autoFetch) autoFetch.lastHitAt = Date.now();
      blip();
      break;
    case 'resolved':
      dispatch({ type: 'RESOLVED', hit: payload.hit });
      break;
    case 'progress':
      dispatch({ type: 'PROGRESS', requests: payload.requests, responses: payload.responses, sniffed: payload.sniffed });
      break;
    case 'summary':
      dispatch({ type: 'SUMMARY', meta: payload.meta ?? {}, hits: payload.hits ?? [] });
      break;
    case 'error':
      dispatch({ type: 'ERROR', text: payload.text ?? '未知错误' });
      dispatch({ type: 'LOG', text: payload.text ?? '未知错误' });
      break;
    case 'end':
      dispatch({ type: 'END', code: payload.code ?? null });
      stopStreaming();
      busy = false;
      render();
      break;
    default:
      break;
  }
}

async function startLive() {
  const body = toRunRequest(state.config);
  dispatch({ type: 'RUN_STATUS', status: 'starting' });
  let created;
  try {
    created = await api.startRun(body);
  } catch (err) {
    dispatch({ type: 'ERROR', text: err.message });
    busy = false;
    render();
    return;
  }
  dispatch({ type: 'RUN_STARTED', runId: created.runId, startedAt: created.startedAt });
  closeEvents = api.openEvents(
    created.runId,
    handleEvent,
    (status) => {
      if (status === 'closed' && state.run.status === 'recording') {
        dispatch({ type: 'ERROR', text: '与本地桥接的连接断了；录制可能还在跑，刷新页面可以重新接上。' });
        busy = false;
        render();
      }
    },
  );
}

function startDemo() {
  demoSeed = (demoSeed * 1103515245 + 12345) % 2147483647;
  const events = demoEvents(state.config, demoSeed);
  dispatch({ type: 'RUN_STARTED', runId: `demo-${demoSeed}`, startedAt: new Date().toISOString() });
  cancelDemo = api.playDemo(events, handleEvent);
}

async function onStart() {
  if (busy) return;
  if (!isLocalTarget(state.config.url.trim())) {
    dispatch({ type: 'ERROR', text: `只接受本地地址（localhost / 127.0.0.1 / [::1]），拒绝：${state.config.url}` });
    return;
  }
  busy = true;
  stopStreaming();
  if (state.connection === 'live') await startLive();
  else startDemo();
  render();
}

async function onStop() {
  disarmAutoFetch();
  if (state.connection === 'live' && state.run.runId && !state.run.runId.startsWith('demo-')) {
    dispatch({ type: 'RUN_STATUS', status: 'stopping' });
    try {
      await api.stopRun(state.run.runId);
    } catch (err) {
      dispatch({ type: 'ERROR', text: `停止失败：${err.message}` });
      busy = false;
      render();
    }
    return;
  }
  stopStreaming();
  dispatch({
    type: 'SUMMARY',
    meta: { ...state.counters, mediaHints: state.mediaHints },
    hits: state.hits.map((h) => ({ ...h, count: h.count ?? 1 })),
  });
  dispatch({ type: 'END', code: 0 });
  busy = false;
  render();
}

/* ---------------- 一键获取 ---------------- */
function disarmAutoFetch() {
  if (!autoFetch) return;
  clearInterval(autoFetch.timer);
  autoFetch = null;
}

function armAutoFetch() {
  disarmAutoFetch();
  const ceiling = state.config.timeoutMs > 0 ? state.config.timeoutMs : AUTO_STOP_DEFAULTS.maxWaitMs;
  autoFetch = { startedAt: Date.now(), lastHitAt: Date.now(), timer: null, ceiling };
  autoFetch.timer = setInterval(() => {
    if (!autoFetch) return;
    if (!['starting', 'recording'].includes(state.run.status)) { disarmAutoFetch(); render(); return; }
    const resolved = state.hits.filter((h) => h.playlist).length;
    const decision = autoStopDecision({
      startedAt: autoFetch.startedAt,
      now: Date.now(),
      lastHitAt: autoFetch.lastHitAt,
      hits: state.hits.length,
      resolved,
      maxWaitMs: autoFetch.ceiling,
    });
    if (!decision) return;
    disarmAutoFetch();
    onStop().then(() => {
      toast(decision === 'timeout' ? '已到最长等待，先输出已经取到的地址' : '已取到地址并自动收尾');
    });
  }, 250);
}

async function onFetch() {
  if (busy) return;
  const url = $('hero-url').value.trim();
  dispatch({ type: 'CONFIG_SET', key: 'url', value: url });
  await onStart();
  if (state.run.status === 'error') return;
  armAutoFetch();
  render();
}

/* ---------------- rendering ---------------- */
const DETECT_LABEL = { url: 'URL', mime: 'mimeType', body: '响应体' };
const KIND_LABEL = { master: 'master', media: 'media', variant: '码流', unknown: '待解析' };

function renderHero() {
  const hero = $('hero-url');
  if (document.activeElement !== hero && hero.value !== state.config.url) hero.value = state.config.url;
  const url = state.config.url.trim();
  const bad = url !== '' && !isLocalTarget(url);
  hero.classList.toggle('invalid', bad);
  const hint = $('hero-hint');
  hint.classList.toggle('error', bad);
  hint.textContent = bad
    ? `这不是本地地址，只接受 localhost / 127.0.0.1 / [::1]：${url}`
    : '只接受 localhost / 127.0.0.1 / [::1]。取到地址并解析完会自动收尾，不用手动点停止。';

  const running = ['starting', 'recording', 'stopping'].includes(state.run.status);
  const fetch = $('btn-fetch');
  // 演示录制随时可以被新的一键获取打断；真录制一次只允许一个 run，所以那时才禁用
  const locked = busy || (state.connection === 'live' && running);
  fetch.disabled = locked;
  fetch.classList.toggle('is-busy', running);
  fetch.querySelector('.fetch-label').textContent = running ? '正在获取…' : '获取 m3u8 地址';
  $('btn-fetch-stop').hidden = !running;
}

function renderPipeline() {
  const s = state.run.status;
  const resolved = state.hits.filter((h) => h.playlist).length;
  const stage = { idle: 0, starting: 1, recording: 2, stopping: 3, finished: 4, error: -1 }[s] ?? 0;
  for (const li of $('pipeline').children) {
    const index = ['start', 'record', 'parse', 'done'].indexOf(li.dataset.step) + 1;
    li.classList.remove('active', 'done', 'failed');
    if (stage === -1) { if (index === 1) li.classList.add('failed'); continue; }
    if (index < stage || stage === 4) li.classList.add('done');
    else if (index === stage) li.classList.add('active');
    if (li.dataset.step === 'parse' && state.hits.length > 0) {
      li.querySelector('.pip-text').textContent = `解析 playlist ${resolved}/${state.hits.length}`;
    } else if (li.dataset.step === 'parse') {
      li.querySelector('.pip-text').textContent = '解析 playlist';
    }
  }
}

function copyButton(url, label) {
  const btn = el('button', {
    class: `copy-btn${copiedUrl === url ? ' copied' : ''}`, type: 'button',
    'aria-label': `复制${label}`,
    onclick: async () => {
      const ok = await copyText(url, '地址');
      if (!ok) return;
      copiedUrl = url;
      if (copiedTimer) clearTimeout(copiedTimer);
      copiedTimer = setTimeout(() => { copiedUrl = null; renderResults(); }, 1600);
      renderResults();
    },
  });
  btn.append(
    el('svg', { class: 'ico ico-copy', viewBox: '0 0 24 24', 'aria-hidden': 'true' }),
    el('svg', { class: 'ico ico-check', viewBox: '0 0 24 24', 'aria-hidden': 'true' }),
    el('span', { class: 'copy-text', text: copiedUrl === url ? '已复制' : '复制' }),
  );
  btn.querySelector('.ico-copy').innerHTML = '<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h8"/>';
  btn.querySelector('.ico-check').innerHTML = '<path d="M5 12.5l4.5 4.5L19 7.5"/>';
  return btn;
}

function renderResults() {
  const host = $('results-list');
  host.replaceChildren();
  const rows = collectAddresses(selectVisible(state));
  $('results-count').textContent = String(rows.length);
  $('btn-copy-all').disabled = rows.length === 0;
  $('btn-export-results').disabled = rows.length === 0;

  const running = ['starting', 'recording', 'stopping'].includes(state.run.status);
  if (rows.length === 0) {
    const empty = el('div', { class: 'results-empty' });
    if (running) {
      empty.append(
        el('span', { class: 'spinner big', 'aria-hidden': 'true' }),
        el('p', {}, state.run.status === 'starting' ? '正在启动探针浏览器…' : '正在录制真实请求，取到 playlist 就会出现在这里。'),
        el('p', { class: 'hint' }, '如果页面要点一下才起播，去弹出的浏览器窗口里点一下。'),
      );
    } else if (state.run.status === 'finished') {
      empty.append(
        el('p', { class: 'warn-text' }, '这次没取到 m3u8 地址。'),
        el('p', { class: 'hint' }, `录制器观察到 ${state.counters.requests} 个请求、${state.counters.responses} 个响应。下面控制台里有详细诊断。`),
      );
    } else if (state.run.status === 'error') {
      empty.append(el('p', { class: 'warn-text', text: state.run.error || '出错了，看上面的状态条。' }));
    } else {
      empty.append(
        el('p', {}, '还没有地址。填好上面的本地地址，点「获取 m3u8 地址」。'),
        el('p', { class: 'hint' }, '判定有三条腿：地址含 .m3u8、响应类型是 mpegurl、响应体以 #EXTM3U 开头。'),
      );
    }
    host.append(empty);
    return;
  }

  rows.forEach((row, i) => {
    host.append(el('div', { class: `addr-row leg-${row.from}`, style: `--i:${i}` },
      el('span', { class: `addr-kind kind-${row.kind}`, text: KIND_LABEL[row.kind] ?? row.kind }),
      el('code', { class: 'addr-url', text: row.url, title: row.url }),
      copyButton(row.url, '地址'),
    ));
  });
}

function renderConfig() {
  const c = state.config;
  const set = (id, value) => {
    const node = $(id);
    if (document.activeElement !== node && node.value !== String(value)) node.value = value;
  };
  set('cfg-url', c.url);
  set('cfg-port', c.port);
  set('cfg-exe', c.exe);
  set('cfg-profile', c.userDataDir);
  set('cfg-timeout', c.timeoutMs);
  for (const [id, key] of [['cfg-sniff', 'sniff'], ['cfg-keepopen', 'keepOpen'], ['cfg-open', 'open']]) {
    $(id).setAttribute('aria-checked', String(Boolean(c[key])));
  }

  const url = c.url.trim();
  const bad = url !== '' && !isLocalTarget(url);
  $('cfg-url').classList.toggle('invalid', bad);
  const hint = $('cfg-url-hint');
  hint.classList.toggle('error', bad);
  hint.textContent = bad
    ? `这不是本地地址，桥接会拒绝：${url}`
    : '只接受 localhost / 127.0.0.1 / [::1]。留空则开空白页，你自己在探针窗口里打开站点。';

  const portBad = !Number.isInteger(c.port) || c.port < 1 || c.port > 65535;
  $('cfg-port').classList.toggle('invalid', portBad);
}

function renderMode() {
  const badge = $('mode-badge');
  badge.classList.remove('live', 'demo', 'pending');
  if (state.connection === 'live') {
    badge.classList.add('live');
    badge.textContent = '已连接本地桥接';
  } else if (state.connection === 'demo') {
    badge.classList.add('demo');
    badge.textContent = '演示模式';
  } else {
    badge.classList.add('pending');
    badge.textContent = '检测中…';
  }
  $('demo-banner').hidden = state.connection !== 'demo';
  $('connect-banner').hidden = state.connection !== 'unknown';
  $('sound-toggle').setAttribute('aria-pressed', String(state.sound));
}

function renderStatus() {
  const node = $('status');
  node.className = `status ${state.run.status}`;
  node.replaceChildren();
  const { requests, responses, sniffed } = state.counters;
  const visible = selectVisible(state);

  const labels = {
    idle: state.connection === 'demo' ? '演示模式就绪：点「开始录制」放一份示例数据。' : '就绪：填好起始 URL，点「开始录制」。',
    starting: '正在启动探针浏览器…',
    recording: '录制中：去探针窗口里操作到视频开始播放。',
    stopping: '正在收尾：等探针解析完并关掉浏览器…',
    finished: `录制结束（退出码 ${state.run.code ?? '—'}）。`,
    error: '出错了。',
  };

  node.append(el('span', { class: 'dot', 'aria-hidden': 'true' }));
  const msg = el('span', { class: 'msg' }, labels[state.run.status] ?? '');
  node.append(msg);
  node.append(el('span', { class: 'counters' },
    el('span', {}, '请求 ', el('b', { text: requests })),
    el('span', {}, '响应 ', el('b', { text: responses })),
    el('span', {}, '嗅探 ', el('b', { text: sniffed })),
    el('span', {}, '命中 ', el('b', { text: state.hits.length })),
    el('span', {}, '显示 ', el('b', { text: visible.length })),
  ));

  if (state.run.status === 'error' && state.run.error) {
    node.append(el('span', { class: 'err-text', text: state.run.error }));
    node.append(el('button', { class: 'btn small', type: 'button', onclick: () => { dispatch({ type: 'RUN_STATUS', status: 'idle' }); } }, '知道了'));
  }

  const running = ['starting', 'recording', 'stopping'].includes(state.run.status);
  $('btn-start').disabled = running || busy;
  $('btn-stop').disabled = !running;
  $('btn-start').textContent = state.connection === 'demo' ? '开始录制（演示）' : '开始录制';

  const links = $('artifact-links');
  links.replaceChildren();
  if (state.connection === 'live' && state.run.runId && !state.run.runId.startsWith('demo-') && state.run.status === 'finished') {
    links.append(
      el('a', { class: 'link-btn', href: api.artifactUrl(state.run.runId, 'report.html'), target: '_blank', rel: 'noopener' }, 'HTML 报告'),
      document.createTextNode(' · '),
      el('a', { class: 'link-btn', href: api.artifactUrl(state.run.runId, 'hits.json'), target: '_blank', rel: 'noopener' }, '原始 JSON'),
    );
  }
}

const FILTER_GROUPS = [
  { key: 'detectedBy', label: '判定', multi: true, options: [['url', 'URL'], ['mime', 'mimeType'], ['body', '响应体']] },
  { key: 'kind', label: '类型', multi: true, options: [['master', 'master'], ['media', 'media']] },
  { key: 'encrypted', label: '加密', multi: false, options: [['any', '全部'], ['yes', '加密'], ['no', '未加密']] },
  { key: 'live', label: '直播', multi: false, options: [['any', '全部'], ['live', 'live'], ['vod', 'VOD']] },
];

function renderFilters() {
  const host = $('filters');
  host.replaceChildren();
  for (const group of FILTER_GROUPS) {
    const wrap = el('span', { class: 'chip-group', role: 'group', 'aria-label': group.label },
      el('span', { class: 'chip-label', text: group.label }));
    for (const [value, label] of group.options) {
      const pressed = group.multi ? state.filters[group.key].includes(value) : state.filters[group.key] === value;
      wrap.append(el('button', {
        class: 'chip', type: 'button', 'aria-pressed': String(pressed),
        onclick: () => dispatch({ type: 'FILTER_SET', key: group.key, value }),
      }, label));
    }
    host.append(wrap);
  }
  const q = $('q');
  if (document.activeElement !== q && q.value !== state.query) q.value = state.query;
  const key = $('sort-key');
  if (key.value !== state.sort.key) key.value = state.sort.key;
  $('sort-dir').textContent = state.sort.dir === 'desc' ? '↓' : '↑';
  $('sort-dir').title = state.sort.dir === 'desc' ? '当前降序，点击改升序' : '当前升序，点击改降序';
}

function renderViews() {
  const select = $('view-select');
  const current = select.value;
  select.replaceChildren(el('option', { value: '' }, '已保存视图…'));
  for (const view of state.views) select.append(el('option', { value: view.id, text: view.name }));
  if (state.views.some((v) => v.id === current)) select.value = current;
  $('btn-view-delete').disabled = !select.value;
}

function renderBulk() {
  const bar = $('bulkbar');
  const n = state.selected.length;
  bar.hidden = n === 0;
  $('bulk-count').textContent = `已选 ${n} 条`;
}

function playlistFacts(hit) {
  const p = hit.playlist;
  if (!p) return [el('span', { class: 'skeleton', 'aria-label': '解析中' })];
  if (!p.valid) return [el('span', { class: 'warn-text', text: '响应体不是 m3u8' })];
  const facts = [];
  if (p.kind === 'master') facts.push(el('span', {}, '码流 ', el('b', { text: p.variants.length })));
  else {
    facts.push(el('span', {}, '分片 ', el('b', { text: p.segments })));
    facts.push(el('span', {}, '时长 ', el('b', { text: `${p.totalDuration.toFixed(1)}s` })));
  }
  if (p.encrypted) facts.push(el('span', {}, '密钥 ', el('b', { text: p.keys.length })));
  return facts;
}

function bitrateLadder(p, compact) {
  const variants = p.variants.filter((v) => typeof v.bandwidth === 'number' && v.bandwidth > 0);
  if (variants.length === 0) return null;
  const max = Math.max(...variants.map((v) => v.bandwidth));
  const ladder = el('div', {
    class: `ladder${compact ? ' compact' : ''}`,
    role: 'img',
    'aria-label': `码流阶梯：${variants.map((v) => `${v.resolution ?? '未知分辨率'} ${(v.bandwidth / 1e6).toFixed(2)} Mbps`).join('，')}`,
  });
  variants.forEach((v, i) => {
    ladder.append(el('div', { class: 'rung' },
      el('span', { class: 'rung-label', text: v.resolution ?? `变体 ${i + 1}` }),
      el('span', { class: 'rung-track' },
        el('span', { class: 'rung-bar', style: `width:${Math.max(4, Math.round((v.bandwidth / max) * 100))}%` })),
      el('span', { class: 'rung-value', text: `${(v.bandwidth / 1e6).toFixed(2)} Mbps` }),
    ));
  });
  return ladder;
}

function segmentStrip(p) {
  if (p.kind !== 'media' || p.segments <= 0) return null;
  const shown = Math.min(p.segments, 48);
  const strip = el('div', {
    class: `strip${p.live ? ' live' : ''}${p.encrypted ? ' enc' : ''}`,
    role: 'img',
    'aria-label': `分片时间轴：${p.segments} 个分片，${p.live ? '直播' : '点播'}${p.encrypted ? '，已加密' : ''}`,
  });
  for (let i = 0; i < shown; i += 1) strip.append(el('span', { class: 'tick' }));
  if (p.segments > shown) strip.append(el('span', { class: 'more', text: `+${p.segments - shown}` }));
  return strip;
}

function renderHits() {
  const host = $('hits');
  host.replaceChildren();
  const visible = selectVisible(state);

  if (state.hits.length === 0) {
    if (state.run.status === 'finished' || state.run.status === 'error') {
      host.append(zeroHitPanel());
    } else {
      host.append(el('div', { class: 'empty' },
        el('h3', {}, '还没有命中'),
        el('p', {}, state.connection === 'demo'
          ? '这是演示模式。点「开始录制」会按当前配置生成一份示例录制，每个开关都能看出差别。'
          : '点「开始录制」，在弹出的独立 profile 浏览器窗口里操作到视频开始播放，命中会实时出现在这里。'),
        el('p', {}, '判定有三条腿：地址含 .m3u8、响应类型是 mpegurl、响应体以 #EXTM3U 开头。'),
        el('button', { class: 'btn primary', type: 'button', onclick: onStart }, '开始录制'),
      ));
    }
    return;
  }

  if (visible.length === 0) {
    host.append(el('div', { class: 'empty' },
      el('h3', {}, '没有匹配的命中'),
      el('p', {}, `一共录到 ${state.hits.length} 条，但当前搜索和筛选把它们都挡住了。`),
      el('button', {
        class: 'btn', type: 'button',
        onclick: () => {
          dispatch({ type: 'QUERY_SET', text: '' });
          dispatch({ type: 'FILTER_SET', key: 'detectedBy', value: [] });
          dispatch({ type: 'FILTER_SET', key: 'kind', value: [] });
          dispatch({ type: 'FILTER_SET', key: 'encrypted', value: 'any' });
          dispatch({ type: 'FILTER_SET', key: 'live', value: 'any' });
        },
      }, '清除搜索和筛选'),
    ));
    return;
  }

  for (const hit of visible) host.append(renderCard(hit));
}

function zeroHitPanel() {
  const wrap = el('div', { class: 'empty' },
    el('h3', {}, '没有命中任何 m3u8'),
    el('p', {}, `录制器确实在工作：观察到 ${state.counters.requests} 个请求、${state.counters.responses} 个响应、${state.counters.sniffed} 次嗅探。`));
  if (state.counters.requests === 0) {
    wrap.append(el('p', { class: 'warn-text', text: '请求数为 0：浏览器根本没走网络，检查起始 URL 是否真的加载了页面。' }));
  } else if (state.mediaHints.length > 0) {
    const diag = el('div', { class: 'diagnosis' },
      el('h3', {}, '但看到了这些媒体请求'),
      el('p', {}, '播放器在取流，playlist 可能走了别的形状（比如 DASH 的 .mpd，或者藏在 POST 响应里）：'));
    diag.append(el('ul', {}, state.mediaHints.map((u) => el('li', { text: u }))));
    wrap.append(diag);
  } else {
    wrap.append(el('p', {}, '页面可能还没开始播放。重新录一次，操作到视频真的出画面再停止。'));
  }
  wrap.append(el('button', { class: 'btn primary', type: 'button', onclick: onStart }, '再录一次'));
  return wrap;
}

function renderCard(hit) {
  const selected = state.selected.includes(hit.id);
  const card = el('article', {
    class: `card${selected ? ' selected' : ''}${hit.playlist ? '' : ' pending'}`,
    'data-id': hit.id,
    'data-leg': hit.detectedBy,
    ondragover: (e) => onDragOver(e, hit.id),
    ondragleave: (e) => e.currentTarget.classList.remove('drop-before', 'drop-after'),
    ondrop: (e) => onDrop(e, hit.id),
  });

  card.append(el('button', {
    class: 'handle', type: 'button', draggable: 'true', title: '拖动排序', 'aria-label': `拖动排序：${hit.url}`,
    ondragstart: (e) => onDragStart(e, hit.id),
    ondragend: (e) => onDragEnd(e),
  }, '⠿'));

  card.append(el('input', {
    type: 'checkbox', checked: selected, 'aria-label': `选择 ${hit.url}`,
    onchange: () => dispatch({ type: 'SELECT_TOGGLE', id: hit.id }),
  }));

  const badges = el('span', { class: 'card-meta' },
    el('span', { class: `badge ${hit.detectedBy}`, text: DETECT_LABEL[hit.detectedBy] ?? hit.detectedBy }),
    el('span', { class: 'badge', text: `HTTP ${hit.status ?? '—'}` }),
    hit.mimeType ? el('span', { class: 'badge', text: hit.mimeType }) : null,
    (hit.count ?? 1) > 1 ? el('span', { class: 'badge count', text: `×${hit.count}` }) : null,
    hit.playlist?.encrypted ? el('span', { class: 'badge enc', text: '加密' }) : null,
    hit.playlist?.live ? el('span', { class: 'badge live', text: 'live' }) : null,
  );

  const main = el('div', { class: 'card-main' },
    el('p', { class: 'card-url', text: hit.url }),
    badges,
    el('div', { class: 'card-facts' },
      el('span', {}, '发起者 ', el('b', { text: hit.initiator || '—' })),
      ...playlistFacts(hit),
    ),
    hit.playlist?.valid ? bitrateLadder(hit.playlist, true) : null,
    hit.playlist?.valid ? segmentStrip(hit.playlist) : null,
  );
  card.append(main);

  card.append(el('div', { class: 'card-actions' },
    el('button', { class: 'btn small', type: 'button', onclick: () => openDrawer(hit.id) }, '详情'),
    el('button', { class: 'btn small', type: 'button', onclick: () => copyText(hit.url, '地址') }, '复制'),
    el('button', {
      class: 'btn small danger', type: 'button', title: '删除（可撤销）',
      onclick: () => { dispatch({ type: 'DELETE', ids: [hit.id] }); toast('已删除 1 条命中', true); },
    }, '✕'),
  ));
  return card;
}

/* ---------------- drag & drop ---------------- */
function onDragStart(e, id) {
  dragId = id;
  e.dataTransfer.effectAllowed = 'move';
  e.dataTransfer.setData('text/plain', id);
  e.currentTarget.closest('.card')?.classList.add('dragging');
}

function onDragEnd(e) {
  dragId = null;
  e.currentTarget.closest('.card')?.classList.remove('dragging');
  for (const node of document.querySelectorAll('.card')) node.classList.remove('drop-before', 'drop-after');
}

function onDragOver(e, id) {
  if (!dragId || dragId === id) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';
  const card = e.currentTarget;
  const box = card.getBoundingClientRect();
  const after = e.clientY > box.top + box.height / 2;
  card.classList.toggle('drop-after', after);
  card.classList.toggle('drop-before', !after);
}

function onDrop(e, id) {
  if (!dragId || dragId === id) return;
  e.preventDefault();
  const box = e.currentTarget.getBoundingClientRect();
  const after = e.clientY > box.top + box.height / 2;
  const ids = selectVisible(state).map((h) => h.id);
  dispatch({ type: 'REORDER', ids: reorderIds(ids, dragId, id, after) });
  onDragEnd(e);
  toast('已按手动顺序排列');
}

/* ---------------- drawer ---------------- */
function openDrawer(id) {
  drawerId = id;
  renderDrawer();
  $('drawer').hidden = false;
  $('drawer-scrim').hidden = false;
  $('drawer-close').focus();
}

function closeDrawer() {
  drawerId = null;
  $('drawer').hidden = true;
  $('drawer-scrim').hidden = true;
}

function factTable(rows) {
  return el('table', { class: 'facts' }, el('tbody', {}, rows.map(([k, v]) =>
    el('tr', {}, el('th', { text: k }), el('td', {}, v)))));
}

function renderDrawer() {
  const body = $('drawer-body');
  body.replaceChildren();
  const hit = state.hits.find((h) => h.id === drawerId);
  if (!hit) {
    body.append(el('p', { class: 'warn-text', text: '这条命中已经被删除或不存在了。' }));
    $('drawer-title').textContent = '命中详情';
    return;
  }
  $('drawer-title').textContent = `命中详情 · ${DETECT_LABEL[hit.detectedBy] ?? hit.detectedBy}`;

  body.append(el('h3', {}, '地址'));
  body.append(el('p', { class: 'url-block', text: hit.url }));
  body.append(el('div', { class: 'copy-row' },
    el('button', { class: 'btn small', type: 'button', onclick: () => copyText(hit.url, '地址') }, '复制地址'),
    el('button', {
      class: 'btn small', type: 'button',
      onclick: () => copyText(`curl -L '${hit.url.replace(/'/g, "'\\''")}'`, 'curl 命令'),
    }, '复制 curl'),
  ));

  const refetch = hit.refetch
    ? hit.refetch.ok
      ? `成功 HTTP ${hit.refetch.status}${hit.refetch.finalUrl && hit.refetch.finalUrl !== hit.url ? ` → ${hit.refetch.finalUrl}` : ''}`
      : `失败：${hit.refetch.error ?? `HTTP ${hit.refetch.status}`}`
    : '还没复取';
  body.append(el('h3', {}, '录制与复取'));
  body.append(factTable([
    ['判定依据', DETECT_LABEL[hit.detectedBy] ?? hit.detectedBy],
    ['发起者', hit.initiator || '—'],
    ['录制状态', `${hit.status ?? '—'} ${hit.mimeType || '未知类型'}`],
    ['出现次数', String(hit.count ?? 1)],
    ['复取', refetch + (hit.refetch?.usedRecordedBody ? '（改用录制到的响应体）' : '')],
  ]));

  const p = hit.playlist;
  body.append(el('h3', {}, 'playlist'));
  if (!p) {
    body.append(el('p', { class: 'warn-text', text: '正在复取并解析…如果一直停在这里，说明复取失败且没录到响应体。' }));
  } else if (!p.valid) {
    body.append(el('p', { class: 'warn-text', text: '响应体不是 m3u8（不以 #EXTM3U 开头）。' }));
  } else {
    body.append(factTable([
      ['类型', p.kind === 'master' ? 'master（码流清单）' : `media（${p.live ? 'live' : 'VOD'}）`],
      ['版本', p.version ?? '—'],
      ['分片数', String(p.segments)],
      ['总时长', `${p.totalDuration.toFixed(3)} s`],
      ['TARGETDURATION', p.targetDuration === null ? '—' : String(p.targetDuration)],
      ['EXT-X-MAP', p.map ? p.map.url : '无'],
    ]));
    const strip = segmentStrip(p);
    if (strip) body.append(strip);

    if (p.variants.length > 0) {
      body.append(el('h3', {}, `码流 ${p.variants.length} 条`));
      const ladder = bitrateLadder(p, false);
      if (ladder) body.append(ladder);
      const head = el('thead', {}, el('tr', {},
        ['BANDWIDTH', 'RESOLUTION', 'CODECS', '地址'].map((h) => el('th', { text: h }))));
      const rows = p.variants.map((v) => el('tr', {},
        el('td', { text: v.bandwidth ?? '—' }),
        el('td', { text: v.resolution ?? '—' }),
        el('td', { text: v.codecs ?? '—' }),
        el('td', { class: 'url' },
          el('button', { class: 'link-btn', type: 'button', onclick: () => copyText(v.url, '码流地址') }, v.url))));
      const table = el('table', { class: 'variants' }, head, el('tbody', {}, rows));
      body.append(table);
      body.append(el('div', { class: 'copy-row' },
        el('button', {
          class: 'btn small', type: 'button',
          onclick: () => copyText(p.variants.map((v) => v.url).join('\n'), `${p.variants.length} 条码流地址`),
        }, '复制全部码流地址')));
    }

    if (p.keys.length > 0) {
      body.append(el('h3', {}, `加密密钥 ${p.keys.length} 个`));
      body.append(factTable(p.keys.map((k, i) => [
        `#${i + 1} ${k.method}`,
        el('span', {}, el('span', { class: 'url', text: k.url ?? k.uri ?? '(无 URI)' }),
          k.iv ? el('span', { text: `  IV=${k.iv}` }) : null),
      ])));
    }

    if (p.firstSegmentUrl) {
      body.append(el('h3', {}, '首个分片'));
      body.append(el('p', { class: 'url-block', text: p.firstSegmentUrl }));
    }
    for (const w of p.warnings ?? []) body.append(el('p', { class: 'warn-text', text: `警告：${w}` }));
  }
}

/* ---------------- log ---------------- */
function renderLog() {
  const host = $('log');
  host.replaceChildren();
  for (const entry of state.log.slice(-120)) {
    host.append(el('div', { class: entry.text.startsWith('嗅探出错') || entry.text.includes('失败') ? 'err' : '', text: entry.text }));
  }
  host.scrollTop = host.scrollHeight;
}

function render() {
  renderMode();
  renderHero();
  renderPipeline();
  renderConfig();
  renderStatus();
  renderResults();
  renderFilters();
  renderViews();
  renderBulk();
  renderHits();
  renderLog();
  if (drawerId) renderDrawer();
}

/* ---------------- wiring ---------------- */
function bindCapture() {
  $('capture-form').addEventListener('submit', (e) => { e.preventDefault(); onFetch(); });
  $('hero-url').addEventListener('input', (e) => dispatch({ type: 'CONFIG_SET', key: 'url', value: e.target.value }));
  $('btn-fetch-stop').addEventListener('click', () => { disarmAutoFetch(); onStop(); });
  $('btn-copy-all').addEventListener('click', () => {
    const rows = collectAddresses(selectVisible(state));
    copyText(rows.map((r) => r.url).join('\n'), `${rows.length} 条地址`);
  });
  $('btn-export-results').addEventListener('click', () => {
    const rows = collectAddresses(selectVisible(state));
    download('m3u8-addresses.txt', rows.map((r) => r.url).join('\n') + '\n', 'text/plain');
  });
}

function bindConfig() {
  const text = (id, key) => $(id).addEventListener('input', (e) => dispatch({ type: 'CONFIG_SET', key, value: e.target.value }));
  const num = (id, key) => $(id).addEventListener('input', (e) => {
    const n = Number(e.target.value);
    dispatch({ type: 'CONFIG_SET', key, value: Number.isFinite(n) ? n : 0 });
  });
  text('cfg-url', 'url');
  num('cfg-port', 'port');
  text('cfg-exe', 'exe');
  text('cfg-profile', 'userDataDir');
  num('cfg-timeout', 'timeoutMs');
  for (const [id, key] of [['cfg-sniff', 'sniff'], ['cfg-keepopen', 'keepOpen'], ['cfg-open', 'open']]) {
    $(id).addEventListener('click', () => dispatch({ type: 'CONFIG_SET', key, value: !state.config[key] }));
  }
}

function bindToolbar() {
  $('q').addEventListener('input', (e) => dispatch({ type: 'QUERY_SET', text: e.target.value }));
  $('sort-key').addEventListener('change', (e) => dispatch({ type: 'SORT_SET', key: e.target.value, dir: state.sort.dir }));
  $('sort-dir').addEventListener('click', () => dispatch({ type: 'SORT_SET', key: state.sort.key, dir: state.sort.dir === 'asc' ? 'desc' : 'asc' }));

  $('btn-view-save').addEventListener('click', () => {
    const name = window.prompt('给当前搜索 + 筛选 + 排序起个名字：', `视图 ${state.views.length + 1}`);
    if (name === null) return;
    if (name.trim() === '') { toast('名字不能为空'); return; }
    dispatch({ type: 'VIEW_SAVE', name });
    toast(`已保存视图「${name.trim()}」`);
  });
  $('view-select').addEventListener('change', (e) => {
    if (e.target.value) dispatch({ type: 'VIEW_APPLY', id: e.target.value });
    $('btn-view-delete').disabled = !e.target.value;
  });
  $('btn-view-delete').addEventListener('click', () => {
    const id = $('view-select').value;
    if (!id) return;
    dispatch({ type: 'VIEW_DELETE', id });
    toast('已删除视图');
  });

  $('btn-select-visible').addEventListener('click', () => dispatch({ type: 'SELECT_VISIBLE' }));
  $('btn-select-none').addEventListener('click', () => dispatch({ type: 'SELECT_NONE' }));
  $('btn-copy-selected').addEventListener('click', () => {
    const hits = state.hits.filter((h) => state.selected.includes(h.id));
    copyText(exportAddresses(hits), `${hits.length} 条地址`);
  });
  $('btn-export-selected').addEventListener('click', () => {
    const hits = state.hits.filter((h) => state.selected.includes(h.id));
    download('m3u8-selected.json', exportJson(state, hits), 'application/json');
  });
  $('btn-delete-selected').addEventListener('click', () => {
    const n = state.selected.length;
    dispatch({ type: 'DELETE', ids: [...state.selected] });
    toast(`已删除 ${n} 条命中`, true);
  });
}

function bindActions() {
  $('btn-start').addEventListener('click', onStart);
  $('btn-stop').addEventListener('click', onStop);
  $('btn-reset').addEventListener('click', () => {
    dispatch({ type: 'CONFIG_RESET' });
    toast('配置已恢复默认');
  });
  $('btn-random').addEventListener('click', () => {
    const ports = [3000, 5173, 8080, 4200, 53100];
    const port = ports[Math.floor(Math.random() * ports.length)];
    dispatch({ type: 'CONFIG_SET', key: 'url', value: `http://localhost:${port}/` });
    dispatch({ type: 'CONFIG_SET', key: 'port', value: 9222 + Math.floor(Math.random() * 400) });
    dispatch({ type: 'CONFIG_SET', key: 'sniff', value: Math.random() > 0.3 });
    dispatch({ type: 'CONFIG_SET', key: 'timeoutMs', value: [0, 15000, 30000][Math.floor(Math.random() * 3)] });
    stopStreaming();
    busy = true;
    startDemo();
    busy = false;
    render();
    toast('已随机生成一份示例配置和示例录制');
  });
  $('btn-export-json').addEventListener('click', () => download('m3u8-probe.json', exportJson(state, selectVisible(state)), 'application/json'));
  $('btn-export-csv').addEventListener('click', () => download('m3u8-probe.csv', exportCsv(selectVisible(state)), 'text/csv'));
  $('btn-export-urls').addEventListener('click', () => copyText(exportAddresses(selectVisible(state)), `${selectVisible(state).length} 条地址`));
  $('btn-clear').addEventListener('click', () => {
    if (state.hits.length === 0) { toast('列表已经是空的'); return; }
    const n = state.hits.length;
    dispatch({ type: 'CLEAR' });
    toast(`已清空 ${n} 条命中`, true);
  });

  $('toast-undo').addEventListener('click', () => {
    dispatch({ type: 'UNDO' });
    $('toast').hidden = true;
    toast('已撤销');
  });
  $('toast-close').addEventListener('click', () => { $('toast').hidden = true; });

  $('sound-toggle').addEventListener('click', () => {
    dispatch({ type: 'SOUND_SET', value: !state.sound });
    if (state.sound) blip();
    toast(state.sound ? '命中提示音已打开' : '命中提示音已关闭');
  });

  $('btn-log-toggle').addEventListener('click', () => {
    const log = $('log');
    log.hidden = !log.hidden;
    $('btn-log-toggle').textContent = log.hidden ? '展开' : '收起';
    $('btn-log-toggle').setAttribute('aria-expanded', String(!log.hidden));
  });

  $('drawer-close').addEventListener('click', closeDrawer);
  $('drawer-scrim').addEventListener('click', closeDrawer);
  $('btn-help').addEventListener('click', () => { $('help').hidden = false; $('help-scrim').hidden = false; $('help-close').focus(); });
  $('help-close').addEventListener('click', () => { $('help').hidden = true; $('help-scrim').hidden = true; });
  $('help-scrim').addEventListener('click', () => { $('help').hidden = true; $('help-scrim').hidden = true; });

  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (!$('help').hidden) { $('help').hidden = true; $('help-scrim').hidden = true; return; }
    if (!$('drawer').hidden) closeDrawer();
  });

  window.addEventListener('beforeunload', stopStreaming);
}

/* ---------------- boot ---------------- */
async function boot() {
  bindCapture();
  bindConfig();
  bindToolbar();
  bindActions();
  render();

  const health = await api.detectBridge(location.href);
  if (health) {
    dispatch({ type: 'CONNECTION_SET', mode: 'live' });
    const list = $('browser-candidates');
    list.replaceChildren(...(health.browsers ?? []).map((b) => el('option', { value: b })));
    const active = await api.getActive();
    if (active.runId) {
      dispatch({ type: 'RUN_STARTED', runId: active.runId, startedAt: active.startedAt });
      busy = true;
      closeEvents = api.openEvents(active.runId, handleEvent, () => {});
      render();
    }
    return;
  }

  dispatch({ type: 'CONNECTION_SET', mode: 'demo' });
  busy = true;
  startDemo();
  busy = false;
  render();
}

m3u8ui.app = true; boot();
})();
})();
