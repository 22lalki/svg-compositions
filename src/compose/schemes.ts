import { prepareSvgText, SvgImportError } from '../lib/importSvg'
import { normalizeColor, type Scheme } from './model'

/**
 * Загрузка цветовой схемы. Палитра — как в наборе, но с любым числом цветов:
 * две колонки клеток (или два ряда), слева (сверху) — цвета фона от светлого к темному, справа (снизу) — цвета
 * объектов. Черный и белый могут стоять в любой колонке: их узнаем по значению. Клетки — rect или контуры,
 * с любыми трансформациями: положение берется из отрисованной геометрии.
 *
 * Палитра другой раскладки (один ряд, сетка, россыпь) тоже принимается: группы определяются по цветам
 * (autoGroups), а пользователь может поправить их в «Изменить цвета».
 */

export class PaletteError extends Error {}

type Groups = { bg: string[]; accents: string[] }

const rgb = (hex: string) => [1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16)) as [number, number, number]
const lightness = (hex: string) => {
  const [r, g, b] = rgb(hex)
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255
}
/**
 * Почти черный (контуры) и почти белый (блики). Черный — темный и приглушенный: темно-синий контур подходит,
 * а темно-красный — это цвет, а не контур
 */
const isBlack = (hex: string) => lightness(hex) < 0.08 || (lightness(hex) < 0.22 && saturation(hex) < 0.35)
const isWhite = (hex: string) => Math.min(...rgb(hex)) >= 245

/**
 * Схема из двух групп цветов. Черный и белый вынимаются из групп; если их в палитре нет, черный — самый темный
 * цвет палитры, белый — самый светлый из цветов фона (белый бывает и в фоне, поэтому он должен быть цветом фона)
 */
export function schemeFromGroups(id: string, name: string, groups: Groups): Scheme {
  const all = [...groups.bg, ...groups.accents]
  const black = all.filter(isBlack).sort((a, b) => lightness(a) - lightness(b))[0]
  const white = all.filter(isWhite).sort((a, b) => lightness(b) - lightness(a))[0]
  // Убираем только выбранные черный и белый: второй темный или светлый цвет палитры остается доступным
  const pure = (list: string[]) => [...new Set(list.filter((c) => c !== black && c !== white))]
  let bg = pure(groups.bg)
  let accents = pure(groups.accents)
  // Фону нужен хотя бы один цвет: берем самый светлый из цветов объектов, а если палитра только из черного
  // и белого — белый (или самый светлый цвет палитры)
  if (!bg.length) {
    const lightest = [...accents].sort((a, b) => lightness(b) - lightness(a))[0]
    if (lightest) {
      bg = [lightest]
      accents = accents.filter((c) => c !== lightest)
    } else {
      bg = [white ?? [...all].sort((a, b) => lightness(b) - lightness(a))[0]!]
    }
  }
  return {
    id,
    name,
    bg,
    accents,
    black: black ?? [...all].sort((a, b) => lightness(a) - lightness(b))[0]!,
    white: white ?? [...bg].sort((a, b) => lightness(b) - lightness(a))[0]!,
  }
}

/** Насыщенность (HSL) — яркие цвета скорее цвета объектов, приглушенные светлые — фона */
function saturation(hex: string) {
  const [r, g, b] = rgb(hex).map((v) => v / 255) as [number, number, number]
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const l = (max + min) / 2
  return max === min ? 0 : (max - min) / (1 - Math.abs(2 * l - 1))
}

/**
 * Группы по цветам, когда раскладка палитры их не задает: черный и белый узнаются по значению, остальные
 * делятся пополам по «фоновости» — светлые и приглушенные в фон (как пастельные фоны набора), яркие и темные —
 * в цвета объектов. Цвета фона — от светлого к темному: первый станет заливкой кадра
 */
export function autoGroups(colors: string[]): Groups {
  const plain = [...new Set(colors)].filter((c) => !isBlack(c) && !isWhite(c))
  const neutral = [...new Set(colors)].filter((c) => isBlack(c) || isWhite(c))
  const bgness = (c: string) => lightness(c) - 0.5 * saturation(c)
  const ranked = [...plain].sort((a, b) => bgness(b) - bgness(a))
  const k = plain.length <= 2 ? Math.min(1, plain.length) : Math.ceil(plain.length / 2)
  const bg = ranked.slice(0, k).sort((a, b) => lightness(b) - lightness(a))
  return { bg, accents: [...ranked.slice(k), ...neutral] }
}

type Cell = { color: string; x: number; y: number; w: number; h: number }

/** Делим клетки на две группы по большему разрыву вдоль оси; разрыв должен быть заметным (больше полклетки) */
function splitBy(cells: Cell[], axis: 'x' | 'y'): [Cell[], Cell[]] | null {
  const size = axis === 'x' ? 'w' : 'h'
  const sorted = [...cells].sort((a, b) => a[axis] - b[axis])
  let best = -1
  let gap = 0
  for (let i = 1; i < sorted.length; i++) {
    const d = sorted[i]![axis] - sorted[i - 1]![axis]
    if (d > gap) {
      gap = d
      best = i
    }
  }
  const typical = Math.min(...cells.map((c) => c[size]))
  if (best < 0 || gap < typical * 0.5) return null
  const a = sorted.slice(0, best)
  const b = sorted.slice(best)
  // Внутри группы клетки должны стоять одной линией, иначе это сетка, а не две колонки
  const spread = (g: Cell[]) => Math.max(...g.map((c) => c[axis])) - Math.min(...g.map((c) => c[axis]))
  if (spread(a) > typical * 0.5 || spread(b) > typical * 0.5) return null
  return [a, b]
}

/** auto — группы определены по цветам, а не по раскладке (стоит сказать пользователю) */
export function parsePaletteSvg(text: string, id: string, name: string): { scheme: Scheme; auto: boolean } {
  // Та же нормализация, что у загружаемых объектов: очистка (без скриптов и внешних ссылок), стили из <style>
  // и классов — в атрибуты, <use> раскрыт. Трансформации групп сохраняются, поэтому палитра из Illustrator
  // (цвета классами, колонки — сдвинутыми группами) читается так же, как нарисована
  let prepared: string
  try {
    prepared = prepareSvgText(text).svgText
  } catch (e) {
    throw new PaletteError(e instanceof SvgImportError ? e.message : 'файл не является SVG')
  }
  const svg = document.importNode(new DOMParser().parseFromString(prepared, 'image/svg+xml').documentElement, true)
  const host = document.createElement('div')
  host.style.cssText = 'position:fixed;left:-20000px;top:0;opacity:0;pointer-events:none'
  host.appendChild(svg)
  document.body.appendChild(host)
  try {
    const shapes = Array.from(svg.querySelectorAll('rect, path, circle, ellipse, polygon')).filter(
      (el) => !el.closest('defs, clipPath, mask, pattern, marker, symbol'),
    )
    const cells = shapes.flatMap((el): Cell[] => {
      const color = normalizeColor(getComputedStyle(el).fill)
      const box = el.getBoundingClientRect()
      return color && box.width * box.height > 0 ? [{ color, x: box.x + box.width / 2, y: box.y + box.height / 2, w: box.width, h: box.height }] : []
    })
    // Клетки палитры — крупные; мелочь (подписи, рамки, точки) не учитываем
    const maxArea = Math.max(0, ...cells.map((c) => c.w * c.h))
    const big = cells.filter((c) => c.w * c.h >= maxArea * 0.3)
    if (!big.length) throw new PaletteError('в файле нет цветных клеток')
    const cols = big.length > 1 ? splitBy(big, 'x') : null
    const rows = cols || big.length < 2 ? null : splitBy(big, 'y')
    const groups = cols ?? rows
    if (!groups) {
      // Один ряд, сетка или россыпь: порядок чтения — сверху вниз, слева направо; группы — по цветам
      const ordered = [...big].sort((a, b) => (Math.abs(a.y - b.y) > Math.min(a.h, b.h) / 2 ? a.y - b.y : a.x - b.x))
      return { scheme: schemeFromGroups(id, name, autoGroups(ordered.map((c) => c.color))), auto: true }
    }
    const along = cols ? 'y' : 'x'
    const [bg, accents] = groups.map((g) => [...g].sort((a, b) => a[along] - b[along]).map((c) => c.color)) as [string[], string[]]
    return { scheme: schemeFromGroups(id, name, { bg, accents }), auto: false }
  } finally {
    host.remove()
  }
}

/**
 * Схема из HEX: две группы через «|», «;» или с новой строки — сначала фон, потом объекты.
 * Одна группа из 8 цветов — порядок ролей палитр набора (фон 3, черный, объекты 3, белый);
 * одна группа другой длины — группы по цветам (autoGroups)
 */
export function parseHexGroups(text: string, id: string, name: string): Scheme {
  const hexes = (s: string) => (s.match(/#[0-9a-f]{6}\b|#[0-9a-f]{3}\b/gi) ?? []).map((c) => normalizeColor(c)!)
  const parts = text.split(/[|;\n]/).map(hexes).filter((g) => g.length)
  if (parts.length === 1 && parts[0]!.length === 8) {
    const [l, m, d, k, a1, a2, a3, w] = parts[0]!
    return schemeFromGroups(id, name, { bg: [l!, m!, d!, k!], accents: [a1!, a2!, a3!, w!] })
  }
  if (parts.length === 1) return schemeFromGroups(id, name, autoGroups(parts[0]!))
  if (parts.length !== 2) throw new PaletteError('нужны две группы цветов через «|»: сначала цвета фона, потом цвета объектов')
  return schemeFromGroups(id, name, { bg: parts[0]!, accents: parts[1]! })
}

/** Текст HEX для правки: «фон | объекты черный белый» */
export const schemeToHex = (s: Scheme) => `${s.bg.join(' ')} | ${[...s.accents, s.black, s.white].join(' ')}`

/** Контрастный цвет подписи поверх образца */
export function inkOn(hex: string): string {
  return lightness(hex) > 0.6 ? '#1f2330' : '#ffffff'
}
