// 这个工具只服务于"你自己的本地站点"。任意第三方地址一律拒绝，别把它变成抽流器。
// 桥接和前端共用这一份判据，避免两边的规则各自漂移。
export function isLocalTarget(url) {
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
export function canReachBridge(href) {
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