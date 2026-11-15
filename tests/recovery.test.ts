import { expect, it } from 'vitest'
import type { Reference } from '../src/client/reference.ts'
import { createRecoveryStore } from '../src/client/store.ts'
import { makeReference } from '../src/client/reference.ts'
import { zh, en } from '../src/client/locales.ts'

it('keeps a different Browser tab failure when another same-session capture succeeds later', () => {
  const store = createRecoveryStore().create('same-session')
  const a = makeReference({ kind: 'selection', url: 'https://example.com/a', title: 'A', text: 'A quote' }, '2026-11-13T00:00:00Z')
  const b = makeReference({ kind: 'selection', url: 'https://example.com/b', title: 'B', text: 'B quote' }, '2026-11-13T00:00:01Z')
  store.actions.retain(b)
  store.actions.report('changed')
  store.actions.complete(a)
  expect(store.getSnapshot().recovery).toEqual(b)
  expect(store.getSnapshot().notice).toBe('changed')
  store.actions.complete(b)
  expect(store.getSnapshot().recovery).toBeUndefined()
  expect(store.getSnapshot().notice).toBe('added')
})

it.each(['loaded', 'not-loaded'] as const)('reports the actual subtitle status after admitting a %s video reference', subtitleStatus => {
  const store = createRecoveryStore().create('video-session')
  const reference = makeReference({ kind: 'video', url: 'https://www.bilibili.com/video/BV1xx411c7mD/',
    title: 'Video', text: 'Page information', format: 'text', coverage: 'loaded', subtitleStatus }, 'now')
  store.actions.retain(reference)
  store.actions.report('changed')
  store.actions.complete(reference)
  expect(store.getSnapshot().recovery).toBeUndefined()
  expect(store.getSnapshot().notice).toBe(subtitleStatus === 'not-loaded' ? 'videoAddedNoSubtitles' : 'added')
})

it.each([
  ['not-available', 'videoAddedIdentityUnavailable'], ['not-provided', 'videoAddedSubtitleUnavailable'],
  ['login-required', 'videoAddedLoginRequired'], ['access-denied', 'videoAddedAccessDenied'],
  ['request-failed', 'videoAddedSubtitleRequestFailed'], ['timeout', 'videoAddedSubtitleTimeout'],
] as const)('preserves the %s subtitle outcome in the completed notice', (subtitleReason, notice) => {
  const store = createRecoveryStore().create('video-session')
  const reference = makeReference({ kind: 'video', url: 'https://www.bilibili.com/video/BV1xx411c7mD/',
    title: 'Video', text: 'Page information', format: 'text', coverage: 'loaded', subtitleStatus: 'not-loaded', subtitleReason }, 'now')
  store.actions.complete(reference)
  expect(store.getSnapshot().notice).toBe(notice)
})

it.each([
  ['not-available', 'videoAddedIdentityUnavailable'], ['not-provided', 'videoAddedSubtitleUnavailable'],
] as const)('distinguishes %s from an empty-subtitle claim in both locales', (subtitleReason, notice) => {
  const store = createRecoveryStore().create('video-session')
  const reference = makeReference({ kind: 'video', url: 'https://www.bilibili.com/video/BV1xx411c7mD/',
    title: 'Video', text: 'Page information', format: 'text', coverage: 'loaded', subtitleStatus: 'not-loaded', subtitleReason }, 'now')
  store.actions.retain(reference)
  store.actions.complete(reference)
  expect(store.getSnapshot().recovery).toBeUndefined()
  expect(store.getSnapshot().notice).toBe(notice)
  if (subtitleReason === 'not-available') {
    expect(zh[notice]).toContain('无法确认当前视频或分P，未请求字幕文件')
    expect(zh[notice]).toContain('请刷新视频页后再试，尚未发送')
    expect(en[notice]).toContain('current video or part could not be confirmed')
    expect(en[notice]).toContain('No subtitle file was requested')
  } else {
    expect(zh[notice]).toContain('当前未取得可用字幕')
    expect(en[notice]).toContain('no usable subtitles were obtained')
    expect(zh[notice]).not.toContain('未请求字幕文件')
  }
})

it.each([undefined, 'not-available', 'not-provided'] as const)('does not replace a different pending failure with a %s partial-video success notice', subtitleReason => {
  const store = createRecoveryStore().create('same-session')
  const pending = makeReference({ kind: 'selection', url: 'https://example.com/pending', title: 'Pending', text: 'Retained' }, 'earlier')
  const video: Reference = makeReference({ kind: 'video', url: 'https://www.bilibili.com/video/BV1xx411c7mD/',
    title: 'Video', text: 'Page information', format: 'text', coverage: 'loaded', subtitleStatus: 'not-loaded', ...(subtitleReason === undefined ? {} : { subtitleReason }) }, 'later')
  store.actions.retain(pending)
  store.actions.report('changed')
  store.actions.complete(video)
  expect(store.getSnapshot().recovery).toEqual(pending)
  expect(store.getSnapshot().notice).toBe('changed')
})
