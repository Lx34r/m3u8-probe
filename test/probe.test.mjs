import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseArgs,
  classifyResponse,
  describeInitiator,
  buildRefetchHeaders,
  escapeHtml,
  renderHtmlReport,
  dedupeHits,
  formatRunSummary,
  createReporter,
  publicHit,
} from '../m3u8-probe.mjs';

// break: a typo'd flag being silently ignored so the user thinks it took effect
test('parseArgs: an unknown flag throws and names it', () => {
  assert.throws(() => parseArgs(['--prot', '9222']), /--prot/);
});

// break: NaN port reaching spawn and Edge picking a random debugging port
test('parseArgs: a non-numeric port throws', () => {
  assert.throws(() => parseArgs(['--port', 'abc']), /port/i);
});

// break: only the space-separated form being supported
test('parseArgs: accepts both --flag value and --flag=value', () => {
  assert.equal(parseArgs(['--port', '9333']).port, 9333);
  assert.equal(parseArgs(['--port=9333']).port, 9333);
});

// break: the positional URL being swallowed as a flag value
test('parseArgs: a bare positional is the start URL', () => {
  assert.equal(parseArgs(['http://localhost:5173/']).url, 'http://localhost:5173/');
  assert.equal(parseArgs(['--port', '9333', 'http://localhost:5173/']).url, 'http://localhost:5173/');
});

// break: defaults drifting so a bare run attaches to a different port than documented
test('parseArgs: defaults', () => {
  const a = parseArgs([]);
  assert.equal(a.port, 9222);
  assert.equal(a.sniff, true);
  assert.equal(a.timeoutMs, 0);
  assert.equal(a.open, false);
  assert.equal(a.keepOpen, false);
  assert.equal(a.url, null);
});

// break: --open printing a report path that was never written
test('parseArgs: --open implies an html output path', () => {
  const a = parseArgs(['--open']);
  assert.equal(a.open, true);
  assert.ok(typeof a.html === 'string' && a.html.endsWith('.html'), JSON.stringify(a));
});

// break: --no-sniff leaving sniffing on and hammering every JS bundle
test('parseArgs: --no-sniff disables body sniffing', () => {
  assert.equal(parseArgs(['--no-sniff']).sniff, false);
});

// break: --timeout parsed as a string and compared numerically later
test('parseArgs: --timeout is a number of milliseconds', () => {
  assert.equal(parseArgs(['--timeout', '5000']).timeoutMs, 5000);
});

test('parseArgs: --help is recognised', () => {
  assert.equal(parseArgs(['--help']).help, true);
  assert.equal(parseArgs(['-h']).help, true);
});

// break: the bridge having no structured channel and being forced to scrape human text
test('parseArgs: --ndjson defaults off and turns on', () => {
  assert.equal(parseArgs([]).ndjson, false);
  assert.equal(parseArgs(['--ndjson']).ndjson, true);
});

function collector() {
  const chunks = [];
  return { write: (s) => chunks.push(s), text: () => chunks.join(''), lines: () => chunks.join('').split('\n').filter(Boolean) };
}

// break: emitting multi-line JSON, which desynchronises the whole event stream
test('createReporter: every ndjson event is exactly one parseable line', () => {
  const c = collector();
  const r = createReporter(true, c.write);
  r.hit({ url: 'http://h/a.m3u8\ninject', initiator: 'x' });
  r.summary({ requests: 1 }, []);
  const lines = c.lines();
  assert.equal(lines.length, 2);
  assert.equal(JSON.parse(lines[0]).t, 'hit');
  assert.equal(JSON.parse(lines[0]).hit.url, 'http://h/a.m3u8\ninject');
  assert.equal(JSON.parse(lines[1]).t, 'summary');
});

// break: log text being dropped in ndjson mode so the UI shows no progress
test('createReporter: ndjson log carries the text', () => {
  const c = collector();
  createReporter(true, c.write).log('录制中');
  assert.deepEqual(JSON.parse(c.lines()[0]), { t: 'log', text: '录制中' });
});

// break: human mode getting JSON noise instead of readable output
test('createReporter: human mode writes plain text and no event objects', () => {
  const c = collector();
  const r = createReporter(false, c.write);
  r.log('命中 1');
  r.hit({ url: 'http://h/a.m3u8' });
  r.summary({ requests: 1 }, []);
  assert.equal(c.text(), '命中 1\n');
});

// break: the resolved playlist never reaching the UI, so cards stay empty
test('createReporter: resolved carries the full hit including playlist', () => {
  const c = collector();
  const hit = { url: 'http://h/a.m3u8', playlist: { kind: 'master', variants: [] }, refetch: { ok: true, status: 200 } };
  createReporter(true, c.write).resolved(hit);
  const parsed = JSON.parse(c.lines()[0]);
  assert.equal(parsed.t, 'resolved');
  assert.equal(parsed.hit.playlist.kind, 'master');
  assert.equal(parsed.hit.refetch.status, 200);
});

// break: fatal errors being invisible to the UI
test('createReporter: error events are emitted in ndjson mode', () => {
  const c = collector();
  createReporter(true, c.write).error('端口被占用');
  assert.deepEqual(JSON.parse(c.lines()[0]), { t: 'error', text: '端口被占用' });
});

// break: counters only leaving the probe inside finish(), so the UI shows 请求 0 for the whole capture
test('createReporter: progress carries the live counters', () => {
  const c = collector();
  createReporter(true, c.write).progress({ requests: 41, responses: 38, sniffed: 6 });
  assert.deepEqual(JSON.parse(c.lines()[0]), { t: 'progress', requests: 41, responses: 38, sniffed: 6 });
});

// break: a periodic ticker spamming the human terminal with counter noise
test('createReporter: progress stays silent in human mode', () => {
  const c = collector();
  createReporter(false, c.write).progress({ requests: 41, responses: 38, sniffed: 6 });
  assert.equal(c.text(), '');
});

// break: session cookies and raw bodies riding along into an exportable UI artifact
test('publicHit: drops request headers and the recorded body, keeps every fact the UI shows', () => {
  const hit = {
    url: 'http://127.0.0.1:53100/hls/master.m3u8',
    status: 200,
    mimeType: 'application/vnd.apple.mpegurl',
    initiator: 'player.js:5',
    detectedBy: 'url',
    requestHeaders: { Cookie: 'session=secret', Referer: 'http://127.0.0.1:53100/' },
    body: '#EXTM3U\n',
    refetch: { ok: true, status: 200 },
    playlist: { kind: 'master', variants: [] },
  };
  const wire = publicHit(hit);
  assert.equal(JSON.stringify(wire).includes('secret'), false, 'cookie leaked onto the wire');
  assert.equal('requestHeaders' in wire, false);
  assert.equal('body' in wire, false);
  assert.equal(wire.url, hit.url);
  assert.equal(wire.initiator, hit.initiator);
  assert.equal(wire.detectedBy, hit.detectedBy);
  assert.equal(wire.playlist.kind, 'master');
  assert.equal(wire.refetch.status, 200);
  assert.equal(hit.requestHeaders.Cookie, 'session=secret', 'publicHit mutated the recorded hit');
});

// break: URL and mimeType legs never firing, so nothing is ever a hit
test('classifyResponse: playlist URL or playlist mimeType is a hit', () => {
  assert.equal(classifyResponse({ url: 'http://h/a.m3u8', resourceType: 'Media' }), 'hit');
  assert.equal(classifyResponse({ url: 'http://h/api/manifest', mimeType: 'application/x-mpegURL', resourceType: 'XHR' }), 'hit');
});

// break: a playlist served as text/plain being skipped entirely
test('classifyResponse: an unknown text response is a sniff candidate', () => {
  assert.equal(classifyResponse({ url: 'http://h/api/manifest', mimeType: 'text/plain', resourceType: 'XHR' }), 'sniff');
  assert.equal(classifyResponse({ url: 'http://h/api/video?id=1', resourceType: 'Fetch' }), 'sniff');
});

// break: sniffing every bundle and every segment, which floods getResponseBody
test('classifyResponse: scripts, styles, images and media segments are not sniffed', () => {
  assert.equal(classifyResponse({ url: 'http://h/bundle.js', mimeType: 'text/javascript', resourceType: 'Script' }), 'ignore');
  assert.equal(classifyResponse({ url: 'http://h/app.css', resourceType: 'Stylesheet' }), 'ignore');
  assert.equal(classifyResponse({ url: 'http://h/logo.png', resourceType: 'Image' }), 'ignore');
  assert.equal(classifyResponse({ url: 'http://h/seg0.ts', resourceType: 'Media' }), 'ignore');
});

// break: relying on resourceType alone, which mislabels some dev-server responses
test('classifyResponse: a static asset extension is ignored even when the type says XHR', () => {
  assert.equal(classifyResponse({ url: 'http://h/app.js', resourceType: 'XHR' }), 'ignore');
  assert.equal(classifyResponse({ url: 'http://h/clip.mp4', resourceType: 'Fetch' }), 'ignore');
});

// break: the URL leg being overruled by resourceType, losing <video src=*.m3u8>
test('classifyResponse: a playlist URL wins over an excluded resourceType', () => {
  assert.equal(classifyResponse({ url: 'http://h/v.m3u8', mimeType: 'video/mp2t', resourceType: 'Media' }), 'hit');
});

// break: reporting "script" with no file or line, which is useless for finding the source
test('describeInitiator: script stack gives file, 1-based line and function', () => {
  const initiator = {
    type: 'script',
    stack: { callFrames: [{ url: 'http://local.test/js/player.js', lineNumber: 811, functionName: 'loadStream' }] },
  };
  assert.equal(describeInitiator(initiator), 'player.js:812 loadStream');
});

// break: printing "undefined" for an anonymous frame
test('describeInitiator: an anonymous frame without a function name', () => {
  const initiator = { type: 'script', stack: { callFrames: [{ url: 'http://local.test/js/player.js', lineNumber: 10, functionName: '' }] } };
  assert.equal(describeInitiator(initiator), 'player.js:11');
});

// break: crashing on an initiator that has no stack at all
test('describeInitiator: script initiator without a stack falls back to its url', () => {
  assert.equal(describeInitiator({ type: 'script', url: 'http://local.test/a.js', lineNumber: 4 }), 'a.js:5');
  assert.equal(describeInitiator({ type: 'script', stack: { callFrames: [] } }), 'script');
});

// break: losing the document that caused a parser-initiated request
test('describeInitiator: parser initiator names the document', () => {
  assert.equal(describeInitiator({ type: 'parser', url: 'http://local.test/index.html' }), 'parser http://local.test/index.html');
});

// break: throwing on a missing initiator and killing the recorder
test('describeInitiator: other and missing initiators degrade to a label', () => {
  assert.equal(describeInitiator({ type: 'other' }), 'other');
  assert.equal(describeInitiator(undefined), 'unknown');
  assert.equal(describeInitiator(null), 'unknown');
});

// break: re-fetching without Referer/Origin and misdiagnosing a 403 as a dead link
test('buildRefetchHeaders: forwards referer, origin, user-agent and cookie only', () => {
  const headers = {
    Referer: 'http://local.test/watch',
    Origin: 'http://local.test',
    'User-Agent': 'ProbeUA',
    Cookie: 'sid=1',
    'Accept-Encoding': 'gzip',
    'X-Secret': 'no',
  };
  assert.deepEqual(buildRefetchHeaders(headers), {
    referer: 'http://local.test/watch',
    origin: 'http://local.test',
    'user-agent': 'ProbeUA',
    cookie: 'sid=1',
  });
});

// break: sending lowercase lookups that miss the browser's capitalised header names
test('buildRefetchHeaders: header lookup is case-insensitive', () => {
  assert.deepEqual(buildRefetchHeaders({ REFERER: 'http://local.test/' }), { referer: 'http://local.test/' });
});

// break: throwing when no request headers were recorded
test('buildRefetchHeaders: missing headers yield an empty object', () => {
  assert.deepEqual(buildRefetchHeaders({}), {});
  assert.deepEqual(buildRefetchHeaders(undefined), {});
});

// break: network-supplied URLs being injected into the report as live markup
test('escapeHtml: escapes all five dangerous characters', () => {
  assert.equal(escapeHtml(`<script>"x"&'`), '&lt;script&gt;&quot;x&quot;&amp;&#39;');
});

const SAMPLE_HIT = {
  url: 'http://local.test/hls/master.m3u8',
  status: 200,
  mimeType: 'application/vnd.apple.mpegurl',
  initiator: 'player.js:812 loadStream',
  detectedBy: 'url',
  count: 1,
  refetch: { ok: true, status: 200 },
  playlist: {
    valid: true,
    kind: 'master',
    live: false,
    segments: 0,
    totalDuration: 0,
    encrypted: false,
    keys: [],
    variants: [{ bandwidth: 1280000, resolution: '1280x720', codecs: 'avc1.4d401f', url: 'http://local.test/hls/720.m3u8' }],
    warnings: [],
  },
};

// break: the encryption key URL taking an unescaped branch in the facts table
test('renderHtmlReport: a hostile EXT-X-KEY url is escaped too', () => {
  const hostile = {
    ...SAMPLE_HIT,
    playlist: {
      ...SAMPLE_HIT.playlist,
      encrypted: true,
      keys: [{ method: 'AES-128', url: 'http://local.test/"><script>alert(3)</script>.key' }],
    },
  };
  const html = renderHtmlReport({ hits: [hostile], meta: { requests: 1, responses: 1, sniffed: 0, startUrl: null } });
  assert.ok(!html.includes('<script>alert(3)</script>'), 'raw key url leaked into the report');
  assert.ok(html.includes('&lt;script&gt;alert(3)&lt;/script&gt;'), 'expected the escaped key url');
});

// break: the report rendering an attacker-controlled URL as executable markup
test('renderHtmlReport: a hostile URL is escaped, not embedded as markup', () => {
  const hostile = {
    ...SAMPLE_HIT,
    url: 'http://local.test/"><script>alert(1)</script>.m3u8',
    initiator: '<img src=x onerror=alert(2)>',
  };
  const html = renderHtmlReport({ hits: [hostile], meta: { requests: 1, responses: 1, sniffed: 0, startUrl: null } });
  assert.ok(!html.includes('<script>alert(1)</script>'), 'raw script tag leaked into the report');
  assert.ok(!html.includes('<img src=x onerror=alert(2)>'), 'raw img tag leaked into the report');
  assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'), 'expected the escaped form');
});

// break: a report that hides the very address the tool exists to surface
test('renderHtmlReport: contains the playlist address and its variant addresses', () => {
  const html = renderHtmlReport({ hits: [SAMPLE_HIT], meta: { requests: 5, responses: 4, sniffed: 2, startUrl: 'http://local.test/' } });
  assert.ok(html.includes('http://local.test/hls/master.m3u8'));
  assert.ok(html.includes('http://local.test/hls/720.m3u8'));
  assert.ok(html.includes('1280x720'));
});

// break: the report pulling remote assets, so it is not self-contained offline
test('renderHtmlReport: is self-contained', () => {
  const html = renderHtmlReport({ hits: [SAMPLE_HIT], meta: { requests: 1, responses: 1, sniffed: 0, startUrl: null } });
  assert.ok(!/<script[^>]+\bsrc=/i.test(html), 'external script reference');
  assert.ok(!/<link\b/i.test(html), 'external stylesheet reference');
});

// break: an empty run rendering a broken page instead of saying nothing was found
test('renderHtmlReport: zero hits still reports the observation counts', () => {
  const html = renderHtmlReport({ hits: [], meta: { requests: 12, responses: 10, sniffed: 4, startUrl: null } });
  assert.ok(html.includes('12'), 'request count missing');
  assert.ok(html.includes('10'), 'response count missing');
});

// break: a live stream producing hundreds of identical rows
test('dedupeHits: repeated URLs collapse to one entry with a count', () => {
  const hits = [
    { url: 'http://h/live.m3u8', initiator: 'a.js:1' },
    { url: 'http://h/live.m3u8', initiator: 'b.js:2' },
    { url: 'http://h/live.m3u8', initiator: 'c.js:3' },
    { url: 'http://h/other.m3u8', initiator: 'a.js:1' },
  ];
  const out = dedupeHits(hits);
  assert.equal(out.length, 2);
  assert.equal(out[0].url, 'http://h/live.m3u8');
  assert.equal(out[0].count, 3);
  assert.equal(out[0].initiator, 'a.js:1');
  assert.equal(out[1].count, 1);
});

// break: mutating the caller's hit objects
test('dedupeHits: does not mutate the input', () => {
  const hits = [{ url: 'http://h/a.m3u8', initiator: 'a.js:1' }];
  dedupeHits(hits);
  assert.equal(hits[0].count, undefined);
});

// break: a zero-hit run printing nothing, so "no playlists" is indistinguishable from "recorder never ran"
test('formatRunSummary: a zero-hit run still reports what was observed', () => {
  const s = formatRunSummary({ requests: 12, responses: 10, sniffed: 4, hits: 0 });
  assert.ok(s.includes('12'), s);
  assert.ok(s.includes('10'), s);
  assert.ok(s.includes('4'), s);
  assert.ok(/命中\s*0/.test(s), s);
});

// break: the summary reporting hits that were never observed
test('formatRunSummary: reports the hit count', () => {
  const s = formatRunSummary({ requests: 30, responses: 28, sniffed: 9, hits: 3 });
  assert.ok(/命中\s*3/.test(s), s);
});