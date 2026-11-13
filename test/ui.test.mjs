import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_CONFIG,
  initialState,
  reduce,
  selectVisible,
  toRunRequest,
  serialize,
  hydrate,
  reorderIds,
} from '../ui/store.js';
import { seededRandom, demoEvents } from '../ui/demo.js';
import { playDemo, detectBridge } from '../ui/api.js';
import { autoStopDecision, collectAddresses } from '../ui/autostop.js';
import { canReachBridge } from '../ui/local-target.js';
import { exportJson, exportCsv, exportAddresses } from '../ui/export.js';

function hit(overrides = {}) {
  return {
    url: 'http://127.0.0.1:53100/hls/master.m3u8',
    status: 200,
    mimeType: 'application/vnd.apple.mpegurl',
    initiator: 'player.js:5 loadStream',
    detectedBy: 'url',
    refetch: null,
    playlist: null,
    ...overrides,
  };
}

function masterPlaylist(variants) {
  return {
    valid: true,
    kind: 'master',
    live: false,
    segments: 0,
    totalDuration: 0,
    encrypted: false,
    keys: [],
    map: null,
    warnings: [],
    variants,
  };
}

function mediaPlaylist(overrides = {}) {
  return {
    valid: true,
    kind: 'media',
    live: false,
    segments: 2,
    totalDuration: 12,
    encrypted: false,
    keys: [],
    map: null,
    warnings: [],
    variants: [],
    ...overrides,
  };
}

function run(state, ...actions) {
  return actions.reduce((s, a) => reduce(s, a), state);
}

test('initialState: every list control has a defined starting value', () => {
  const s = initialState();
  assert.deepEqual(s.hits, []);
  assert.deepEqual(s.selected, []);
  assert.equal(s.query, '');
  assert.deepEqual(s.filters, { detectedBy: [], kind: [], encrypted: 'any', live: 'any' });
  assert.deepEqual(s.sort, { key: 'time', dir: 'asc' });
  assert.equal(s.run.status, 'idle');
  assert.equal(s.connection, 'unknown');
  assert.deepEqual(s.undo, []);
  assert.deepEqual(s.views, []);
});

test('reduce: does not mutate the previous state', () => {
  const s = initialState();
  const frozen = JSON.stringify(s);
  reduce(s, { type: 'HIT', hit: hit() });
  assert.equal(JSON.stringify(s), frozen);
});

// break: the card only appearing after the re-fetch, so a slow playlist looks like a dead recorder
test('HIT: the card exists immediately and RESOLVED fills the same card', () => {
  let s = reduce(initialState(), { type: 'HIT', hit: hit() });
  assert.equal(s.hits.length, 1);
  assert.equal(s.hits[0].playlist, null, 'the optimistic card must not invent a playlist');
  assert.ok(s.hits[0].id, 'a hit needs a stable local id');
  const id = s.hits[0].id;

  s = reduce(s, { type: 'RESOLVED', hit: hit({ playlist: masterPlaylist([]), refetch: { ok: true, status: 200 } }) });
  assert.equal(s.hits.length, 1, 'resolution created a second card');
  assert.equal(s.hits[0].id, id, 'resolution replaced the card identity');
  assert.equal(s.hits[0].playlist.kind, 'master');
  assert.equal(s.hits[0].refetch.ok, true);
});

test('HIT: the same URL twice collapses to one card with a count', () => {
  const s = run(initialState(), { type: 'HIT', hit: hit() }, { type: 'HIT', hit: hit() });
  assert.equal(s.hits.length, 1);
  assert.equal(s.hits[0].count, 2);
});

test('RESOLVED: an unknown URL is ignored rather than creating a phantom card', () => {
  const s = run(initialState(), { type: 'RESOLVED', hit: hit({ url: 'http://127.0.0.1:1/never-seen.m3u8' }) });
  assert.equal(s.hits.length, 0);
});

test('SUMMARY: replaces counters and merges the deduped final hits', () => {
  let s = run(initialState(), { type: 'HIT', hit: hit() });
  s = reduce(s, {
    type: 'SUMMARY',
    meta: { requests: 174, responses: 172, sniffed: 34, mediaHints: ['http://127.0.0.1:53100/hls/seg0.ts'] },
    hits: [{ ...hit(), count: 3, playlist: mediaPlaylist() }],
  });
  assert.deepEqual(s.counters, { requests: 174, responses: 172, sniffed: 34 });
  assert.deepEqual(s.mediaHints, ['http://127.0.0.1:53100/hls/seg0.ts']);
  assert.equal(s.hits.length, 1);
  assert.equal(s.hits[0].count, 3);
  assert.equal(s.hits[0].playlist.segments, 2);
});

// break: a zero-hit run looking identical to a recorder that never ran
test('SUMMARY: zero hits keeps the observation counters and the media hints', () => {
  const s = reduce(initialState(), {
    type: 'SUMMARY',
    meta: { requests: 12, responses: 12, sniffed: 0, mediaHints: ['http://127.0.0.1:53100/seg0.ts'] },
    hits: [],
  });
  assert.equal(s.hits.length, 0);
  assert.equal(s.counters.requests, 12);
  assert.equal(s.mediaHints.length, 1);
});

// break: the status bar reading 请求 0 for the whole capture because counters only arrive with the summary
test('PROGRESS: updates the live counters without disturbing hits or run status', () => {
  let s = run(initialState(), { type: 'RUN_STARTED', runId: 'r1', startedAt: '2026-11-12T00:00:00Z' }, { type: 'HIT', hit: hit() });
  s = reduce(s, { type: 'PROGRESS', requests: 41, responses: 38, sniffed: 6 });
  assert.deepEqual(s.counters, { requests: 41, responses: 38, sniffed: 6 });
  assert.equal(s.hits.length, 1);
  assert.equal(s.run.status, 'recording');
});

// break: a stale ticker frame rewinding the authoritative final counts
test('PROGRESS: never lowers a counter the summary already settled', () => {
  let s = reduce(initialState(), {
    type: 'SUMMARY', meta: { requests: 174, responses: 172, sniffed: 34 }, hits: [],
  });
  s = reduce(s, { type: 'PROGRESS', requests: 90, responses: 88, sniffed: 10 });
  assert.deepEqual(s.counters, { requests: 174, responses: 172, sniffed: 34 });
});

test('run lifecycle: starting, recording, stopping, finished, error', () => {
  let s = reduce(initialState(), { type: 'RUN_STARTED', runId: 'r1', startedAt: '2026-11-12T00:00:00Z' });
  assert.equal(s.run.status, 'recording');
  assert.equal(s.run.runId, 'r1');
  s = reduce(s, { type: 'RUN_STATUS', status: 'stopping' });
  assert.equal(s.run.status, 'stopping');
  s = reduce(s, { type: 'END', code: 0 });
  assert.equal(s.run.status, 'finished');
  assert.equal(s.run.code, 0);
  s = reduce(s, { type: 'ERROR', text: '端口被占用' });
  assert.equal(s.run.status, 'error');
  assert.equal(s.run.error, '端口被占用');
});

test('RUN_STARTED: clears the previous capture so two runs never interleave', () => {
  let s = run(initialState(), { type: 'HIT', hit: hit() }, { type: 'LOG', text: 'old' });
  s = reduce(s, { type: 'RUN_STARTED', runId: 'r2', startedAt: 'now' });
  assert.deepEqual(s.hits, []);
  assert.deepEqual(s.log, []);
  assert.deepEqual(s.selected, []);
  assert.deepEqual(s.counters, { requests: 0, responses: 0, sniffed: 0 });
});

test('CONFIG_SET: changes one field and leaves the rest alone', () => {
  const s = reduce(initialState(), { type: 'CONFIG_SET', key: 'port', value: 9333 });
  assert.equal(s.config.port, 9333);
  assert.equal(s.config.sniff, DEFAULT_CONFIG.sniff);
});

test('CONFIG_RESET: restores defaults', () => {
  let s = run(initialState(), { type: 'CONFIG_SET', key: 'port', value: 9333 }, { type: 'CONFIG_SET', key: 'sniff', value: false });
  s = reduce(s, { type: 'CONFIG_RESET' });
  assert.deepEqual(s.config, DEFAULT_CONFIG);
});

// break: an empty text box being sent as "" and rejected by the bridge as a non-empty-string violation
test('toRunRequest: empty text fields become null, not empty strings', () => {
  const body = toRunRequest({ ...DEFAULT_CONFIG, url: '', exe: '', userDataDir: '' });
  assert.equal(body.url, null);
  assert.equal(body.exe, null);
  assert.equal(body.userDataDir, null);
  assert.equal(body.port, DEFAULT_CONFIG.port);
  assert.equal(typeof body.sniff, 'boolean');
});

test('toRunRequest: carries every control the bridge accepts and nothing else', () => {
  const body = toRunRequest({
    url: 'http://localhost:5173/', port: 9333, exe: 'C:/Edge/msedge.exe', userDataDir: 'C:/tmp/p',
    sniff: false, timeoutMs: 15000, open: true, keepOpen: true,
  });
  assert.deepEqual(body, {
    url: 'http://localhost:5173/', port: 9333, exe: 'C:/Edge/msedge.exe', userDataDir: 'C:/tmp/p',
    sniff: false, timeoutMs: 15000, open: true, keepOpen: true,
  });
});

function seeded() {
  // 探针的 resolved 事件带的是同一个完整 hit，所以夹具也必须带全字段
  const master = hit({ url: 'http://127.0.0.1:53100/hls/master.m3u8', detectedBy: 'url' });
  const inline = hit({ url: 'http://127.0.0.1:53100/api/inline', detectedBy: 'body', mimeType: 'text/plain', initiator: 'p.js:5' });
  const edge = hit({ url: 'http://127.0.0.1:53100/live/edge.m3u8', detectedBy: 'mime' });
  return run(
    initialState(),
    { type: 'HIT', hit: master },
    { type: 'RESOLVED', hit: { ...master, playlist: masterPlaylist([
      { bandwidth: 800000, resolution: '640x360', codecs: 'avc1.42c01e', url: 'http://127.0.0.1:53100/hls/360.m3u8' },
      { bandwidth: 1600000, resolution: '1280x720', codecs: 'avc1.4d401f,mp4a.40.2', url: 'http://127.0.0.1:53100/hls/720.m3u8' },
    ]) } },
    { type: 'HIT', hit: inline },
    { type: 'RESOLVED', hit: { ...inline, playlist: mediaPlaylist({ encrypted: true, keys: [{ method: 'AES-128', url: 'http://127.0.0.1:53100/api/enc.key' }] }) } },
    { type: 'HIT', hit: edge },
    { type: 'RESOLVED', hit: { ...edge, playlist: mediaPlaylist({ live: true, segments: 6 }) } },
  );
}

test('selectVisible: no query and no filters returns everything in arrival order', () => {
  const s = seeded();
  assert.deepEqual(selectVisible(s).map((h) => h.url), [
    'http://127.0.0.1:53100/hls/master.m3u8',
    'http://127.0.0.1:53100/api/inline',
    'http://127.0.0.1:53100/live/edge.m3u8',
  ]);
});

test('selectVisible: query matches url, initiator and variant addresses, case-insensitively', () => {
  const s = seeded();
  assert.equal(selectVisible({ ...s, query: 'INLINE' }).length, 1);
  assert.equal(selectVisible({ ...s, query: 'p.js:5' }).length, 1);
  assert.equal(selectVisible({ ...s, query: '720.m3u8' }).length, 1, 'a variant address must be searchable');
  assert.equal(selectVisible({ ...s, query: 'enc.key' }).length, 1, 'a key address must be searchable');
  assert.equal(selectVisible({ ...s, query: 'nothing-matches-this' }).length, 0);
});

test('selectVisible: filters combine, and an empty filter array means all', () => {
  const s = seeded();
  assert.equal(selectVisible({ ...s, filters: { ...s.filters, detectedBy: ['body'] } }).length, 1);
  assert.equal(selectVisible({ ...s, filters: { ...s.filters, detectedBy: ['url', 'mime'] } }).length, 2);
  assert.equal(selectVisible({ ...s, filters: { ...s.filters, detectedBy: [] } }).length, 3);
  assert.equal(selectVisible({ ...s, filters: { ...s.filters, kind: ['master'] } }).length, 1);
  assert.equal(selectVisible({ ...s, filters: { ...s.filters, encrypted: 'yes' } }).length, 1);
  assert.equal(selectVisible({ ...s, filters: { ...s.filters, encrypted: 'no' } }).length, 2);
  assert.equal(selectVisible({ ...s, filters: { ...s.filters, live: 'live' } }).length, 1);
  assert.equal(selectVisible({ ...s, filters: { ...s.filters, live: 'vod' } }).length, 1, 'an unresolved playlist is neither live nor VOD');
  const both = { ...s, query: 'm3u8', filters: { ...s.filters, detectedBy: ['mime'], kind: ['media'] } };
  assert.deepEqual(selectVisible(both).map((h) => h.detectedBy), ['mime']);
});

test('selectVisible: an unresolved hit is not dropped by the kind filter for media', () => {
  const s = reduce(initialState(), { type: 'HIT', hit: hit() });
  assert.equal(selectVisible({ ...s, filters: { ...s.filters, kind: ['media'] } }).length, 0);
  assert.equal(selectVisible({ ...s, filters: { ...s.filters, encrypted: 'no' } }).length, 1, 'no keys known yet is not "encrypted"');
});

test('selectVisible: sorting by bandwidth, segments and url, with a deterministic tie-break', () => {
  const s = seeded();
  const byBandwidth = selectVisible({ ...s, sort: { key: 'bandwidth', dir: 'desc' } });
  assert.equal(byBandwidth[0].url, 'http://127.0.0.1:53100/hls/master.m3u8', 'the master carries the highest variant bandwidth');
  const bySegments = selectVisible({ ...s, sort: { key: 'segments', dir: 'desc' } });
  assert.equal(bySegments[0].playlist.segments, 6);
  const byUrl = selectVisible({ ...s, sort: { key: 'url', dir: 'asc' } }).map((h) => h.url);
  assert.deepEqual(byUrl, [...byUrl].sort());

  const tied = run(initialState(),
    { type: 'HIT', hit: hit({ url: 'http://127.0.0.1:1/b.m3u8' }) },
    { type: 'HIT', hit: hit({ url: 'http://127.0.0.1:1/a.m3u8' }) });
  const first = selectVisible({ ...tied, sort: { key: 'segments', dir: 'desc' } }).map((h) => h.url);
  const second = selectVisible({ ...tied, sort: { key: 'segments', dir: 'desc' } }).map((h) => h.url);
  assert.deepEqual(first, second, 'equal sort keys must not reorder between calls');
  assert.deepEqual(first, ['http://127.0.0.1:1/b.m3u8', 'http://127.0.0.1:1/a.m3u8'], 'ties fall back to arrival order');
});

test('REORDER: a manual order wins over sorting and survives a new hit arriving', () => {
  const s = seeded();
  const ids = selectVisible(s).map((h) => h.id);
  const reversed = [...ids].reverse();
  let m = reduce(s, { type: 'REORDER', ids: reversed });
  assert.equal(m.sort.key, 'manual');
  assert.deepEqual(selectVisible(m).map((h) => h.id), reversed);

  m = reduce(m, { type: 'HIT', hit: hit({ url: 'http://127.0.0.1:53100/late.m3u8' }) });
  const visible = selectVisible(m).map((h) => h.id);
  assert.deepEqual(visible.slice(0, 3), reversed, 'a new hit disturbed the manual order');
  assert.equal(visible.length, 4);
  assert.equal(visible[3], m.hits.at(-1).id, 'the new hit must append, not vanish');
});

test('SORT_SET: choosing a sort key leaves manual mode', () => {
  const s = seeded();
  const ids = selectVisible(s).map((h) => h.id);
  let m = reduce(s, { type: 'REORDER', ids: [...ids].reverse() });
  m = reduce(m, { type: 'SORT_SET', key: 'url', dir: 'asc' });
  assert.equal(m.sort.key, 'url');
  assert.deepEqual(selectVisible(m).map((h) => h.url), [...selectVisible(m).map((h) => h.url)].sort());
});

test('selection: toggle, select-all-visible and clear', () => {
  const s = seeded();
  const ids = selectVisible(s).map((h) => h.id);
  let m = reduce(s, { type: 'SELECT_TOGGLE', id: ids[0] });
  assert.deepEqual(m.selected, [ids[0]]);
  m = reduce(m, { type: 'SELECT_TOGGLE', id: ids[0] });
  assert.deepEqual(m.selected, []);
  m = reduce(s, { type: 'SELECT_VISIBLE' });
  assert.deepEqual(m.selected, ids);
  m = reduce(m, { type: 'SELECT_NONE' });
  assert.deepEqual(m.selected, []);
});

test('SELECT_VISIBLE: only selects what the current filters show', () => {
  const s = seeded();
  const filtered = { ...s, filters: { ...s.filters, detectedBy: ['body'] } };
  const m = reduce(filtered, { type: 'SELECT_VISIBLE' });
  assert.equal(m.selected.length, 1);
  assert.equal(m.hits.find((h) => h.id === m.selected[0]).detectedBy, 'body');
});

// break: a destructive delete with no way back
test('DELETE: removes immediately and UNDO restores the exact hits and order', () => {
  const s = seeded();
  const ids = selectVisible(s).map((h) => h.id);
  let m = reduce(s, { type: 'REORDER', ids: [ids[2], ids[0], ids[1]] });
  const before = selectVisible(m).map((h) => h.id);
  m = reduce(m, { type: 'DELETE', ids: [ids[0], ids[2]] });
  assert.deepEqual(selectVisible(m).map((h) => h.id), [ids[1]]);
  assert.deepEqual(m.selected, [], 'deleted hits must not stay selected');
  assert.equal(m.undo.length, 1);
  assert.match(m.undo[0].label, /2/);

  m = reduce(m, { type: 'UNDO' });
  assert.deepEqual(selectVisible(m).map((h) => h.id), before, 'undo did not restore the manual order');
  assert.deepEqual(m.undo, []);
});

test('UNDO: with nothing to undo is a no-op, not a crash', () => {
  const s = seeded();
  assert.deepEqual(reduce(s, { type: 'UNDO' }), s);
});

test('CLEAR: empties the list but stays undoable', () => {
  const s = seeded();
  let m = reduce(s, { type: 'CLEAR' });
  assert.deepEqual(m.hits, []);
  m = reduce(m, { type: 'UNDO' });
  assert.equal(m.hits.length, 3);
});

test('DELETE: an id that is not there changes nothing and pushes no undo entry', () => {
  const s = seeded();
  const m = reduce(s, { type: 'DELETE', ids: ['nope'] });
  assert.equal(m.hits.length, 3);
  assert.deepEqual(m.undo, []);
});

test('saved views: capture, apply and delete the list controls only', () => {
  const s = seeded();
  let m = run(s,
    { type: 'QUERY_SET', text: 'inline' },
    { type: 'FILTER_SET', key: 'detectedBy', value: ['body'] },
    { type: 'SORT_SET', key: 'segments', dir: 'desc' },
    { type: 'VIEW_SAVE', name: '只看 body 命中' });
  assert.equal(m.views.length, 1);
  assert.equal(m.views[0].name, '只看 body 命中');

  m = run(m, { type: 'QUERY_SET', text: '' }, { type: 'FILTER_SET', key: 'detectedBy', value: [] }, { type: 'SORT_SET', key: 'time', dir: 'asc' });
  assert.equal(selectVisible(m).length, 3);
  m = reduce(m, { type: 'VIEW_APPLY', id: m.views[0].id });
  assert.equal(m.query, 'inline');
  assert.deepEqual(m.filters.detectedBy, ['body']);
  assert.equal(m.sort.key, 'segments');
  assert.equal(selectVisible(m).length, 1);
  assert.equal(m.hits.length, 3, 'applying a view must not touch the captured data');

  m = reduce(m, { type: 'VIEW_DELETE', id: m.views[0].id });
  assert.deepEqual(m.views, []);
});

test('VIEW_SAVE: an empty name is refused', () => {
  const s = seeded();
  assert.deepEqual(reduce(s, { type: 'VIEW_SAVE', name: '   ' }).views, []);
});

test('FILTER_SET: toggling a value in an array filter adds then removes it', () => {
  const s = initialState();
  let m = reduce(s, { type: 'FILTER_SET', key: 'detectedBy', value: 'url' });
  assert.deepEqual(m.filters.detectedBy, ['url']);
  m = reduce(m, { type: 'FILTER_SET', key: 'detectedBy', value: 'mime' });
  assert.deepEqual(m.filters.detectedBy, ['url', 'mime']);
  m = reduce(m, { type: 'FILTER_SET', key: 'detectedBy', value: 'url' });
  assert.deepEqual(m.filters.detectedBy, ['mime']);
});

test('LOG: keeps a bounded tail so a long capture cannot grow without limit', () => {
  let s = initialState();
  for (let i = 0; i < 600; i += 1) s = reduce(s, { type: 'LOG', text: `line ${i}` });
  assert.ok(s.log.length <= 300, `log grew to ${s.log.length}`);
  assert.equal(s.log.at(-1).text, 'line 599');
});

test('serialize/hydrate: round-trips config, views and sound, never the capture itself', () => {
  let s = run(initialState(),
    { type: 'CONFIG_SET', key: 'port', value: 9444 },
    { type: 'VIEW_SAVE', name: 'v' },
    { type: 'HIT', hit: hit() },
    { type: 'SOUND_SET', value: true });
  const saved = JSON.parse(JSON.stringify(serialize(s)));
  assert.equal(saved.hits, undefined, 'a capture must not be persisted');
  const back = hydrate(saved);
  assert.equal(back.config.port, 9444);
  assert.equal(back.views.length, 1);
  assert.equal(back.sound, true);
  assert.deepEqual(back.hits, []);
  assert.equal(back.run.status, 'idle');
});

test('hydrate: junk from an older version falls back to defaults instead of throwing', () => {
  for (const junk of [null, undefined, {}, { config: 'nope' }, { views: 'nope' }, { config: { port: 'x' } }]) {
    const s = hydrate(junk);
    assert.equal(typeof s.config.port, 'number', JSON.stringify(junk));
    assert.ok(Array.isArray(s.views));
    assert.ok(Array.isArray(s.hits));
  }
});

test('seededRandom: same seed gives the same sequence, different seeds differ', () => {
  const a = seededRandom(42);
  const b = seededRandom(42);
  const c = seededRandom(43);
  const seqA = Array.from({ length: 5 }, () => a());
  const seqB = Array.from({ length: 5 }, () => b());
  const seqC = Array.from({ length: 5 }, () => c());
  assert.deepEqual(seqA, seqB);
  assert.notDeepEqual(seqA, seqC);
  assert.ok(seqA.every((n) => n >= 0 && n < 1), JSON.stringify(seqA));
});

// break: demo mode being a slideshow that ignores the controls
test('demoEvents: honours the sniff switch and the configured base URL', () => {
  const withSniff = demoEvents({ ...DEFAULT_CONFIG, url: 'http://localhost:5173/', sniff: true }, 7);
  const without = demoEvents({ ...DEFAULT_CONFIG, url: 'http://localhost:5173/', sniff: false }, 7);
  assert.ok(withSniff.some((e) => e.t === 'hit' && e.hit.detectedBy === 'body'), 'sniff on must produce a body-leg hit');
  assert.equal(without.some((e) => e.t === 'hit' && e.hit.detectedBy === 'body'), false, 'sniff off must not produce a body-leg hit');
  for (const e of withSniff) {
    if (e.t === 'hit' || e.t === 'resolved') assert.match(e.hit.url, /^http:\/\/localhost:5173\//, e.hit.url);
  }
  assert.equal(withSniff.at(-1).t, 'summary');
  assert.ok(withSniff.some((e) => e.t === 'resolved' && e.hit.playlist?.kind === 'master'));
});

test('demoEvents: is deterministic for a seed and never leaks credentials', () => {
  // generatedAt 是墙钟，本来就该每次不同；判据只针对种子生成的数据
  const strip = (events) => events.map((e) => (e.t === 'summary'
    ? { ...e, meta: { ...e.meta, generatedAt: '<clock>' } }
    : e));
  const a = demoEvents(DEFAULT_CONFIG, 11);
  const b = demoEvents(DEFAULT_CONFIG, 11);
  assert.deepEqual(strip(a), strip(b));
  assert.notDeepEqual(strip(a), strip(demoEvents(DEFAULT_CONFIG, 12)));
  for (const e of a) {
    if (!e.hit) continue;
    assert.equal('requestHeaders' in e.hit, false);
    assert.equal('body' in e.hit, false);
  }
});

// break: demo counters staying at zero until the summary, unlike a real capture
test('demoEvents: emits climbing progress frames that end at the summary totals', () => {
  const events = demoEvents(DEFAULT_CONFIG, 11);
  const progress = events.filter((e) => e.t === 'progress');
  assert.ok(progress.length >= 3, `expected several progress frames, got ${progress.length}`);
  for (let i = 1; i < progress.length; i += 1) {
    assert.ok(progress[i].requests >= progress[i - 1].requests, 'progress counters must not go backwards');
  }
  const summary = events.at(-1);
  assert.equal(progress.at(-1).requests, summary.meta.requests);
  assert.equal(events.indexOf(progress.at(-1)), events.length - 2, 'the last progress frame must sit right before the summary');
});

test('demoEvents: a blank start URL still yields a coherent local capture', () => {
  const events = demoEvents({ ...DEFAULT_CONFIG, url: '' }, 3);
  const summary = events.at(-1);
  assert.equal(summary.t, 'summary');
  assert.ok(summary.meta.requests > 0);
  assert.ok(summary.hits.length >= 2);
});

test('exportAddresses: one absolute URL per line, in the visible order', () => {
  const s = seeded();
  const text = exportAddresses(selectVisible(s));
  assert.deepEqual(text.split('\n'), selectVisible(s).map((h) => h.url));
});

test('exportCsv: quotes commas, quotes and newlines so a URL cannot break a row', () => {
  const hits = [{
    ...hit({ url: 'http://127.0.0.1:1/a.m3u8?x=1,2&y="q"', initiator: 'p.js:1 a,b' }),
    playlist: mediaPlaylist(),
    count: 1,
  }];
  const csv = exportCsv(hits);
  const lines = csv.split('\n');
  assert.equal(lines.length, 2, 'a quoted field must not add a row');
  assert.match(lines[0], /url/);
  assert.match(csv, /"http:\/\/127\.0\.0\.1:1\/a\.m3u8\?x=1,2&y=""q"""/);
});

test('exportCsv: a hit with no playlist still exports a row', () => {
  const csv = exportCsv([{ ...hit(), count: 1 }]);
  assert.equal(csv.split('\n').length, 2);
});

test('exportJson: carries the config, the counters and the visible hits', () => {
  const s = seeded();
  const parsed = JSON.parse(exportJson(s, selectVisible(s)));
  assert.equal(parsed.hits.length, 3);
  assert.deepEqual(parsed.config, s.config);
  assert.ok(parsed.exportedAt);
  assert.equal(parsed.hits[0].requestHeaders, undefined);
});

test('reorderIds: moving before and after a target, including to both ends', () => {
  const ids = ['a', 'b', 'c', 'd'];
  assert.deepEqual(reorderIds(ids, 'a', 'c', false), ['b', 'a', 'c', 'd']);
  assert.deepEqual(reorderIds(ids, 'a', 'c', true), ['b', 'c', 'a', 'd']);
  assert.deepEqual(reorderIds(ids, 'd', 'a', false), ['d', 'a', 'b', 'c']);
  assert.deepEqual(reorderIds(ids, 'a', 'd', true), ['b', 'c', 'd', 'a']);
  assert.deepEqual(reorderIds(ids, 'b', 'b', false), ids, 'dropping on itself changes nothing');
  assert.deepEqual(reorderIds(ids, 'zz', 'a', false), ids, 'an unknown drag id changes nothing');
  assert.deepEqual(reorderIds(ids, 'a', 'zz', false), ids, 'an unknown target changes nothing');
  assert.deepEqual(ids, ['a', 'b', 'c', 'd'], 'reorderIds mutated its input');
});

// break: a fatal error being cosmetically overwritten by the exit event that follows it
test('END: does not erase an error that arrived first', () => {
  let s = reduce(initialState(), { type: 'RUN_STARTED', runId: 'r', startedAt: 'now' });
  s = reduce(s, { type: 'ERROR', text: '接不上调试端口' });
  s = reduce(s, { type: 'END', code: 1 });
  assert.equal(s.run.status, 'error');
  assert.equal(s.run.error, '接不上调试端口');
  assert.equal(s.run.code, 1);
});
// break: 演示模式播完最后一条就停在 recording，开始录制按钮永远是灰的
test('playDemo: signals completion with an end event, like the bridge does', async () => {
  const seen = [];
  const stop = playDemo([{ t: 'log', text: 'a' }, { t: 'summary', meta: {}, hits: [] }], (name, payload) => seen.push([name, payload]), 1);
  await new Promise((r) => setTimeout(r, 400));
  stop();
  assert.deepEqual(seen.map(([n]) => n), ['log', 'summary', 'end']);
  assert.equal(seen.at(-1)[1].code, 0);
});

test('playDemo: cancelling mid-stream never emits end', async () => {
  const seen = [];
  const stop = playDemo([{ t: 'log', text: 'a' }, { t: 'log', text: 'b' }, { t: 'summary', meta: {}, hits: [] }], (name) => seen.push(name), 200);
  await new Promise((r) => setTimeout(r, 200));
  assert.deepEqual(seen, ['log'], '前提不成立：取消时应当只播了一条');
  stop();
  await new Promise((r) => setTimeout(r, 500));
  assert.deepEqual(seen, ['log']);
});

// break: Pages 上每次开页都发一个必然 404 的 api/health，调试工具自己先报一条红
test('canReachBridge: only a loopback page origin can reach the bridge', () => {
  for (const href of ['http://127.0.0.1:8787/', 'http://localhost:5173/app/', 'http://[::1]:8787/', 'http://127.0.0.99:8787/']) {
    assert.equal(canReachBridge(href), true, href);
  }
  for (const href of ['https://example.github.io/m3u8-probe/', 'http://192.168.1.5:8787/', 'file:///C:/ui/index.html', '', null, undefined]) {
    assert.equal(canReachBridge(href), false, String(href));
  }
});

test('detectBridge: a remote page never sends the probe', async () => {
  const realFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls += 1; throw new Error('should not be called'); };
  try {
    assert.equal(await detectBridge('https://example.github.io/m3u8-probe/'), null);
    assert.equal(calls, 0);
  } finally {
    globalThis.fetch = realFetch;
  }
});

// break: 一键获取永远不收尾，或者在 master 还没解析完时就停，把码流清单丢在半路
test('autoStopDecision: waits for every hit to resolve, then settles', () => {
  const base = { startedAt: 0, now: 5000, lastHitAt: 4000, hits: 2, resolved: 2 };
  assert.equal(autoStopDecision(base), null, '刚来命中就停会丢后续码流');
  assert.equal(autoStopDecision({ ...base, now: 5600 }), 'settled');
  assert.equal(autoStopDecision({ ...base, resolved: 1 }), null, '还有命中没解析完');
  assert.equal(autoStopDecision({ ...base, hits: 0, resolved: 0, now: 9000 }), null, '零命中不该提前收尾');
  assert.equal(autoStopDecision({ ...base, hits: 0, resolved: 0, now: 30000 }), 'timeout');
  assert.equal(autoStopDecision({ ...base, now: 31000 }), 'timeout', '兜底超时必须能收尾');
});

test('autoStopDecision: a zero-hit run still ends at the ceiling', () => {
  const args = { startedAt: 1000, now: 1000, lastHitAt: 0, hits: 0, resolved: 0, maxWaitMs: 500 };
  assert.equal(autoStopDecision(args), null);
  assert.equal(autoStopDecision({ ...args, now: 1500 }), 'timeout');
});

// break: 输出区只列命中本身，master 里真正能播的码流地址反而拿不到
test('collectAddresses: hits plus master variants, deduped in first-seen order', () => {
  const hits = [
    { url: 'http://local.test/hls/master.m3u8', detectedBy: 'url', playlist: { kind: 'master', variants: [{ url: 'http://local.test/hls/720.m3u8' }, { url: 'http://local.test/hls/360.m3u8' }] } },
    { url: 'http://local.test/hls/720.m3u8', detectedBy: 'mime', playlist: { kind: 'media' } },
    { url: 'http://local.test/api/inline', detectedBy: 'body', playlist: null },
  ];
  const rows = collectAddresses(hits);
  assert.deepEqual(rows.map((r) => r.url), [
    'http://local.test/hls/master.m3u8',
    'http://local.test/hls/720.m3u8',
    'http://local.test/hls/360.m3u8',
    'http://local.test/api/inline',
  ]);
  assert.equal(rows[1].kind, 'variant');
  assert.equal(rows[3].kind, 'unknown');
  assert.deepEqual(collectAddresses([]), []);
});

test('collectAddresses: drops empty and non-string urls', () => {
  const rows = collectAddresses([{ url: '', detectedBy: 'url', playlist: { variants: [{ url: null }, { url: 'http://local.test/a.m3u8' }] } }]);
  assert.deepEqual(rows.map((r) => r.url), ['http://local.test/a.m3u8']);
});
