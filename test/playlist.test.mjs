import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parsePlaylist,
  resolveUrl,
  looksLikePlaylistUrl,
  isPlaylistMimeType,
  isPlaylistBody,
} from '../playlist.mjs';

const MASTER = [
  '#EXTM3U',
  '#EXT-X-VERSION:4',
  '#EXT-X-STREAM-INF:BANDWIDTH=1280000,AVERAGE-BANDWIDTH=1200000,RESOLUTION=1280x720,CODECS="avc1.4d401f,mp4a.40.2",FRAME-RATE=25.000,NAME="720p"',
  '720.m3u8?token=abc',
  '#EXT-X-STREAM-INF:BANDWIDTH=2560000,RESOLUTION=1920x1080,CODECS="avc1.640028"',
  'https://cdn.example.com/hi/1080.m3u8',
  '',
].join('\n');

const MASTER_BASE = 'http://local.test/hls/master.m3u8';

// break: splitting the attribute list on "," chops CODECS in half
test('master: quoted CODECS survives attribute parsing', () => {
  const p = parsePlaylist(MASTER, MASTER_BASE);
  assert.equal(p.variants[0].codecs, 'avc1.4d401f,mp4a.40.2');
  assert.equal(p.variants[1].codecs, 'avc1.640028');
});

// break: reading only the first attribute, or coercing to string
test('master: numeric attributes are numbers, absent ones are null', () => {
  const p = parsePlaylist(MASTER, MASTER_BASE);
  assert.equal(p.variants[0].bandwidth, 1280000);
  assert.equal(p.variants[0].averageBandwidth, 1200000);
  assert.equal(p.variants[0].frameRate, 25);
  assert.equal(p.variants[0].resolution, '1280x720');
  assert.equal(p.variants[0].name, '720p');
  assert.equal(p.variants[1].averageBandwidth, null);
  assert.equal(p.variants[1].name, null);
});

// break: dropping the query string when resolving the variant URI
test('master: variant query string is preserved', () => {
  const p = parsePlaylist(MASTER, MASTER_BASE);
  assert.equal(p.variants[0].url, 'http://local.test/hls/720.m3u8?token=abc');
});

// break: leaving an absolute variant URI relative, or re-basing it onto our host
test('master: absolute variant URI is left alone', () => {
  const p = parsePlaylist(MASTER, MASTER_BASE);
  assert.equal(p.variants[1].url, 'https://cdn.example.com/hi/1080.m3u8');
});

// break: reporting a master as a media playlist
test('master: kind is master and it has no segments', () => {
  const p = parsePlaylist(MASTER, MASTER_BASE);
  assert.equal(p.valid, true);
  assert.equal(p.kind, 'master');
  assert.equal(p.version, 4);
  assert.equal(p.segments, 0);
});

// break: string-concatenating the base instead of using URL semantics
test('resolveUrl: parent traversal, root-relative and protocol-relative', () => {
  assert.equal(resolveUrl('../v/720.m3u8', 'http://local.test/a/b/index.m3u8'), 'http://local.test/a/v/720.m3u8');
  assert.equal(resolveUrl('/abs.m3u8', 'http://local.test/a/b/index.m3u8'), 'http://local.test/abs.m3u8');
  assert.equal(resolveUrl('//cdn.example.com/x.m3u8', 'http://local.test/a/b/index.m3u8'), 'http://cdn.example.com/x.m3u8');
  assert.equal(resolveUrl('seg.ts', 'http://local.test/v/index.m3u8'), 'http://local.test/v/seg.ts');
});

const VOD = [
  '#EXTM3U',
  '#EXT-X-VERSION:3',
  '#EXT-X-TARGETDURATION:10',
  '#EXT-X-MEDIA-SEQUENCE:0',
  '#EXT-X-PLAYLIST-TYPE:VOD',
  '#EXTINF:9.009,',
  'seg0.ts',
  '#EXTINF:10.0,Title Here',
  'seg1.ts',
  '#EXTINF:5.5,',
  'seg2.ts',
  '#EXT-X-ENDLIST',
  '',
].join('\n');

const VOD_BASE = 'http://local.test/v/index.m3u8';

// break: counting #EXTINF tags instead of URI lines, or summing the title text
test('media: segment count and total duration come from the URI lines', () => {
  const p = parsePlaylist(VOD, VOD_BASE);
  assert.equal(p.kind, 'media');
  assert.equal(p.segments, 3);
  assert.ok(Math.abs(p.totalDuration - 24.509) < 1e-6, `totalDuration was ${p.totalDuration}`);
  assert.equal(p.targetDuration, 10);
  assert.equal(p.mediaSequence, 0);
  assert.equal(p.playlistType, 'VOD');
});

// break: defaulting live to false regardless of ENDLIST
test('media: ENDLIST means VOD, not live', () => {
  const p = parsePlaylist(VOD, VOD_BASE);
  assert.equal(p.endList, true);
  assert.equal(p.live, false);
});

// break: treating every playlist as VOD
test('media: no ENDLIST means live', () => {
  const p = parsePlaylist('#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXT-X-MEDIA-SEQUENCE:120\n#EXTINF:6.0,\ns.ts\n', VOD_BASE);
  assert.equal(p.live, true);
  assert.equal(p.endList, false);
  assert.equal(p.mediaSequence, 120);
});

// break: counting only EXTINF tags and missing a bare URI
test('media: a URI without a preceding EXTINF still counts as a segment', () => {
  const p = parsePlaylist('#EXTM3U\n#EXT-X-TARGETDURATION:6\nseg0.ts\n#EXTINF:6.0,\nseg1.ts\n#EXT-X-ENDLIST\n', VOD_BASE);
  assert.equal(p.segments, 2);
  assert.ok(Math.abs(p.totalDuration - 6) < 1e-6);
});

// break: exposing a relative first segment that cannot be fetched as-is
test('media: firstSegmentUrl is absolute', () => {
  const p = parsePlaylist(VOD, VOD_BASE);
  assert.equal(p.firstSegmentUrl, 'http://local.test/v/seg0.ts');
});

// break: a stray \r surviving into the resolved URI (shows up as %0D)
test('media: CRLF and a BOM do not leak into resolved URIs', () => {
  const text = '\uFEFF#EXTM3U\r\n#EXT-X-TARGETDURATION:6\r\n#EXTINF:6.0,\r\nseg0.ts\r\n#EXT-X-ENDLIST\r\n';
  const p = parsePlaylist(text, VOD_BASE);
  assert.equal(p.valid, true);
  assert.equal(p.segments, 1);
  assert.equal(p.firstSegmentUrl, 'http://local.test/v/seg0.ts');
});

// break: same leak on the master side
test('master: CRLF and a BOM do not leak into variant URIs', () => {
  const p = parsePlaylist('\uFEFF' + MASTER.replace(/\n/g, '\r\n'), MASTER_BASE);
  assert.equal(p.variants.length, 2);
  assert.equal(p.variants[0].url, 'http://local.test/hls/720.m3u8?token=abc');
});

const ENCRYPTED = [
  '#EXTM3U',
  '#EXT-X-TARGETDURATION:6',
  '#EXT-X-KEY:METHOD=AES-128,URI="key.bin",IV=0x00000000000000000000000000000001',
  '#EXTINF:6.0,',
  's0.ts',
  '#EXT-X-ENDLIST',
  '',
].join('\n');

// break: reporting the key URI relative, so it cannot be fetched
test('key: AES-128 URI is resolved and IV is kept verbatim', () => {
  const p = parsePlaylist(ENCRYPTED, VOD_BASE);
  assert.equal(p.encrypted, true);
  assert.equal(p.keys.length, 1);
  assert.equal(p.keys[0].method, 'AES-128');
  assert.equal(p.keys[0].uri, 'key.bin');
  assert.equal(p.keys[0].url, 'http://local.test/v/key.bin');
  assert.equal(p.keys[0].iv, '0x00000000000000000000000000000001');
});

// break: treating any EXT-X-KEY directive as encryption
test('key: METHOD=NONE is not encryption', () => {
  const p = parsePlaylist('#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXT-X-KEY:METHOD=NONE\n#EXTINF:6.0,\ns.ts\n#EXT-X-ENDLIST\n', VOD_BASE);
  assert.equal(p.encrypted, false);
  assert.equal(p.keys.length, 0);
});

// negative control: break = inventing an encryption flag for a plain playlist
test('key: a playlist with no EXT-X-KEY reports no keys', () => {
  const p = parsePlaylist(VOD, VOD_BASE);
  assert.equal(p.encrypted, false);
  assert.deepEqual(p.keys, []);
});

// break: keeping only the last key and losing rotation
test('key: rotation keeps every key directive in order', () => {
  const text = '#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXT-X-KEY:METHOD=AES-128,URI="k1.bin"\n#EXTINF:6.0,\ns0.ts\n#EXT-X-KEY:METHOD=SAMPLE-AES,URI="k2.bin"\n#EXTINF:6.0,\ns1.ts\n#EXT-X-ENDLIST\n';
  const p = parsePlaylist(text, VOD_BASE);
  assert.equal(p.keys.length, 2);
  assert.deepEqual(p.keys.map((k) => k.method), ['AES-128', 'SAMPLE-AES']);
  assert.equal(p.keys[1].url, 'http://local.test/v/k2.bin');
});

// break: leaving the init segment relative
test('map: EXT-X-MAP URI is resolved', () => {
  const text = '#EXTM3U\n#EXT-X-TARGETDURATION:10\n#EXT-X-MAP:URI="init.mp4",BYTERANGE="1000@0"\n#EXTINF:10.0,\n#EXT-X-BYTERANGE:1000@0\nvideo.mp4\n#EXTINF:10.0,\n#EXT-X-BYTERANGE:1000@1000\nvideo.mp4\n#EXT-X-ENDLIST\n';
  const p = parsePlaylist(text, VOD_BASE);
  assert.equal(p.map.url, 'http://local.test/v/init.mp4');
  assert.equal(p.segments, 2);
});

// break: defaulting map to an object even when absent
test('map: absent EXT-X-MAP yields null', () => {
  assert.equal(parsePlaylist(VOD, VOD_BASE).map, null);
});

// break: inventing a variant with an undefined url from a dangling tag
test('truncated STREAM-INF: warns instead of inventing a variant', () => {
  const p = parsePlaylist('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1000\n', MASTER_BASE);
  assert.equal(p.valid, true);
  assert.deepEqual(p.variants, []);
  assert.ok(p.warnings.length >= 1, 'expected a warning for the dangling tag');
});

// break: parsing an HTML error page as a playlist and reporting zero segments as success
test('invalid body: an HTML error page is not a playlist', () => {
  const p = parsePlaylist('<!DOCTYPE html><html><body>403</body></html>', MASTER_BASE);
  assert.equal(p.valid, false);
  assert.equal(p.kind, 'unknown');
  assert.deepEqual(p.variants, []);
  assert.equal(p.segments, 0);
});

// break: NaN duration or a thrown error on an empty but valid playlist
test('empty media playlist: zero segments, zero duration, still valid', () => {
  const p = parsePlaylist('#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXT-X-ENDLIST\n', VOD_BASE);
  assert.equal(p.valid, true);
  assert.equal(p.kind, 'media');
  assert.equal(p.segments, 0);
  assert.equal(p.totalDuration, 0);
  assert.equal(p.firstSegmentUrl, null);
});

// break: predicate too loose (matches .m3u) or too tight (misses query strings)
test('looksLikePlaylistUrl', () => {
  const cases = [
    ['http://h/a.m3u8', true],
    ['http://h/a.m3u8?token=x', true],
    ['http://h/a.m3u8#frag', true],
    ['http://h/a.M3U8', true],
    ['http://h/a.m3u8/720', true],
    ['http://h/a.m3u', false],
    ['http://h/a.ts', false],
    ['http://h/playlist?type=m3u8', false],
    ['http://h/xm3u8', false],
    ['http://h/a.m3u8x', false],
  ];
  for (const [url, want] of cases) assert.equal(looksLikePlaylistUrl(url), want, url);
});

// break: missing the x-mpegURL spelling or a charset suffix
test('isPlaylistMimeType', () => {
  const cases = [
    ['application/vnd.apple.mpegurl', true],
    ['application/x-mpegURL', true],
    ['audio/mpegurl', true],
    ['audio/x-mpegurl', true],
    ['application/vnd.apple.mpegurl; charset=utf-8', true],
    ['video/mp2t', false],
    ['text/html', false],
    ['', false],
    [undefined, false],
  ];
  for (const [mime, want] of cases) assert.equal(isPlaylistMimeType(mime), want, String(mime));
});

// break: sniffing only at index 0 and missing a BOM or leading blank line
test('isPlaylistBody', () => {
  const cases = [
    ['#EXTM3U\n#EXTINF:6,', true],
    ['\uFEFF#EXTM3U', true],
    ['  \n#EXTM3U', true],
    ['<!DOCTYPE html>', false],
    ['#EXTINF:10.0,', false],
    ['', false],
  ];
  for (const [body, want] of cases) assert.equal(isPlaylistBody(body), want, JSON.stringify(body));
});