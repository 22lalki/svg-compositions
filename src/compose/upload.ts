import { shortId } from '../lib/ids'
import { importSvgFile, SvgImportError } from '../lib/importSvg'
import { rewriteRefs, selfAndDescendants } from '../lib/svg'
import { parseAssetSvg, type Asset } from './assets'
import { variantKey, type Item, type VariantKey } from './catalog'
import { BASE_COLORS, BG_ROLES, ROLES, normalizeColor, type ObjState, type SizeKey } from './model'
import type { StoredItem } from './storage'

/**
 * Загрузка своей библиотеки объектов. Файлы группируются в объекты по имени, как в наборе:
 * «Книга.svg» и «Книга (1).svg» — варианты одной «Книги». Варианты различаются так же, как во встроенном наборе:
 *  - состояние — по цветам: нарисованный только цветами фона — фоновый, иначе основной;
 *  - размер — по папке L/ или S/ (если загружена папка), иначе по габаритам: больший вариант — L.
 * Цвета приводятся к ролям схемы (ближайший цвет набора): без этого объект нельзя было бы перекрашивать схемой.
 */

type Parsed = { file: File; base: string; size: SizeKey | null; state: ObjState; asset: Asset; snapped: number }

const BASE = ROLES.map((r) => ({ role: r, hex: BASE_COLORS[r], rgb: rgbOf(BASE_COLORS[r]) }))

function rgbOf(hex: string): [number, number, number] {
  const n = Number.parseInt(hex.slice(1), 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

/** Ближайший цвет набора (взвешенное расстояние RGB, близкое к восприятию) */
function nearestBase(hex: string) {
  const [r, g, b] = rgbOf(hex)
  let best = BASE[0]!
  let bestD = Infinity
  for (const c of BASE) {
    const rm = (r + c.rgb[0]) / 2
    const d = (2 + rm / 256) * (r - c.rgb[0]) ** 2 + 4 * (g - c.rgb[1]) ** 2 + (2 + (255 - rm) / 256) * (b - c.rgb[2]) ** 2
    if (d < bestD) {
      bestD = d
      best = c
    }
  }
  return best
}

/** Цвета файла → цвета набора; возвращает разметку и сколько цветов пришлось заменить */
function snapColors(markup: string): { markup: string; snapped: Set<string>; roles: Set<string> } {
  const snapped = new Set<string>()
  const roles = new Set<string>()
  const swap = (v: string) => {
    const n = normalizeColor(v)
    if (!n) return v
    const c = nearestBase(n)
    roles.add(c.role)
    if (c.hex !== n) snapped.add(n)
    return c.hex
  }
  const out = markup
    .replace(/\b(fill|stroke|stop-color)="([^"]*)"/g, (_, a: string, v: string) => `${a}="${swap(v)}"`)
    .replace(/\b(fill|stroke|stop-color)\s*:\s*([^;"]+)/g, (_, a: string, v: string) => `${a}:${swap(v)}`)
  return { markup: out, snapped, roles }
}

/** id внутри файла получают префикс объекта: градиенты двух объектов не перепутаются на холсте */
function prefixIds(svgText: string, prefix: string): string {
  const doc = new DOMParser().parseFromString(svgText, 'image/svg+xml')
  const all = selfAndDescendants(doc.documentElement)
  const rename = new Map<string, string>()
  for (const el of all) {
    const id = el.getAttribute('id')
    if (id) {
      rename.set(id, prefix + id)
      el.setAttribute('id', prefix + id)
    }
  }
  if (rename.size) for (const el of all) rewriteRefs(el, rename)
  return new XMLSerializer().serializeToString(doc)
}

const baseName = (name: string) =>
  name
    .replace(/\.svg$/i, '')
    .replace(/\s*\(\d+\)\s*$/, '')
    .replace(/[_]+/g, ' ')
    .trim()

/** Размер по папке (input с webkitdirectory отдает путь «Набор/L/Книга.svg») */
function sizeFromPath(file: File): SizeKey | null {
  const parts = (file.webkitRelativePath || '').split('/').slice(0, -1).map((p) => p.trim().toUpperCase())
  if (parts.includes('L')) return 'L'
  if (parts.includes('S')) return 'S'
  return null
}

export type UploadResult = { added: StoredItem[]; notes: string[] }

export async function importObjectFiles(files: File[]): Promise<UploadResult> {
  const notes: string[] = []
  const parsed: Parsed[] = []
  const prefix = `u${shortId(5)}-`
  for (const [i, file] of files.entries()) {
    try {
      const { svgText } = await importSvgFile(file)
      const asset = parseAssetSvg(prefixIds(svgText, `${prefix}${i}-`))
      if (!asset) throw new SvgImportError('нет размеров')
      const { markup, snapped, roles } = snapColors(asset.markup)
      // Фоновый — только если цвета распознаны и все они фоновые (every на пустом наборе дал бы true)
      const state: ObjState = roles.size > 0 && [...roles].every((r) => (BG_ROLES as readonly string[]).includes(r)) ? 'bg' : 'main'
      parsed.push({ file, base: baseName(file.name), size: sizeFromPath(file), state, asset: { ...asset, markup }, snapped: snapped.size })
    } catch (e) {
      notes.push(`${file.name}: ${e instanceof SvgImportError ? e.message : 'не удалось прочитать'}`)
    }
  }

  const groups = new Map<string, Parsed[]>()
  for (const p of parsed) {
    const k = p.base.toLowerCase()
    groups.set(k, [...(groups.get(k) ?? []), p])
  }

  const added: StoredItem[] = []
  for (const list of groups.values()) {
    // Размер без папки: у одного объекта варианты двух размеров — больший L; одного размера — L
    // S вдвое меньше по сторонам (вчетверо по площади): заметно меньший вариант — S, а разница в пару пикселей
    // между основным и фоновым вариантами одного размера — не повод разносить их по разным размерам
    const maxArea = Math.max(...list.map((p) => p.asset.width * p.asset.height))
    const assets: Partial<Record<VariantKey, Asset>> = {}
    for (const p of list) {
      const size = p.size ?? (p.asset.width * p.asset.height < maxArea * 0.6 ? 'S' : 'L')
      const k = variantKey(size, p.state)
      if (assets[k]) {
        notes.push(`${p.file.name}: второй ${p.state === 'bg' ? 'фоновый' : 'основной'} вариант размера ${size} — пропущен`)
        continue
      }
      assets[k] = p.asset
      if (p.snapped) notes.push(`${p.file.name}: ${p.snapped} цв. приведено к цветам набора`)
    }
    const name = list[0]!.base || 'Объект'
    const variants: Item['variants'] = {}
    for (const [k, a] of Object.entries(assets)) variants[k as VariantKey] = { width: a.width, height: a.height }
    added.push({
      item: {
        id: `${prefix}${added.length}`,
        name: name[0]!.toUpperCase() + name.slice(1),
        names: [name.toLowerCase()],
        keywords: [],
        related: [],
        builtin: false,
        variants,
        createdAt: Date.now(),
      },
      assets,
    })
  }
  return { added, notes }
}
