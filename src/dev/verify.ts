/**
 * Самопроверка извлечения (только dev: /verify.html, запускается scripts/verify-extraction.mjs).
 * Для каждого исходника и набора фигур рендерим:
 *   A — оригинал, где оставлены только выбранные фигуры, обрезанный по bbox выделения;
 *   B — извлеченный компонент.
 * Затем сравниваем пиксели. Совпадение означает, что transform, цвета, порядок и градиенты перенесены верно.
 */
import type { SourceMeta } from '../types'
import { analyzeSource, extractComponent, isAxisAlignedShape, listShapes, type SourceModel } from '../lib/extract'
import { svgDataUrl, SVG_NS } from '../lib/svg'

type CaseResult = {
  source: string
  mode: string
  shapes: number
  defs: number
  width: number
  height: number
  painted: number
  diffPixels: number
  diffRatio: number
  /** Закрашенные пиксели эталона за пределами bbox компонента (компонент обрезан) */
  outside: number
  idsOk: boolean
}

const SCALE_TARGET = 500
const dump: Record<string, { reference: string; component: string; png?: string }> = {}
;(window as unknown as { __dump: typeof dump }).__dump = dump

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error('image load failed'))
    img.src = url
  })
}

const DUMP = location.search.includes('dump')

/** Отладка: эталон | компонент | различия (красным) одной картинкой */
function diffImage(pa: Uint8ClampedArray, pb: Uint8ClampedArray, w: number, h: number): string {
  const canvas = document.createElement('canvas')
  canvas.width = w * 3
  canvas.height = h
  const ctx = canvas.getContext('2d')!
  const img = ctx.createImageData(w * 3, h)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4
      for (const [k, src] of [[0, pa], [1, pb]] as const) {
        const o = (y * w * 3 + x + k * w) * 4
        img.data.set(src.subarray(i, i + 4), o)
      }
      const d = Math.max(Math.abs(pa[i]! - pb[i]!), Math.abs(pa[i + 1]! - pb[i + 1]!), Math.abs(pa[i + 2]! - pb[i + 2]!))
      const o = (y * w * 3 + x + 2 * w) * 4
      img.data.set(d > 48 ? [255, 0, 0, 255] : [235, 235, 235, 255], o)
    }
  }
  ctx.putImageData(img, 0, 0)
  return canvas.toDataURL('image/png')
}

function rasterize(img: HTMLImageElement, w: number, h: number): Uint8ClampedArray {
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d')!
  ctx.fillStyle = '#fff'
  ctx.fillRect(0, 0, w, h)
  ctx.drawImage(img, 0, 0, w, h)
  return ctx.getImageData(0, 0, w, h).data
}

async function runCase(model: SourceModel, mode: string, indices: number[]): Promise<CaseResult | null> {
  if (indices.length === 0) return null
  const prefix = 'cverify-'
  const ext = extractComponent(model, indices, prefix)
  if (!ext) return null

  // Эталон: копия исходника, в которой удалены все невыбранные фигуры
  const clone = model.svg.cloneNode(true) as SVGSVGElement
  const keep = new Set(indices)
  listShapes(clone).forEach((el, i) => {
    if (!keep.has(i)) el.remove()
  })
  // Эталон рендерим с полями вокруг bbox: если bbox компонента слишком тесный,
  // обрезанные края фигур попадут в поля эталона и дадут расхождение
  const pad = 0.08 * Math.max(ext.width, ext.height)
  const scale = SCALE_TARGET / (Math.max(ext.width, ext.height) + 2 * pad)
  const w = Math.max(1, Math.round((ext.width + 2 * pad) * scale))
  const h = Math.max(1, Math.round((ext.height + 2 * pad) * scale))
  clone.setAttribute('viewBox', `${ext.origin.x - pad} ${ext.origin.y - pad} ${ext.width + 2 * pad} ${ext.height + 2 * pad}`)
  clone.setAttribute('width', String(w))
  clone.setAttribute('height', String(h))
  clone.setAttribute('preserveAspectRatio', 'none')
  clone.removeAttribute('style')
  clone.setAttribute('xmlns', SVG_NS)
  const reference = new XMLSerializer().serializeToString(clone)

  // Компонент рендерим в том же окне с полями (без своей обрезки и без пересэмплирования),
  // чтобы сравнение проверяло только геометрию, цвета, порядок и градиенты
  const vbW = ext.width + 2 * pad
  const vbH = ext.height + 2 * pad
  const component =
    `<svg xmlns="${SVG_NS}" xmlns:xlink="http://www.w3.org/1999/xlink" width="${w}" height="${h}" ` +
    `viewBox="${-pad} ${-pad} ${vbW} ${vbH}" preserveAspectRatio="none">` +
    (ext.defs ? `<defs>${ext.defs}</defs>` : '') +
    ext.markup +
    '</svg>'
  dump[model.meta.id + ':' + mode] = { reference, component }
  const [a, b] = await Promise.all([loadImage(svgDataUrl(reference)), loadImage(svgDataUrl(component))])
  const pa = rasterize(a, w, h)
  const pb = rasterize(b, w, h)
  // Граница bbox компонента в пикселях: все закрашенное в эталоне должно быть внутри
  const sx = w / vbW
  const sy = h / vbH
  const inner = { x0: pad * sx - 1.5, y0: pad * sy - 1.5, x1: (pad + ext.width) * sx + 1.5, y1: (pad + ext.height) * sy + 1.5 }
  let painted = 0
  let diff = 0
  let outside = 0
  for (let i = 0; i < pa.length; i += 4) {
    const da = Math.max(Math.abs(pa[i]! - 255), Math.abs(pa[i + 1]! - 255), Math.abs(pa[i + 2]! - 255))
    if (da > 8) {
      painted++
      const x = (i / 4) % w
      const y = Math.floor(i / 4 / w)
      if (x < inner.x0 || x > inner.x1 || y < inner.y0 || y > inner.y1) outside++
    }
    const d = Math.max(Math.abs(pa[i]! - pb[i]!), Math.abs(pa[i + 1]! - pb[i + 1]!), Math.abs(pa[i + 2]! - pb[i + 2]!))
    if (d > 48) diff++
  }
  if (DUMP) dump[model.meta.id + ':' + mode]!.png = diffImage(pa, pb, w, h)

  // Все id в defs с префиксом, все ссылки ведут на префиксованные id
  const ids = Array.from(ext.defs.matchAll(/\sid="([^"]+)"/g), (m) => m[1]!)
  const refs = Array.from((ext.defs + ext.markup).matchAll(/url\(#([^)]+)\)|href="#([^"]+)"/g), (m) => m[1] ?? m[2]!)
  const idsOk = ids.every((id) => id.startsWith(prefix)) && refs.every((r) => r.startsWith(prefix) && ids.includes(r))

  return {
    source: model.meta.id,
    mode,
    shapes: ext.shapeCount,
    defs: ext.defsCount,
    width: Number(ext.width.toFixed(1)),
    height: Number(ext.height.toFixed(1)),
    painted,
    diffPixels: diff,
    diffRatio: painted ? Number((diff / painted).toFixed(5)) : 0,
    outside,
    idsOk,
  }
}

async function verifySource(meta: SourceMeta, host: HTMLElement): Promise<CaseResult[]> {
  const text = await fetch(`/sources/${meta.file}`).then((r) => r.text())
  const doc = new DOMParser().parseFromString(text, 'image/svg+xml')
  const svg = document.importNode(doc.documentElement, true) as unknown as SVGSVGElement
  svg.style.cssText = 'width:300px;height:300px'
  host.replaceChildren(svg)
  const model = analyzeSource(svg, meta)
  const all = model.shapes.map((s) => s.index)
  const cases: Array<[string, number[]]> = [
    ['all', all],
    ['even', all.filter((i) => i % 2 === 0)],
    ['odd', all.filter((i) => i % 2 === 1)],
    ['rotated', model.shapes.filter((s) => !isAxisAlignedShape(s)).map((s) => s.index)],
    ['gradient', model.shapes.filter((s) => /url\(/.test(s.el.getAttribute('fill') ?? '')).map((s) => s.index)],
  ]
  const out: CaseResult[] = []
  for (const [mode, indices] of cases) {
    const r = await runCase(model, mode, indices)
    if (r) out.push(r)
  }
  return out
}

async function main() {
  const host = document.getElementById('host')!
  const manifest = (await fetch('/sources/manifest.json').then((r) => r.json())) as SourceMeta[]
  const results: CaseResult[] = []
  for (const meta of manifest) results.push(...(await verifySource(meta, host)))
  host.replaceChildren()
  ;(window as unknown as { __verify: CaseResult[] }).__verify = results
  document.title = 'verify: done'
}

void main()
