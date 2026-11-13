export const DEFAULT_CONFIG = {
  url: '',
  port: 9222,
  exe: '',
  userDataDir: '',
  sniff: true,
  timeoutMs: 0,
  open: false,
  keepOpen: false,
  dlDir: '',
  dlHeaders: '',
  dlExe: '',
};

const LOG_LIMIT = 300;
const UNDO_LIMIT = 20;
const ARRAY_FILTERS = new Set(['detectedBy', 'kind']);
const SORT_KEYS = new Set(['time', 'bandwidth', 'segments', 'url', 'manual']);

export function initialState() {
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
    // 下载任务是运行时状态：不持久化、不进导出，刷新后由 GET /api/downloads 恢复
    downloads: [],
    downloader: { exe: null, saveDir: null, missing: false },
  };
}

export function toRunRequest(config) {
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

export function selectVisible(state) {
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

export function reorderIds(ids, dragId, targetId, after = false) {
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

export function reduce(state, action) {
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

    // 下载任务：一条事件就地合并，未知 id 忽略（晚到的 SSE 帧可能属于已被清除的任务）
    case 'DOWNLOADS_SET':
      return { ...state, downloads: [...action.downloads] };

    case 'DOWNLOADER_SET':
      return { ...state, downloader: { ...state.downloader, ...action.info } };

    case 'DL_UPDATE': {
      const rest = state.downloads.filter((d) => d.id !== action.download.id);
      return { ...state, downloads: [...rest, action.download] };
    }

    case 'DL_REMOVE':
      return { ...state, downloads: state.downloads.filter((d) => d.id !== action.id) };

    case 'DL_CLEAR_DONE':
      return { ...state, downloads: state.downloads.filter((d) => d.status === 'running') };

    default:
      return state;
  }
}

export function serialize(state) {
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

export function hydrate(saved) {
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