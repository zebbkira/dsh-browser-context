/** Validate deployment limits at both plugin load sites; no implicit defaults. */
export function validateConfig(config) {
  for (const field of ['maxTextBytes', 'maxImageBytes', 'subtitleRequestTimeoutMs']) {
    if (!Number.isSafeInteger(config[field]) || config[field] <= 0) {
      throw new TypeError(`dsh-browser-context: ${field} must be a positive safe integer`)
    }
  }
  if (config.subtitleRequestTimeoutMs > 2147483647) throw new TypeError('dsh-browser-context: subtitleRequestTimeoutMs exceeds the browser timer range')
  return config
}
