import { create } from 'zustand'
import { variantKey, type Item, type VariantKey } from './catalog'
import type { ObjState, SizeKey } from './model'

/**
 * Файлы объектов. Встроенные лежат в public/set и грузятся по требованию; загруженные пользователем
 * кладутся в кэш при старте из IndexedDB. Разметка хранится в исходных цветах набора (фиолетовая схема):
 * перекраска делается при отрисовке (render.ts), сам файл не меняется.
 */
export type Asset = { width: number; height: number; markup: string }

const cache = new Map<string, Asset>()
const pending = new Map<string, Promise<Asset | null>>()
const key = (itemId: string, v: VariantKey) => `${itemId}/${v}`

/** Версия кэша: компоненты перерисовываются, когда догрузился файл */
export const useAssets = create<{ version: number }>()(() => ({ version: 0 }))
const bump = () => useAssets.setState((s) => ({ version: s.version + 1 }))

/** Корневой <svg> файла → размер и внутренняя разметка */
export function parseAssetSvg(text: string): Asset | null {
  const doc = new DOMParser().parseFromString(text, 'image/svg+xml')
  const svg = doc.documentElement
  if (doc.querySelector('parsererror') || svg.localName !== 'svg') return null
  const vb = (svg.getAttribute('viewBox') ?? '').split(/[\s,]+/).map(Number)
  const width = Number.parseFloat(svg.getAttribute('width') ?? '') || vb[2] || 0
  const height = Number.parseFloat(svg.getAttribute('height') ?? '') || vb[3] || 0
  if (!(width > 0 && height > 0)) return null
  const serializer = new XMLSerializer()
  let markup = Array.from(svg.childNodes)
    .map((n) => serializer.serializeToString(n).replace(/ xmlns(?::xlink)?="[^"]*"/g, ''))
    .join('')
    .trim()
  // viewBox отображается в рамку width×height так же, как это делает браузер (сдвиг, масштаб, preserveAspectRatio):
  // у файлов набора viewBox совпадает с размером, а у загруженных бывает «width=48, viewBox 0 0 24 24»
  const [vx = 0, vy = 0, vw = 0, vh = 0] = vb
  if (vb.length === 4 && vb.every(Number.isFinite) && vw > 0 && vh > 0) {
    let sx = width / vw
    let sy = height / vh
    let tx = -vx * sx
    let ty = -vy * sy
    const par = (svg.getAttribute('preserveAspectRatio') ?? '').trim()
    if (!par.startsWith('none')) {
      const s = par.includes('slice') ? Math.max(sx, sy) : Math.min(sx, sy)
      const ax = /xMin/.test(par) ? 0 : /xMax/.test(par) ? 1 : 0.5
      const ay = /YMin/.test(par) ? 0 : /YMax/.test(par) ? 1 : 0.5
      tx = (width - vw * s) * ax - vx * s
      ty = (height - vh * s) * ay - vy * s
      sx = s
      sy = s
    }
    const r = (v: number) => Math.round(v * 1e5) / 1e5
    if (r(sx) !== 1 || r(sy) !== 1 || r(tx) || r(ty)) markup = `<g transform="matrix(${r(sx)} 0 0 ${r(sy)} ${r(tx)} ${r(ty)})">${markup}</g>`
  }
  return { width, height, markup }
}

export function putAsset(itemId: string, v: VariantKey, asset: Asset) {
  cache.set(key(itemId, v), asset)
  bump()
}

export function dropAssets(itemId: string) {
  for (const k of [...cache.keys()]) if (k.startsWith(`${itemId}/`)) cache.delete(k)
  bump()
}

/** Файл нужного варианта; у загруженного объекта может не быть фонового варианта — тогда основной */
export function getAsset(item: Item, size: SizeKey, state: ObjState): Asset | undefined {
  return cache.get(key(item.id, variantKey(size, state))) ?? cache.get(key(item.id, variantKey(size, state === 'bg' ? 'main' : 'bg')))
}

/** Догрузить встроенный файл (для загруженных пользователем файлы уже в кэше) */
export function loadAsset(item: Item, size: SizeKey, state: ObjState): Promise<Asset | null> {
  const v = variantKey(size, state)
  const k = key(item.id, v)
  const ready = cache.get(k)
  if (ready || !item.builtin) return Promise.resolve(ready ?? null)
  let p = pending.get(k)
  if (!p) {
    p = fetch(`/set/${size}/${item.id}-${state}.svg`)
      .then((r) => (r.ok ? r.text() : Promise.reject(new Error(`${r.status} ${r.url}`))))
      .then((text) => {
        const asset = parseAssetSvg(text)
        if (asset) putAsset(item.id, v, asset)
        return asset
      })
      .catch((e: unknown) => {
        console.error('Не удалось загрузить объект', item.id, v, e)
        return null
      })
      .finally(() => pending.delete(k))
    pending.set(k, p)
  }
  return p
}

/** Все варианты нужного размера — до показа сцены и превью */
export const preloadSize = (items: readonly Item[], size: SizeKey) =>
  Promise.all(items.flatMap((i) => (['main', 'bg'] as const).map((s) => loadAsset(i, size, s))))
