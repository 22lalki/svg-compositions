import type { SourceMeta } from '../types'
import type { SourceModel } from './extract'
import type { SourceObject } from './sources'
import { svgDataUrl } from './svg'
import { loadUserObjects, saveUserObjects } from './storage'

/** Столько же, сколько принимает api/annotate.ts: больше номеров на одной картинке не разобрать */
export const AI_MAX_SHAPES = 400
const MAP_SIZE = 1400

export type AiResult =
  | { status: 'done'; objects: SourceObject[]; cached: boolean }
  | { status: 'unavailable' | 'error' | 'too_many'; message: string }

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error('не удалось отрисовать исходник'))
    img.src = url
  })
}

/** PNG исходника, где у каждой фигуры подписан ее номер (то же, что видели ИИ-разметчики встроенных) */
export async function renderShapeMap(model: SourceModel): Promise<string> {
  const vb = model.viewBox
  const k = MAP_SIZE / Math.max(vb.width, vb.height)
  const W = Math.max(1, Math.round(vb.width * k))
  const H = Math.max(1, Math.round(vb.height * k))
  const clone = model.svg.cloneNode(true) as SVGSVGElement
  clone.removeAttribute('style')
  clone.setAttribute('width', String(W))
  clone.setAttribute('height', String(H))
  clone.setAttribute('viewBox', `${vb.x} ${vb.y} ${vb.width} ${vb.height}`)
  clone.setAttribute('preserveAspectRatio', 'none')
  const img = await loadImage(svgDataUrl(new XMLSerializer().serializeToString(clone)))

  const canvas = document.createElement('canvas')
  canvas.width = W
  canvas.height = H
  const ctx = canvas.getContext('2d')!
  ctx.fillStyle = '#fff'
  ctx.fillRect(0, 0, W, H)
  ctx.drawImage(img, 0, 0, W, H)
  const px = (x: number, y: number) => [(x - vb.x) * k, (y - vb.y) * k] as const

  ctx.strokeStyle = 'rgba(220,0,0,.35)'
  ctx.lineWidth = 1
  for (const s of model.shapes) {
    ctx.beginPath()
    s.outline.forEach((p, i) => (i ? ctx.lineTo(...px(p.x, p.y)) : ctx.moveTo(...px(p.x, p.y))))
    ctx.closePath()
    ctx.stroke()
  }
  ctx.font = '600 13px Segoe UI, Arial, sans-serif'
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.lineJoin = 'round'
  for (const s of model.shapes) {
    const [x, y] = px(s.bbox.x + s.bbox.width / 2, s.bbox.y + s.bbox.height / 2)
    ctx.lineWidth = 3
    ctx.strokeStyle = '#fff'
    ctx.strokeText(String(s.index), x, y)
    ctx.fillStyle = '#c00'
    ctx.fillText(String(s.index), x, y)
  }
  return canvas.toDataURL('image/png').split(',')[1]!
}

/** Таблица фигур: номер, тег, заливка, рамка в координатах рисунка, группа верхнего уровня */
export function shapeTable(model: SourceModel): string {
  const top = model.wrapper ?? model.svg
  const groupIds = new Map<Element, string>()
  return model.shapes
    .map((s) => {
      let el: Element = s.el
      for (let p = el.parentElement as Element | null; p && p !== top && p !== model.svg; p = p.parentElement as Element | null) el = p
      let group = ''
      if (el !== s.el && el.localName === 'g') {
        if (!groupIds.has(el)) groupIds.set(el, `g${groupIds.size + 1}`)
        group = groupIds.get(el)!
      }
      const b = s.bbox
      const fill = getComputedStyle(s.el).fill
      return `${s.index}\t${s.el.localName}\t${fill}\t${[b.x, b.y, b.x + b.width, b.y + b.height].map(Math.round).join(',')}\t${group}`
    })
    .join('\n')
}

const inflight = new Map<string, Promise<AiResult>>()
/** Сервер ответил «ИИ не настроен» — до перезагрузки страницы не рисуем карту и не ходим на сервер */
let notConfigured: string | null = null

/**
 * Объекты загруженного SVG от ИИ (Claude через /api/annotate). Результат кешируется в IndexedDB:
 * повторное открытие файла не стоит запроса. force — разметить заново.
 */
export function annotateWithAi(meta: SourceMeta, model: SourceModel, hint: number[][], force = false): Promise<AiResult> {
  const key = meta.id
  const running = inflight.get(key)
  if (running && !force) return running
  const job = (async (): Promise<AiResult> => {
    const count = model.shapes.length
    if (!force) {
      const cached = await loadUserObjects(meta.id).catch(() => undefined)
      if (cached && cached.shapeCount === count) return { status: 'done', objects: cached.objects, cached: true }
    }
    if (count > AI_MAX_SHAPES) return { status: 'too_many', message: `в файле ${count} фигур — ИИ размечает до ${AI_MAX_SHAPES}` }
    if (notConfigured) return { status: 'unavailable', message: notConfigured }
    let response: Response
    try {
      response = await fetch('/api/annotate', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ image: await renderShapeMap(model), table: shapeTable(model), shapeCount: count, title: meta.title, hint }),
      })
    } catch {
      return { status: 'unavailable', message: 'сервер ИИ-разметки недоступен' }
    }
    const data = (await response.json().catch(() => ({}))) as { objects?: SourceObject[]; error?: string; message?: string }
    if (response.status === 404 || response.status === 503 || data.error === 'not_configured') {
      notConfigured = data.message ?? 'ИИ-разметка не настроена на сервере'
      return { status: 'unavailable', message: notConfigured }
    }
    if (!response.ok || !Array.isArray(data.objects)) {
      return { status: 'error', message: data.message ?? `ошибка ${response.status}` }
    }
    // Ответ уже почищен сервером; фигуры, которых ИИ не назвал, — отдельными объектами
    const seen = new Set<number>()
    const objects: SourceObject[] = []
    for (const o of data.objects) {
      const shapes = o.shapes.filter((i) => Number.isInteger(i) && i >= 0 && i < count && !seen.has(i))
      shapes.forEach((i) => seen.add(i))
      if (shapes.length) objects.push({ name: o.name || null, shapes })
    }
    for (let i = 0; i < count; i++) if (!seen.has(i)) objects.push({ name: null, shapes: [i] })
    await saveUserObjects(meta.id, { shapeCount: count, objects, createdAt: Date.now() }).catch(() => undefined)
    return { status: 'done', objects, cached: false }
  })()
  inflight.set(key, job)
  void job.finally(() => inflight.get(key) === job && inflight.delete(key))
  return job
}
