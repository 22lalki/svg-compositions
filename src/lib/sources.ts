import type { Rect, SourceMeta } from '../types'
import { analyzeSource, type SourceModel } from './extract'
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
 * Разметка объектов (public/sources/objects.json): подготовлена заранее с помощью ИИ по картинке
 * и проверена вручную (scripts/annotate.mjs). У встроенного исходника — по id. Загруженный файл получает
 * разметку, если это одна из встроенных иллюстраций: та же геометрия фигур, цвета могут отличаться
 * (unDraw дает перекрасить акцент перед скачиванием).
 * null — разметки нет или она не совпадает с файлом (тогда работает эвристика).
 */
export async function loadSourceObjects(meta: SourceMeta, model: SourceModel): Promise<SourceObject[] | null> {
  annotations ??= fetch('/sources/objects.json')
    .then((r) => (r.ok ? (r.json() as Promise<Record<string, Annotation>>) : {}))
    .catch(() => ({}))
  const all = await annotations
  const shapeCount = model.shapes.length
  if (meta.kind === 'builtin') {
    const entry = all[meta.id]
    return entry && entry.shapeCount === shapeCount ? objectsFrom(entry, shapeCount) : null
  }
  for (const [id, entry] of Object.entries(all)) {
    if (entry.shapeCount === shapeCount && (await sameDrawing(model, id))) return objectsFrom(entry, shapeCount)
  }
  return null
}

/** Положение фигуры в долях окна рисунка: не зависит от единиц и сдвига viewBox */
const relative = (b: Rect, vb: Rect) => [(b.x - vb.x) / vb.width, (b.y - vb.y) / vb.height, b.width / vb.width, b.height / vb.height]

/** Загруженный рисунок совпадает со встроенным исходником id: те же фигуры тех же видов на тех же местах */
async function sameDrawing(model: SourceModel, id: string): Promise<boolean> {
  const r = await fetch(`/sources/${id}.svg`).catch(() => null)
  if (!r?.ok) return false
  const doc = new DOMParser().parseFromString(await r.text(), 'image/svg+xml')
  if (doc.documentElement.localName !== 'svg') return false
  const svg = document.importNode(doc.documentElement, true) as unknown as SVGSVGElement
  // Размеры и рамки фигур считает браузер — рисунок временно монтируется вне экрана
  const host = document.createElement('div')
  host.setAttribute('aria-hidden', 'true')
  host.style.cssText = 'position:fixed;left:-20000px;top:0;width:1200px;height:900px;visibility:hidden;pointer-events:none'
  host.appendChild(svg)
  document.body.appendChild(host)
  try {
    const known = analyzeSource(svg, { id, title: '', originalName: '', kind: 'builtin', file: `${id}.svg` })
    if (known.shapes.length !== model.shapes.length) return false
    return known.shapes.every((k, i) => {
      const u = model.shapes[i]!
      if (k.el.localName !== u.el.localName) return false
      const [a, b] = [relative(k.bbox, known.viewBox), relative(u.bbox, model.viewBox)]
      return a.every((v, j) => Math.abs(v - b[j]!) <= 0.003)
    })
  } finally {
    host.remove()
  }
}

/** Разметка → объекты; фигуры, не попавшие в разметку, — отдельными безымянными объектами */
function objectsFrom(entry: Annotation, shapeCount: number): SourceObject[] {
  const seen = new Set<number>()
  const list: SourceObject[] = []
  for (const o of entry.objects) {
    const shapes = parseShapeRanges(o.shapes).filter((i) => i >= 0 && i < shapeCount && !seen.has(i))
    shapes.forEach((i) => seen.add(i))
    if (shapes.length) list.push({ name: o.name, shapes })
  }
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
