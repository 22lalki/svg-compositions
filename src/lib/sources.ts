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

/** Логический объект исходника: имя (из разметки) и номера фигур в порядке документа */
export type SourceObject = { name: string | null; shapes: number[] }

type Annotation = { shapeCount: number; objects: Array<{ name: string; shapes: string }> }

let annotations: Promise<Record<string, Annotation>> | null = null

/** "9-22,25" → [9..22, 25] */
export function parseShapeRanges(spec: string): number[] {
  return spec
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .flatMap((part) => {
      const [a, b] = part.split('-').map(Number)
      if (!Number.isInteger(a)) return []
      return b === undefined ? [a!] : Array.from({ length: b - a! + 1 }, (_, k) => a! + k)
    })
}

/**
 * Разметка объектов встроенного исходника (public/sources/objects.json): подготовлена заранее
 * с помощью ИИ по картинке и проверена вручную (scripts/annotate.mjs).
 * null — разметки нет или она не совпадает с файлом (тогда работает эвристика).
 */
export async function loadSourceObjects(meta: SourceMeta, shapeCount: number): Promise<SourceObject[] | null> {
  if (meta.kind !== 'builtin') return null
  annotations ??= fetch('/sources/objects.json')
    .then((r) => (r.ok ? (r.json() as Promise<Record<string, Annotation>>) : {}))
    .catch(() => ({}))
  const entry = (await annotations)[meta.id]
  if (!entry || entry.shapeCount !== shapeCount) return null
  const seen = new Set<number>()
  const list: SourceObject[] = []
  for (const o of entry.objects) {
    const shapes = parseShapeRanges(o.shapes).filter((i) => i >= 0 && i < shapeCount && !seen.has(i))
    shapes.forEach((i) => seen.add(i))
    if (shapes.length) list.push({ name: o.name, shapes })
  }
  // Фигуры, не попавшие в разметку, — отдельными безымянными объектами
  for (let i = 0; i < shapeCount; i++) if (!seen.has(i)) list.push({ name: null, shapes: [i] })
  return list
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
