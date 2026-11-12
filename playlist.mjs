const PLAYLIST_URL_RE = /\.m3u8(?:[/?#]|$)/i;
const PLAYLIST_MIME_RE = /^(?:application\/vnd\.apple\.mpegurl|application\/x-mpegurl|audio\/mpegurl|audio\/x-mpegurl)\b/i;
const PLAYLIST_BODY_RE = /^\uFEFF?\s*#EXTM3U(?:\r?\n|$)/;
const TAG_RE = /^#([A-Z0-9-]+)(?::([\s\S]*))?$/;

export function looksLikePlaylistUrl(url) {
  return typeof url === 'string' && PLAYLIST_URL_RE.test(url);
}

export function isPlaylistMimeType(mimeType) {
  return typeof mimeType === 'string' && PLAYLIST_MIME_RE.test(mimeType.trim());
}

export function isPlaylistBody(text) {
  return typeof text === 'string' && PLAYLIST_BODY_RE.test(text);
}

export function resolveUrl(uri, baseUrl) {
  return new URL(uri, baseUrl).href;
}

function parseAttributes(input) {
  const attrs = {};
  let i = 0;
  while (i < input.length) {
    while (i < input.length && (input[i] === ',' || input[i] === ' ')) i += 1;
    const eq = input.indexOf('=', i);
    if (eq === -1) break;
    const name = input.slice(i, eq).trim();
    let j = eq + 1;
    let value;
    if (input[j] === '"') {
      const close = input.indexOf('"', j + 1);
      value = close === -1 ? input.slice(j + 1) : input.slice(j + 1, close);
      j = close === -1 ? input.length : close + 1;
    } else {
      const comma = input.indexOf(',', j);
      value = comma === -1 ? input.slice(j) : input.slice(j, comma);
      j = comma === -1 ? input.length : comma;
    }
    if (name) attrs[name] = value;
    i = j;
  }
  return attrs;
}

function num(value) {
  if (value == null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

export function parsePlaylist(text, url) {
  const result = {
    url,
    valid: false,
    kind: 'unknown',
    version: null,
    playlistType: null,
    targetDuration: null,
    mediaSequence: null,
    endList: false,
    live: false,
    segments: 0,
    totalDuration: 0,
    firstSegmentUrl: null,
    variants: [],
    keys: [],
    encrypted: false,
    map: null,
    warnings: [],
  };

  if (!isPlaylistBody(text)) return result;
  result.valid = true;

  const lines = text.replace(/^\uFEFF/, '').split(/\r\n|\r|\n/);
  let pendingVariant = null;
  let pendingDuration = 0;

  const flushVariant = (absoluteUrl) => {
    const a = pendingVariant;
    result.variants.push({
      bandwidth: num(a.BANDWIDTH),
      averageBandwidth: num(a['AVERAGE-BANDWIDTH']),
      resolution: a.RESOLUTION ?? null,
      codecs: a.CODECS ?? null,
      frameRate: num(a['FRAME-RATE']),
      name: a.NAME ?? null,
      url: absoluteUrl,
    });
    pendingVariant = null;
  };

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;

    if (!line.startsWith('#')) {
      const absoluteUrl = resolveUrl(line, url);
      if (pendingVariant) {
        flushVariant(absoluteUrl);
      } else {
        result.segments += 1;
        result.totalDuration += pendingDuration;
        if (result.firstSegmentUrl === null) result.firstSegmentUrl = absoluteUrl;
      }
      pendingDuration = 0;
      continue;
    }

    const tag = TAG_RE.exec(line);
    if (!tag) continue;
    const [, name, rest = ''] = tag;

    switch (name) {
      case 'EXT-X-VERSION':
        result.version = num(rest);
        break;
      case 'EXT-X-TARGETDURATION':
        result.targetDuration = num(rest);
        break;
      case 'EXT-X-MEDIA-SEQUENCE':
        result.mediaSequence = num(rest);
        break;
      case 'EXT-X-PLAYLIST-TYPE':
        result.playlistType = rest.trim();
        break;
      case 'EXT-X-ENDLIST':
        result.endList = true;
        break;
      case 'EXTINF': {
        const comma = rest.indexOf(',');
        pendingDuration = num(comma === -1 ? rest : rest.slice(0, comma)) ?? 0;
        break;
      }
      case 'EXT-X-STREAM-INF':
        if (pendingVariant) result.warnings.push('dangling #EXT-X-STREAM-INF without a URI line');
        pendingVariant = parseAttributes(rest);
        break;
      case 'EXT-X-KEY': {
        const a = parseAttributes(rest);
        const method = a.METHOD ?? null;
        if (method && method !== 'NONE') {
          const uri = a.URI ?? null;
          result.keys.push({
            method,
            uri,
            url: uri ? resolveUrl(uri, url) : null,
            iv: a.IV ?? null,
            keyFormat: a.KEYFORMAT ?? null,
            keyFormatVersions: a.KEYFORMATVERSIONS ?? null,
          });
        }
        break;
      }
      case 'EXT-X-MAP': {
        const uri = parseAttributes(rest).URI ?? null;
        result.map = uri ? { uri, url: resolveUrl(uri, url) } : null;
        break;
      }
      default:
        break;
    }
  }

  if (pendingVariant) result.warnings.push('dangling #EXT-X-STREAM-INF without a URI line');

  result.kind = result.variants.length > 0 ? 'master' : 'media';
  result.live = result.kind === 'media' && !result.endList;
  result.encrypted = result.keys.length > 0;
  return result;
}