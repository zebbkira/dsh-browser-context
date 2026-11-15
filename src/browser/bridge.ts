/** Structural face of stock Desktop protocol 1; no Electron, IPC or Node module imports. */
import type { Branded } from '@deepseek-ai/dsh-brand'

/** Opaque reservation issued by the stock Desktop shell. */
export type GuestLease = Branded<'ReferenceBrowserGuestLease'>

/** Main-approved identity and process-lifetime storage partition. */
export interface GuestReservation { readonly lease: GuestLease; readonly partition: string }

/** Unmodified stock window.dshDesktop.browser protocol used by this plugin's own guest. */
export interface BrowserBridge {
  acquire(workspace: string): Promise<GuestReservation>
  release(lease: GuestLease): Promise<void>
  onOpenRequested(lease: GuestLease, listener: (url: string) => void): () => void
}

/** The DOM native guest is held only by its owning carrier, never by actions-slot consumers. */
export interface OwnedWebview extends HTMLElement {
  loadURL(url: string): Promise<void>
  getURL(): string
  getTitle(): string
  isLoading(): boolean
  clearHistory(): void
  executeJavaScript(code: string): Promise<unknown>
  capturePage(): Promise<{ toDataURL(): string }>
}

/** @returns the stock main-window bridge, or absence for Web and incompatible carriers. */
export function browserBridge(): BrowserBridge | undefined {
  const desktop = (globalThis as typeof globalThis & {
    dshDesktop?: { readonly protocolVersion?: number; readonly browser?: BrowserBridge }
  }).dshDesktop
  const bridge = desktop?.protocolVersion === 1 ? desktop.browser : undefined
  return bridge !== undefined && typeof bridge.acquire === 'function' && typeof bridge.release === 'function'
    && typeof bridge.onOpenRequested === 'function' ? bridge : undefined
}
