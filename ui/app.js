import {
  DEFAULT_CONFIG, initialState, reduce, selectVisible, toRunRequest, serialize, hydrate, reorderIds,
} from './store.js';
import { demoEvents } from './demo.js';
import { exportJson, exportCsv, exportAddresses } from './export.js';
import { isLocalTarget } from './local-target.js';
import * as api from './api.js';

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

/* ---------------- rendering ---------------- */
const DETECT_LABEL = { url: 'URL', mime: 'mimeType', body: '响应体' };

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
  renderConfig();
  renderStatus();
  renderFilters();
  renderViews();
  renderBulk();
  renderHits();
  renderLog();
  if (drawerId) renderDrawer();
}

/* ---------------- wiring ---------------- */
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

boot();