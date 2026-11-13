// 一键获取的收尾判据：纯函数，方便在没有浏览器的情况下判假。
// 取到地址就停，但不能在还有命中没解析完时停——那会把 master 的码流清单丢在半路。
export const AUTO_STOP_DEFAULTS = { settleMs: 1500, maxWaitMs: 30000 };

export function autoStopDecision({
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
export function collectAddresses(hits) {
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