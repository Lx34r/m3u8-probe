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

export function exportCsv(hits) {
  const rows = [CSV_COLUMNS.map(([name]) => name).join(',')];
  for (const hit of hits) rows.push(CSV_COLUMNS.map(([, get]) => csvCell(get(hit))).join(','));
  return rows.join('\n');
}

export function exportAddresses(hits) {
  return hits.map((h) => h.url).join('\n');
}

export function exportJson(state, hits) {
  return JSON.stringify({
    exportedAt: new Date().toISOString(),
    connection: state.connection,
    config: state.config,
    counters: state.counters,
    run: state.run,
    hits,
  }, null, 2);
}