/** Copy for explicit local HTML opening actions. */
export const localHtmlNamespace = 'referenceBrowserLocalHtml'
export const localHtmlEn = {
  open: 'Open in reference browser',
  unavailable: 'Cannot read this HTML file. Check the path and access, then try again',
  failed: 'Could not open the HTML file. Try again',
} as const
export const localHtmlZh: Record<keyof typeof localHtmlEn, string> = {
  open: '在引用浏览器中打开',
  unavailable: '无法读取此 HTML 文件，请检查路径和访问权限后重试',
  failed: '无法打开 HTML 文件，请重试',
}

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap { referenceBrowserLocalHtml: keyof typeof localHtmlEn }
}
