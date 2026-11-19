/** Copy for the independently registered reference-browser page. */
export const en = {
  title: 'Reference browser', description: 'Browse and explicitly quote page content',
  localAddress: 'HTML file',
  'error.local-config': 'Local HTML settings are not ready. Fully quit and restart DSH, then reopen the file.',
  'error.local-read': 'The HTML file or a declared asset could not be read. Check its path and access, then retry.',
  'error.local-unsupported': 'This HTML uses a local dependency form that is not supported. Use a self-contained HTML file.',
  'error.local-limit': 'The complete HTML package exceeds the configured limit. Reduce its size or adjust local HTML settings.',
  'error.local-invalid': 'The HTML file or a dependency has invalid encoding, a disallowed path, or incomplete bytes. Check it and retry.',
  'error.local-changed': 'The HTML frame navigated or changed while being read. Reload the original file before annotating.',
  'error.local-closed': 'The local HTML view was closed. Reopen the file to continue.',
  'error.local-timeout': 'Local HTML loading or interaction timed out. Retry, or check its external resources.',
  'error.local-frame': 'The isolated HTML view could not become ready. Reload it or use a self-contained HTML file.',
  address: 'HTTP(S) address', go: 'Open page', reload: 'Reload page',
  start: 'Enter an HTTP(S) address to open a page', loading: 'Opening…',
  'error.desktop-only': 'This page requires DSH Desktop with the Browser bridge',
  'error.invalid-address': 'Enter an HTTP(S) address without a username or password',
  'error.load-failed': 'The page could not load. Reload it or try another address',
} as const
export const zh: Record<keyof typeof en, string> = {
  title: '引用浏览器', description: '浏览网页并明确选取引用内容',
  localAddress: 'HTML 文件',
  'error.local-config': '本地 HTML 配置尚未就绪，请完全退出并重启 DSH，再重新打开文件',
  'error.local-read': '无法读取 HTML 或它声明的资源，请检查路径和读取权限后重试',
  'error.local-unsupported': '此 HTML 使用了尚未支持的本地依赖形式，请改用自包含的 HTML 文件',
  'error.local-limit': 'HTML 和资源的完整载荷超过配置上限，请缩小文件或调整本地 HTML 限制',
  'error.local-invalid': 'HTML 或资源的编码、路径或完整性无效，请检查文件后重试',
  'error.local-changed': 'HTML 内页发生了导航或变化，请重新加载原文件后再批注',
  'error.local-closed': '本地 HTML 页面已关闭，请重新打开文件后继续',
  'error.local-timeout': '本地 HTML 加载或交互超时，请重试或检查页面使用的外部资源',
  'error.local-frame': '隔离的 HTML 页面未能就绪，请重载或改用自包含的 HTML 文件',
  address: 'HTTP(S) 地址', go: '打开页面', reload: '重新加载',
  start: '输入 HTTP(S) 地址打开页面', loading: '正在打开…',
  'error.desktop-only': '此页面需要支持浏览器桥接的 DSH 桌面端',
  'error.invalid-address': '请输入不含用户名和密码的 HTTP(S) 地址',
  'error.load-failed': '页面加载失败，请重载或尝试其他地址',
}

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap { referenceBrowser: keyof typeof en }
}
