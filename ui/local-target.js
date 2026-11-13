function isLoopbackHost(host) {
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
  return isLoopbackHost(parsed.hostname.toLowerCase().replace(/\.$/, ''));
}
