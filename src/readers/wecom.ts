/** Explicit, read-only snapshots of recognized WeCom editors; never a complete document export. */

/** Minimum complete UTF-8 JSON budget for the fixed too-large control reply. */
export const wecomMinimumReplyBytes = 22

const ROOT_NAMES = ['pad', 'pad.editor', 'pad.doc', 'pad.document', 'pad.model', 'pad.getText', 'pad.getContents', 'pad.getDocument', 'pad.editor.getText', 'pad.editor.getContents', 'pad.editor.getDocument', 'pad.editor.model', 'pad.editor.doc', 'pad.editor._doc', 'App', 'App.editor'] as const
const READER_NAMES = ['getRefText', 'getCopyContent', 'isCopyable', 'getRangeFromIndex', 'getIndexFromRange', 'getDocumentBox', 'readContext', 'selection', 'wordCount', 'statisticInfo'] as const
const COUNT_NAMES = ['iframes', 'accessibleFrames', 'canvases', 'editableNodes', 'textboxes', 'paragraphs', 'headings', 'tables'] as const
const ROOT_TYPES = ['absent', 'accessor', 'undefined', 'object', 'function', 'string', 'number', 'boolean', 'symbol', 'bigint'] as const

/** One bounded application member description, without its value or function source. */
export interface WecomEditorMember {
  name: string
  type: Exclude<typeof ROOT_TYPES[number], 'absent'>
  depth: number
  arity?: number
}

/** A bounded member inventory; truncation never describes document text. */
export interface WecomMemberInventory {
  members: WecomEditorMember[]
  truncated: boolean
}

/** Static definition of one fixed reader, never an executed function or a captured document value. */
export type WecomReaderDefinition = { name: typeof READER_NAMES[number] } & (
  | { status: 'missing' | 'oversized' }
  | { status: 'available'; source: string }
)

/** Application structure and fixed reader definitions; getters are not invoked and document values are not returned. */
export interface WecomDiagnostic {
  reason: 'model-not-found' | 'empty' | 'read-denied'
  counts: Record<typeof COUNT_NAMES[number], number>
  knownWindowRoots: { name: typeof ROOT_NAMES[number], present: boolean, type: typeof ROOT_TYPES[number] }[]
  scriptNames: string[]
  editorMembers: WecomEditorMember[]
  editorMembersTruncated: boolean
  modelMembers: { root: WecomMemberInventory; modelWrapperMgr: WecomMemberInventory }
  readerDefinitions: WecomReaderDefinition[]
}

/** Validated guest response. The only supported coverage is the already loaded editor text. */
export type WecomReply =
  | { status: 'ok', url: string, title: string, text: string, format: 'text', coverage: 'loaded' }
  | { status: 'no-document', diagnostic: WecomDiagnostic }
  | { status: 'too-large' }

/** @param url - Candidate page URL. @returns Whether it is an HTTPS WeCom /doc/ document. */
export function isWecomDocument(url: string): boolean {
  try {
    const parsed = new URL(url)
    return parsed.protocol === 'https:' && parsed.hostname === 'doc.weixin.qq.com'
      && parsed.port === '' && parsed.username === '' && parsed.password === '' && parsed.pathname.startsWith('/doc/')
  } catch (error) {
    // Invalid URLs are not document candidates.
    void error
    return false
  }
}

function readWecom(maxBytes: number, rootNames: readonly string[], readerNames: readonly string[]): object {
  function bounded(value: object): object {
    return new TextEncoder().encode(JSON.stringify(value)).byteLength <= maxBytes ? value : { status: 'too-large' }
  }
  const editorSelector = '.ProseMirror,.ql-editor,[data-slate-editor="true"],[data-lexical-editor="true"]'
  const excluded = 'script,style,noscript,template,input,textarea,select,button,form,nav,header,footer,iframe,canvas,[role="toolbar"],[role="navigation"],[hidden],[aria-hidden="true"]'
  const denied = '[data-can-copy="false"],[data-can-read="false"],[data-copy-permission="denied"],[data-read-permission="denied"],[data-copy-permission="false"],[data-read-permission="false"]'
  const url = new URL(document.URL)
  const eligible = url.protocol === 'https:' && url.hostname === 'doc.weixin.qq.com' && url.port === ''
    && url.username === '' && url.password === '' && url.pathname.startsWith('/doc/')
  const roots = eligible ? Array.from(document.querySelectorAll(editorSelector)).filter(root =>
    root !== document.body && root !== document.documentElement && !root.closest(excluded)) : []
  const readDenied = eligible && document.querySelector(denied) !== null
  function visible(element: Element): boolean {
    for (let current: Element | null = element; current; current = current.parentElement) {
      const style = window.getComputedStyle(current)
      if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse') return false
    }
    return true
  }
  function textOf(node: Node): string {
    if (node.nodeType === 3) return node.nodeValue ?? ''
    if (!(node instanceof Element) || node.matches(excluded) || !visible(node)
      || (node.matches('[role="textbox"]') && !node.matches(editorSelector))) return ''
    if (node.tagName === 'BR') return '\n'
    const text = Array.from(node.childNodes, textOf).join('')
    return /^(P|DIV|H[1-6]|LI|TR|BLOCKQUOTE|PRE)$/.test(node.tagName) ? `${text}\n` : text
  }
  if (!readDenied) {
    // Nested editor markers describe one candidate, not duplicate snapshots.
    for (const root of roots.filter(root => !root.parentElement?.closest(editorSelector))) {
      const text = textOf(root).trim()
      if (text) return bounded({ status: 'ok', url: document.URL, title: document.title, text, format: 'text', coverage: 'loaded' })
    }
  }
  const count = (selector: string) => document.querySelectorAll(selector).length
  let accessibleFrames = 0
  for (const frame of document.querySelectorAll('iframe')) {
    try {
      if (frame.contentDocument !== null) accessibleFrames += 1
    } catch (error) {
      // Inaccessible frame documents contribute no accessible-frame count.
      void error
    }
  }
  const counts = {
    iframes: count('iframe'), accessibleFrames, canvases: count('canvas'),
    editableNodes: count('[contenteditable="true"],' + editorSelector), textboxes: count('[role="textbox"],input,textarea'),
    paragraphs: count('p'), headings: count('h1,h2,h3,h4,h5,h6'), tables: count('table'),
  }
  // Frame contents are deliberately unsupported in the initial snapshot reader.
  function descriptorOf(owner: object, key: string): PropertyDescriptor | undefined {
    let current: object | null = owner
    // A fixed depth bounds application-prototype lookup; no property names are enumerated.
    for (let depth = 0; current !== null && depth < 4; depth += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(current, key)
      if (descriptor !== undefined) return descriptor
      current = Object.getPrototypeOf(current)
    }
    return undefined
  }
  const knownWindowRoots = rootNames.map(name => {
    let owner: object = window
    const parts = name.split('.')
    for (const [index, part] of parts.entries()) {
      const descriptor = descriptorOf(owner, part)
      if (descriptor === undefined) return { name, present: false, type: 'absent' }
      if (index === parts.length - 1) return { name, present: true, type: 'value' in descriptor ? typeof descriptor.value : 'accessor' }
      if (!('value' in descriptor)) return { name, present: false, type: 'absent' }
      const next: unknown = descriptor.value
      if (next === null || (typeof next !== 'object' && typeof next !== 'function')) return { name, present: false, type: 'absent' }
      owner = next
    }
    return { name, present: false, type: 'absent' }
  })
  function dataMember(owner: unknown, key: string): unknown {
    if (owner === null || (typeof owner !== 'object' && typeof owner !== 'function')) return undefined
    const descriptor = descriptorOf(owner, key)
    return descriptor !== undefined && 'value' in descriptor ? descriptor.value : undefined
  }
  function membersOf(owner: unknown, limit: number): WecomMemberInventory {
    const members: WecomEditorMember[] = []
    if (owner === null || (typeof owner !== 'object' && typeof owner !== 'function') || owner instanceof Node) return { members, truncated: false }
    let current: object | null = owner
    const seen = new Set<string>()
    for (let depth = 0; current !== null && current !== Object.prototype && depth < 4; depth += 1) {
      for (const name of Object.getOwnPropertyNames(current)) {
        if (seen.has(name)) continue
        seen.add(name)
        if (!/^[A-Za-z_$][A-Za-z0-9_$]{0,63}$/.test(name)
          || /auth|token|cookie|storage|secret|credential|password|account|user|profile|session|private|permission/i.test(name)
          || /^(?:constructor|__proto__|prototype)$|^w\d+_|^[a-f\d]{16,}$/i.test(name)) continue
        const descriptor = Object.getOwnPropertyDescriptor(current, name)
        if (descriptor === undefined) continue
        if (members.length === limit) return { members, truncated: true }
        const value: unknown = 'value' in descriptor ? descriptor.value : undefined
        const member: WecomEditorMember = { name, depth, type: 'value' in descriptor ? typeof value : 'accessor' }
        if (typeof value === 'function') {
          const length: unknown = Object.getOwnPropertyDescriptor(value, 'length')?.value
          if (typeof length === 'number' && Number.isSafeInteger(length) && length >= 0 && length <= 32) member.arity = length
        }
        members.push(member)
      }
      current = Object.getPrototypeOf(current)
    }
    return { members, truncated: false }
  }
  const editorValue = dataMember(dataMember(window, 'pad'), 'editor')
  const editorInventory = membersOf(editorValue, 192)
  const editorMembers = editorInventory.members
  const editorMembersTruncated = editorInventory.truncated
  const modelMembers = {
    root: membersOf(dataMember(editorValue, 'root'), 64),
    modelWrapperMgr: membersOf(dataMember(editorValue, 'modelWrapperMgr'), 64),
  }
  const readerDefinitions = readerNames.map(name => {
    if (editorValue === null || (typeof editorValue !== 'object' && typeof editorValue !== 'function')) return { name, status: 'missing' }
    const descriptor = descriptorOf(editorValue, name)
    const definition: unknown = descriptor === undefined ? undefined : 'value' in descriptor ? descriptor.value : descriptor.get
    if (typeof definition !== 'function') return { name, status: 'missing' }
    // Inspect the fixed reader's code; never evaluate its source or invoke its getter.
    const source = Function.prototype.toString.call(definition)
    return new TextEncoder().encode(source).byteLength > 2048
      ? { name, status: 'oversized' } : { name, status: 'available', source }
  })
  const scriptNames: string[] = []
  for (const script of document.querySelectorAll('script[src]')) {
    const src = script.getAttribute('src')
    if (!src) continue
    try {
      const parsed = new URL(src, document.URL)
      const basename = parsed.pathname.split('/').at(-1) ?? ''
      if ((parsed.protocol === 'https:' || parsed.protocol === 'http:') && /^[A-Za-z0-9_-][A-Za-z0-9_.-]*\.js$/.test(basename)
        && basename.length <= 120 && !scriptNames.includes(basename)) scriptNames.push(basename)
    } catch (error) {
      // Invalid resource addresses contribute no renderer identifier.
      void error
    }
    if (scriptNames.length === 16) break
  }
  return bounded({ status: 'no-document', diagnostic: {
    reason: readDenied ? 'read-denied' : roots.length > 0 ? 'empty' : 'model-not-found', counts, knownWindowRoots, scriptNames, editorMembers, editorMembersTruncated, modelMembers, readerDefinitions,
  } })
}

/** @param maxBytes - Complete UTF-8 JSON budget, at least the 22-byte rejection reply. @returns A fixed self-contained read-only guest script. */
export function wecomDocumentScript(maxBytes: number): string {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < wecomMinimumReplyBytes) throw new Error('Invalid WeCom reply budget')
  return `(${readWecom.toString()})(${JSON.stringify(maxBytes)},${JSON.stringify(ROOT_NAMES)},${JSON.stringify(READER_NAMES)})`
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('Invalid WeCom reply')
  return value as Record<string, unknown>
}

function decodeInventory(rawMembers: unknown, truncated: unknown, limit: number): WecomMemberInventory {
  if (!Array.isArray(rawMembers) || rawMembers.length > limit || typeof truncated !== 'boolean') throw new Error('Invalid WeCom reply')
  const members = rawMembers.map((raw: unknown): WecomEditorMember => {
    const member = record(raw)
    const name = member.name
    const type = ROOT_TYPES.find(type => type === member.type)
    const depth = member.depth
    if (typeof name !== 'string' || !/^[A-Za-z_$][A-Za-z0-9_$]{0,63}$/.test(name)
      || /auth|token|cookie|storage|secret|credential|password|account|user|profile|session|private|permission/i.test(name)
      || /^(?:constructor|__proto__|prototype)$|^w\d+_|^[a-f\d]{16,}$/i.test(name)
      || type === undefined || type === 'absent' || typeof depth !== 'number' || !Number.isSafeInteger(depth) || depth < 0 || depth > 3) throw new Error('Invalid WeCom reply')
    const result: WecomEditorMember = { name, type, depth }
    if (member.arity !== undefined) {
      if (type !== 'function' || typeof member.arity !== 'number' || !Number.isSafeInteger(member.arity) || member.arity < 0 || member.arity > 32) throw new Error('Invalid WeCom reply')
      result.arity = member.arity
    }
    return result
  })
  if (truncated && members.length !== limit) throw new Error('Invalid WeCom reply')
  return { members, truncated }
}

/** @param reply - Unknown IPC result, either a JSON string or decoded object. @returns Only validated owned fields; malformed data throws a fixed content-free error. */
export function decodeWecomReply(reply: unknown): WecomReply {
  try {
    const data = record(typeof reply === 'string' ? JSON.parse(reply) : reply)
    if (data.status === 'too-large') return { status: 'too-large' }
    if (data.status === 'ok') {
      if (typeof data.url !== 'string' || !isWecomDocument(data.url) || typeof data.title !== 'string'
        || typeof data.text !== 'string' || !data.text.trim() || data.format !== 'text' || data.coverage !== 'loaded') throw new Error('Invalid WeCom reply')
      return { status: 'ok', url: data.url, title: data.title, text: data.text, format: 'text', coverage: 'loaded' }
    }
    if (data.status !== 'no-document') throw new Error('Invalid WeCom reply')
    const diagnostic = record(data.diagnostic)
    if (diagnostic.reason !== 'model-not-found' && diagnostic.reason !== 'empty' && diagnostic.reason !== 'read-denied') throw new Error('Invalid WeCom reply')
    const rawCounts = record(diagnostic.counts)
    const counts = { iframes: 0, accessibleFrames: 0, canvases: 0, editableNodes: 0, textboxes: 0, paragraphs: 0, headings: 0, tables: 0 }
    for (const key of COUNT_NAMES) {
      const value = rawCounts[key]
      if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new Error('Invalid WeCom reply')
      counts[key] = value
    }
    const rawRoots = diagnostic.knownWindowRoots
    if (!Array.isArray(rawRoots) || rawRoots.length !== ROOT_NAMES.length) throw new Error('Invalid WeCom reply')
    const knownWindowRoots = ROOT_NAMES.map((name, index) => {
      const value = record(rawRoots[index])
      const type = ROOT_TYPES.find(type => type === value.type)
      if (value.name !== name || typeof value.present !== 'boolean' || type === undefined || value.present === (type === 'absent')) throw new Error('Invalid WeCom reply')
      return { name, present: value.present, type }
    })
    const names = diagnostic.scriptNames
    if (!Array.isArray(names) || names.length > 16) throw new Error('Invalid WeCom reply')
    const scriptNames = names.map((name: unknown) => {
      if (typeof name !== 'string' || name.length > 120 || !/^[A-Za-z0-9_-][A-Za-z0-9_.-]*\.js$/.test(name)) throw new Error('Invalid WeCom reply')
      return name
    })
    const editor = decodeInventory(diagnostic.editorMembers, diagnostic.editorMembersTruncated, 192)
    const rawModels = record(diagnostic.modelMembers)
    const root = record(rawModels.root)
    const manager = record(rawModels.modelWrapperMgr)
    const modelMembers = {
      root: decodeInventory(root.members, root.truncated, 64),
      modelWrapperMgr: decodeInventory(manager.members, manager.truncated, 64),
    }
    const rawDefinitions = diagnostic.readerDefinitions
    if (!Array.isArray(rawDefinitions) || rawDefinitions.length !== READER_NAMES.length) throw new Error('Invalid WeCom reply')
    const readerDefinitions = READER_NAMES.map((name, index): WecomReaderDefinition => {
      const definition = record(rawDefinitions[index])
      if (definition.name !== name) throw new Error('Invalid WeCom reply')
      if (definition.status === 'missing' || definition.status === 'oversized') return { name, status: definition.status }
      if (definition.status !== 'available' || typeof definition.source !== 'string' || definition.source.length === 0
        || new TextEncoder().encode(definition.source).byteLength > 2048) throw new Error('Invalid WeCom reply')
      return { name, status: 'available', source: definition.source }
    })
    return { status: 'no-document', diagnostic: { reason: diagnostic.reason, counts, knownWindowRoots, scriptNames, editorMembers: editor.members, editorMembersTruncated: editor.truncated, modelMembers, readerDefinitions } }
  } catch (error) {
    // Parser and hostile IPC property errors must not expose raw document data.
    void error
    throw new Error('Invalid WeCom reply')
  }
}
