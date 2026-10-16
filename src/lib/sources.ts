import type { SourceMeta } from '../types'
import { loadUserSourceText } from './storage'

/** Текст исходника: встроенный — из public/sources, загруженный — из IndexedDB */
export async function loadSourceText(meta: SourceMeta): Promise<string> {
  if (meta.kind === 'user') {
    const text = await loadUserSourceText(meta.id)
    if (!text) throw new Error('файл не найден в хранилище браузера')
    return text
  }
  const r = await fetch(`/sources/${meta.file}`)
  if (!r.ok) throw new Error(`${meta.file}: HTTP ${r.status}`)
  return r.text()
}

const objectUrls = new Map<string, Promise<string>>()

/** URL превью исходника для <img>: для загруженных — blob: из IndexedDB (кешируется) */
export function sourceThumbUrl(meta: SourceMeta): Promise<string> {
  if (meta.kind !== 'user') return Promise.resolve(`/sources/${meta.file}`)
  let url = objectUrls.get(meta.id)
  if (!url) {
    url = loadSourceText(meta).then((text) => URL.createObjectURL(new Blob([text], { type: 'image/svg+xml' })))
    objectUrls.set(meta.id, url)
    url.catch(() => objectUrls.delete(meta.id))
  }
  return url
}

export function releaseSourceThumb(id: string) {
  const url = objectUrls.get(id)
  objectUrls.delete(id)
  void url?.then((u) => URL.revokeObjectURL(u)).catch(() => undefined)
}
