/** Copy for the independently registered reference-browser page. */
export const en = {
  title: 'Reference browser', description: 'Browse and explicitly quote page content',
  address: 'HTTP(S) address', go: 'Open page', reload: 'Reload page',
  start: 'Enter an HTTP(S) address to open a page', loading: 'Opening…',
  'error.desktop-only': 'This page requires DSH Desktop with the Browser bridge',
  'error.invalid-address': 'Enter an HTTP(S) address without a username or password',
  'error.load-failed': 'The page could not load. Reload it or try another address',
} as const
export const zh: Record<keyof typeof en, string> = {
  title: '引用浏览器', description: '浏览网页并明确选取引用内容',
  address: 'HTTP(S) 地址', go: '打开页面', reload: '重新加载',
  start: '输入 HTTP(S) 地址打开页面', loading: '正在打开…',
  'error.desktop-only': '此页面需要支持浏览器桥接的 DSH 桌面端',
  'error.invalid-address': '请输入不含用户名和密码的 HTTP(S) 地址',
  'error.load-failed': '页面加载失败，请重载或尝试其他地址',
}

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap { referenceBrowser: keyof typeof en }
}
