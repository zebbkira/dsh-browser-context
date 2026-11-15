/** Version-pinned, read-only Melo selection capture; no selection creation or clipboard access. */

/** Fixed reader operation in a content-free failure response. */
export type WecomSelectionStage = 'editor' | 'abi' | 'permission' | 'selection' | 'indices' | 'text'

/** Descriptor-only member metadata; definitions are bounded static function source, never property values. */
export interface WecomSelectionMember {
  name: string
  type: 'undefined' | 'object' | 'function' | 'string' | 'number' | 'boolean' | 'symbol' | 'bigint' | 'accessor'
  depth: number
  definition?: string
}

/** Bounded selection descriptors, excluding private identifiers and property values. */
export interface WecomSelectionInfo {
  kind: 'object' | 'array'
  members: WecomSelectionMember[]
  truncated: boolean
  firstItem?: { members: WecomSelectionMember[], truncated: boolean }
}

/** Selected text or a fixed failure code; optional selection diagnostics contain descriptors only. */
export type WecomSelectionReply = { text: string } | {
  code: 'empty-selection' | 'too-large' | 'unsupported' | 'copy-denied' | 'failed'
  stage?: WecomSelectionStage
  selectionInfo?: WecomSelectionInfo
}

function readSelection(maxBytes: number): object {
  // Even the smallest nonempty text response needs twelve UTF-8 JSON bytes.
  if (maxBytes < 12) return { code: 'too-large' }
  let stage: WecomSelectionStage = 'editor'
  let originalSelection: object | undefined
  function bounded(value: object): object {
    return new TextEncoder().encode(JSON.stringify(value)).byteLength <= maxBytes ? value : { code: 'too-large' }
  }
  function selectionInfo(value: object): WecomSelectionInfo {
    let memberCount = 0
    let definitionCount = 0
    function membersOf(item: object): { members: WecomSelectionMember[], truncated: boolean } {
      const members: WecomSelectionMember[] = []
      let truncated = false
      const seen = new Set<string>()
      let current: object | null = item
      for (let depth = 0; current !== null && current !== Object.prototype && depth <= 3; depth += 1) {
        for (const name of Object.getOwnPropertyNames(current)) {
          if (seen.has(name)) continue
          seen.add(name)
          if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name) || name.length > 120
            || /credential|auth|token|cookie|session|user|private/i.test(name)
            || /^(?:id|uuid|docid|text|url|uri|href|opaqueid|constructor|__proto__|prototype)$/i.test(name)
            || /^w\d+_/i.test(name) || /^[a-f0-9]{24,}$/i.test(name)) continue
          if (memberCount >= 32) { truncated = true; continue }
          const found = Object.getOwnPropertyDescriptor(current, name)
          if (!found) continue
          const raw: unknown = 'value' in found ? found.value : undefined
          const type = 'value' in found ? typeof raw : 'accessor'
          const member: WecomSelectionMember = { name, type, depth }
          const method: unknown = type === 'function' ? raw : found.get ?? found.set
          if (typeof method === 'function') {
            const definition = Function.prototype.toString.call(method)
            if (definitionCount < 16 && new TextEncoder().encode(definition).byteLength <= 1024) {
              member.definition = definition
              definitionCount += 1
            } else truncated = true
          }
          members.push(member)
          memberCount += 1
        }
        current = Object.getPrototypeOf(current)
      }
      if (current !== null && current !== Object.prototype) truncated = true
      return { members, truncated }
    }
    const array = Array.isArray(value)
    let firstItem: WecomSelectionInfo['firstItem']
    if (array) {
      const first = Object.getOwnPropertyDescriptor(value, '0')
      const item: unknown = first && 'value' in first ? first.value : undefined
      if (object(item)) firstItem = membersOf(item)
    }
    const info: WecomSelectionInfo = { kind: array ? 'array' : 'object', ...membersOf(value) }
    if (firstItem) info.firstItem = firstItem
    return info
  }
  function failure(code: 'unsupported' | 'failed'): object {
    if (stage !== 'selection' || originalSelection === undefined) return { code, stage }
    try {
      return bounded({ code, stage, selectionInfo: selectionInfo(originalSelection) })
    } catch (error) {
      // Descriptor traps cannot expose raw guest exceptions or prevent a fixed failure reply.
      void error
      return { code: 'failed', stage }
    }
  }
  function descriptor(value: object, name: string): PropertyDescriptor | undefined {
    let current: object | null = value
    for (let depth = 0; current !== null && depth <= 4; depth += 1) {
      const found = Object.getOwnPropertyDescriptor(current, name)
      if (found) return found
      current = Object.getPrototypeOf(current)
    }
    return undefined
  }
  function data(value: object, name: string): unknown {
    const found = descriptor(value, name)
    return found && 'value' in found ? found.value : undefined
  }
  function object(value: unknown): value is object {
    return typeof value === 'object' && value !== null
  }
  function matches(value: unknown, source: string): value is (...args: unknown[]) => unknown {
    return typeof value === 'function'
      && Function.prototype.toString.call(value).replace(/\s/g, '') === source.replace(/\s/g, '')
  }
  try {
    const url = new URL(document.URL)
    if (url.protocol !== 'https:' || url.hostname !== 'doc.weixin.qq.com' || url.port !== ''
      || url.username !== '' || url.password !== '' || !url.pathname.startsWith('/doc/')) return failure('unsupported')
    const pad = data(window, 'pad')
    if (!object(pad)) return failure('unsupported')
    const editor = data(pad, 'editor')
    if (!object(editor) || data(editor, 'isMeloEditor') !== true) return failure('unsupported')
    stage = 'abi'
    const copyable = data(editor, 'isCopyable')
    const indices = data(editor, 'getIndexFromRange')
    const textReader = data(editor, 'getRefText')
    const selectionGetter = descriptor(editor, 'selection')?.get
    // These source checks intentionally support only the experimentally confirmed Melo version.
    if (!matches(copyable, 'isCopyable(){return this._docEnv.copyable}')
      || !matches(indices, 'getIndexFromRange(e){const t=this.state.getTextStream();return{first:t.getIndexFromGCP(e.begin()),last:t.getIndexFromGCP(e.end())}}')
      || !matches(textReader, 'getRefText(e){const t=this.factory.get(h.ygL);return t?t.getRefText(e):""}')
      || !matches(selectionGetter, 'get selection(){return this.state.selection}')) return failure('unsupported')
    stage = 'permission'
    const allowed = copyable.call(editor)
    if (allowed === false) return { code: 'copy-denied', stage }
    if (allowed !== true) return failure('failed')
    stage = 'selection'
    let selection = selectionGetter.call(editor)
    if (!object(selection)) return { code: 'empty-selection', stage }
    originalSelection = selection
    let coreRange: unknown
    try {
      coreRange = data(selection, '_coreRange')
    } catch (error) {
      // Proxy ranges can deny descriptor inspection while remaining valid SDK ranges.
      void error
    }
    if (object(coreRange)) {
      const coreReader = data(selection, 'getCoreRange')
      const rangesGetter = descriptor(selection, 'gcpRanges')?.get
      if (!matches(coreReader, 'getCoreRange(){return this._coreRange}')
        || !matches(rangesGetter, 'get gcpRanges(){const{tableCellGCPRanges:e}=this._coreRange;return e.length>0?e:this._coreRange.gcpRanges}')) return failure('unsupported')
      const unwrapped = rangesGetter.call(selection)
      if (!Array.isArray(unwrapped)) return failure('unsupported')
      selection = unwrapped
      originalSelection = unwrapped
    }
    const ranges: object[] = []
    if (Array.isArray(selection)) {
      const length = data(selection, 'length')
      if (typeof length !== 'number' || !Number.isSafeInteger(length) || length < 0 || length > 64) return failure('unsupported')
      if (length === 0) return { code: 'empty-selection', stage }
      for (let index = 0; index < length; index += 1) {
        const item = Object.getOwnPropertyDescriptor(selection, `${index}`)
        const range: unknown = item && 'value' in item ? item.value : undefined
        if (!object(range)) return failure('unsupported')
        ranges.push(range)
      }
    } else ranges.push(selection)
    // The confirmed SDK reader validates each original range before any text is read.
    const nonemptyRanges: object[] = []
    for (const range of ranges) {
      stage = 'indices'
      let result: unknown
      try {
        result = indices.call(editor, range)
      } catch (error) {
        if (!(error instanceof TypeError)) throw error
        stage = 'selection'
        return failure('unsupported')
      }
      if (!object(result)) return failure('failed')
      const first = data(result, 'first')
      const last = data(result, 'last')
      if (typeof first !== 'number' || typeof last !== 'number' || !Number.isSafeInteger(first)
        || !Number.isSafeInteger(last) || first < 0 || last < first) return failure('failed')
      if (first !== last) nonemptyRanges.push(range)
    }
    const texts: string[] = []
    for (const range of nonemptyRanges) {
      stage = 'text'
      const text = textReader.call(editor, range)
      if (typeof text !== 'string') return failure('failed')
      if (text.length > 0) texts.push(text)
    }
    if (texts.length === 0) return { code: 'empty-selection', stage }
    return bounded({ text: texts.join('\n') })
  } catch (error) {
    // Guest exceptions cannot cross IPC with document values or original messages.
    void error
    return failure('failed')
  }
}

/** @param maxBytes - Nonnegative safe-integer UTF-8 budget for complete text JSON; control replies are exempt. @returns A fixed, self-contained script supporting only the confirmed Melo ABI. */
export function wecomSelectionScript(maxBytes: number): string {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) throw new Error('Invalid WeCom selection budget')
  return `(${readSelection.toString()})(${JSON.stringify(maxBytes)})`
}

function decodeSelectionInfo(value: unknown): WecomSelectionInfo {
  function record(value: unknown): Record<string, unknown> {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('Invalid WeCom selection reply')
    return value as Record<string, unknown>
  }
  let memberCount = 0
  let definitionCount = 0
  function members(value: unknown): { members: WecomSelectionMember[], truncated: boolean } {
    const input = record(value)
    if (!Array.isArray(input.members) || typeof input.truncated !== 'boolean') throw new Error('Invalid WeCom selection reply')
    const output = input.members.map((entry: unknown): WecomSelectionMember => {
      const member = record(entry)
      memberCount += 1
      if (memberCount > 32 || typeof member.name !== 'string' || member.name.length > 120
        || !/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(member.name)
        || /credential|auth|token|cookie|session|user|private/i.test(member.name)
        || /^(?:id|uuid|docid|text|url|uri|href|opaqueid|constructor|__proto__|prototype)$/i.test(member.name)
        || /^w\d+_/i.test(member.name) || /^[a-f0-9]{24,}$/i.test(member.name)
        || typeof member.depth !== 'number' || !Number.isInteger(member.depth) || member.depth < 0 || member.depth > 3) throw new Error('Invalid WeCom selection reply')
      const types = ['undefined', 'object', 'function', 'string', 'number', 'boolean', 'symbol', 'bigint', 'accessor'] as const
      const type = types.find(type => type === member.type)
      if (type === undefined) throw new Error('Invalid WeCom selection reply')
      const output: WecomSelectionMember = { name: member.name, type, depth: member.depth }
      if ('definition' in member) {
        definitionCount += 1
        if (definitionCount > 16 || (type !== 'function' && type !== 'accessor') || typeof member.definition !== 'string'
          || new TextEncoder().encode(member.definition).byteLength > 1024) throw new Error('Invalid WeCom selection reply')
        output.definition = member.definition
      }
      return output
    })
    return { members: output, truncated: input.truncated }
  }
  const input = record(value)
  if (input.kind !== 'object' && input.kind !== 'array') throw new Error('Invalid WeCom selection reply')
  const info: WecomSelectionInfo = { kind: input.kind, ...members(input) }
  if ('firstItem' in input) {
    if (input.kind !== 'array') throw new Error('Invalid WeCom selection reply')
    info.firstItem = members(input.firstItem)
  }
  return info
}

/** @param reply - Unknown IPC JSON string or decoded response. @returns Validated owned fields only; malformed input throws a fixed content-free error. */
export function decodeWecomSelectionReply(reply: unknown): WecomSelectionReply {
  try {
    const data: unknown = typeof reply === 'string' ? JSON.parse(reply) : reply
    if (typeof data !== 'object' || data === null || Array.isArray(data)) throw new Error('Invalid WeCom selection reply')
    if ('text' in data) {
      if (typeof data.text !== 'string' || data.text.length === 0 || 'code' in data || 'selectionInfo' in data) throw new Error('Invalid WeCom selection reply')
      return { text: data.text }
    }
    if (!('code' in data) || (data.code !== 'empty-selection' && data.code !== 'too-large'
      && data.code !== 'unsupported' && data.code !== 'copy-denied' && data.code !== 'failed')) throw new Error('Invalid WeCom selection reply')
    const code = data.code
    if (!('stage' in data)) {
      if ('selectionInfo' in data) throw new Error('Invalid WeCom selection reply')
      return { code }
    }
    if (data.stage !== 'editor' && data.stage !== 'abi' && data.stage !== 'permission'
      && data.stage !== 'selection' && data.stage !== 'indices' && data.stage !== 'text') throw new Error('Invalid WeCom selection reply')
    if ('selectionInfo' in data) {
      if ((code !== 'unsupported' && code !== 'failed') || data.stage !== 'selection') throw new Error('Invalid WeCom selection reply')
      return { code, stage: data.stage, selectionInfo: decodeSelectionInfo(data.selectionInfo) }
    }
    return { code, stage: data.stage }
  } catch (error) {
    // Parsing and hostile property errors use the same content-free decoder failure.
    void error
    throw new Error('Invalid WeCom selection reply')
  }
}
