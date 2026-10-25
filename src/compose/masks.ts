import { svgDataUrl, SVG_NS, XLINK_NS } from '../lib/svg'
import { getAsset, loadAsset } from './assets'
import type { Item } from './catalog'
import { SIZE_FACTOR, type SizeKey } from './model'

/**
 * Маска формы объекта — где он реально нарисован, а не его прямоугольная рамка. По маскам оценивается
 * раскладка (aesthetics.ts): объекты в изометрии вытянуты по диагонали, и рамки сильно перекрываются там,
 * где сами объекты не касаются. Маска — сетка ячеек CELL × CELL пикселей (в размере S ячейка вдвое меньше,
 * так что сетки L и S совпадают по числу ячеек). У основного и фонового вариантов геометрия одна, маска тоже.
 */
export const CELL_L = 16
export const cellSize = (size: SizeKey) => CELL_L * SIZE_FACTOR[size]

export type Mask = { w: number; h: number; data: Uint8Array; count: number }

const cache = new Map<string, Mask>()
const pending = new Map<string, Promise<Mask | null>>()
const key = (itemId: string, size: SizeKey) => `${itemId}/${size}`

export const getMask = (itemId: string, size: SizeKey): Mask | undefined => cache.get(key(itemId, size))

/** Прямоугольная маска — пока настоящая не готова (или если файл не отрисовался) */
export function boxMask(width: number, height: number, size: SizeKey): Mask {
  const c = cellSize(size)
  const w = Math.max(1, Math.ceil(width / c))
  const h = Math.max(1, Math.ceil(height / c))
  return { w, h, data: new Uint8Array(w * h).fill(1), count: w * h }
}

function render(markup: string, width: number, height: number, size: SizeKey): Promise<Mask | null> {
  const c = cellSize(size)
  const w = Math.max(1, Math.ceil(width / c))
  const h = Math.max(1, Math.ceil(height / c))
  // Рисуем в 4 раза подробнее сетки и считаем ячейку занятой, если закрашена заметная ее часть:
  // тонкая линия не делает ячейку «телом» объекта, а контур с заливкой — делает
  const k = 4
  return new Promise((resolve) => {
    const img = new Image()
    img.onload = () => {
      const canvas = document.createElement('canvas')
      canvas.width = w * k
      canvas.height = h * k
      const ctx = canvas.getContext('2d', { willReadFrequently: true })
      if (!ctx) return resolve(null)
      ctx.drawImage(img, 0, 0, (width / c) * k, (height / c) * k)
      const px = ctx.getImageData(0, 0, w * k, h * k).data
      const data = new Uint8Array(w * h)
      let count = 0
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          let a = 0
          for (let dy = 0; dy < k; dy++) for (let dx = 0; dx < k; dx++) a += px[((y * k + dy) * w * k + x * k + dx) * 4 + 3]!
          if (a / (k * k * 255) > 0.3) {
            data[y * w + x] = 1
            count++
          }
        }
      }
      resolve(count ? { w, h, data, count } : null)
    }
    img.onerror = () => resolve(null)
    img.src = svgDataUrl(`<svg xmlns="${SVG_NS}" xmlns:xlink="${XLINK_NS}" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">${markup}</svg>`)
  })
}

/** Маска объекта нужного размера (строится один раз, из основного варианта, если он есть) */
export function loadMask(item: Item, size: SizeKey): Promise<Mask | null> {
  const k = key(item.id, size)
  const ready = cache.get(k)
  if (ready) return Promise.resolve(ready)
  let p = pending.get(k)
  if (!p) {
    p = (async () => {
      const state = item.variants[`${size}-main`] ? 'main' : 'bg'
      await loadAsset(item, size, state)
      const asset = getAsset(item, size, state)
      if (!asset) return null
      const mask = await render(asset.markup, asset.width, asset.height, size)
      if (mask) cache.set(k, mask)
      return mask
    })().finally(() => pending.delete(k))
    pending.set(k, p)
  }
  return p
}

export const preloadMasks = (items: readonly Item[], size: SizeKey) => Promise.all(items.map((i) => loadMask(i, size)))
