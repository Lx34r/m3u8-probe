export function seededRandom(seed) {
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
export function demoEvents(config, seed = 1) {
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

// 演示模式下的下载任务：照 N_m3u8DL-CLI 的真实事件形状播一遍。
// 进度行的格式来自 Watcher.cs（Progress: now/total (pct) -- size/size），这里只取事件语义。
export function demoDownloadEvents(url, seed = 1) {
  const rand = seededRandom(seed);
  const events = [];
  const total = 8 + Math.floor(rand() * 6);
  const push = (t, extra = {}) => events.push({ t, ...extra });

  push('started', { downloadId: `demo-dl-${seed}`, config: { url, saveName: 'demo-video', saveDir: 'C:\\demo\\downloads' } });
  push('log', { text: '下载器: C:/demo/N_m3u8DL-CLI/N_m3u8DL-CLI.exe（演示数据，没有真的启动下载器）' });
  push('phase', { phase: 'parsing' });
  push('log', { text: '解析m3u8内容' });
  push('phase', { phase: 'downloading' });
  push('log', { text: '开始下载文件' });
  for (let i = 1; i <= total; i += 1) {
    const percent = ((i / total) * 100).toFixed(2);
    push('log', { text: `Progress: ${i}/${total} (${percent}%) -- ${(i * 2.3).toFixed(1)}MB/${(total * 2.3).toFixed(1)}MB (3.1MB/s)` });
    push('progress', { done: i, total, percent: Number(percent), speed: '3.1MB/s' });
  }
  push('phase', { phase: 'downloaded' });
  push('log', { text: '已下载完毕' });
  push('phase', { phase: 'merging' });
  push('log', { text: '开始合并分片...' });
  push('log', { text: '使用ffmpeg合并...请耐心等待' });
  push('phase', { phase: 'done' });
  push('log', { text: '任务结束' });
  push('end', { code: 0, ok: true, finalFile: 'C:\\demo\\downloads\\demo-video.mp4', saveDir: 'C:\\demo\\downloads' });
  return events;
}