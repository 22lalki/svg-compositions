import { cellSize, type Mask } from './masks'
import type { ObjState, SizeKey } from './model'

/**
 * Оценка раскладки по формам объектов (маскам), а не по рамкам: объекты в изометрии вытянуты по диагонали,
 * и их рамки перекрываются там, где сами объекты не касаются.
 *
 * Нормы взяты из 18 примеров дизайнера (метрики примеров печатает галерея: /compose-gallery.html?examples=1):
 *  - небольшой основной объект виден в кадре минимум на 75% и ничем не закрыт — он лежит сверху;
 *  - крупный основной объект-поверхность (книга, папка: на них кладут другие) виден минимум на 54%,
 *    закрыт не больше чем на треть; остальные объекты (наушники, лампа, букет) не закрываются: поверх них
 *    ничего не кладут;
 *  - фоновый объект крупный (от 22% кадра), виден на 42–73% (уходит за край), закрыт не больше чем на четверть;
 *    мелкий фоновый (у дизайнера не бывает, но ТЗ разрешает) — фоновая деталь: виден целиком, с небольшой доплатой;
 *  - заметно срезан краем кадра максимум один средний основной объект;
 *  - каждый объект не дальше ~120 px от соседа, и все объекты связаны в одну группу;
 *  - крупный основной объект в кадре не больше одного; объекты занимают 29–75% кадра, центр тяжести смещен
 *    от центра не больше чем на 17% в плотном кадре и на 8% в полупустом.
 * Все примеры укладываются в нормы, поэтому штраф отражает только то, чего дизайнер не делает.
 */

/** surface — плоский объект, на который у дизайнера кладут другие (книга, папка): его можно частично закрыть */
export type Placed = { itemId: string; state: ObjState; x: number; y: number; mask: Mask; surface?: boolean }

export type ObjectMetrics = {
  itemId: string
  state: ObjState
  /** Доля формы внутри кадра */
  visible: number
  /** Доля видимой в кадре формы, закрытая объектами выше */
  hidden: number
  /** Доля видимой формы, лежащая поверх объекта, который не поверхность (пазл на стебле лампы, на вазе) */
  perched: number
  /**
   * Наложение на чужой объект (не поверхность) относительно меньшего из двух: телефон на тени лампы, тюльпаны на ее
   * плече. Доля от большого объекта (лампы) мала, а на глаз любое такое наложение — ошибка
   */
  clash: number
  /** Объект срезан сразу двумя противоположными краями кадра (слева и справа или сверху и снизу) */
  bleedBoth: boolean
  /** Площадь формы относительно кадра: крупный объект (подложка) живет по другим нормам */
  size: number
  surface: boolean
  /** Расстояние до ближайшего объекта, ступенями NEAR: 0 — касаются, NEAR.length — дальше последней ступени */
  gap: number
}

export type Metrics = {
  objects: ObjectMetrics[]
  /** Доля кадра, занятая объектами */
  coverage: number
  /** Смещение центра тяжести от центра кадра (доли ширины/высоты) */
  balance: number
  /** Все объекты связаны в одну группу (соседи не дальше NEAR[2]) */
  connected: boolean
}

/** Ступени близости в ячейках (ячейка — 16 px в размере L): 16, 64, 128, 192 px */
const NEAR = [1, 4, 8, 12] as const
/** Ступень «рядом»: дальше нее у дизайнера объекты не стоят */
const CLOSE = 2

/** Объект, занимающий больше этой доли кадра, — подложка */
export const LARGE = 0.4
/** Меньше этой доли кадра объект фоновым не бывает (у дизайнера фоновые — от 22%) */
export const BG_MIN = 0.18

const dilated = new WeakMap<Mask, Uint8Array[]>()

/** Маски, расширенные на каждую ступень NEAR (квадратная окрестность, два прохода — по строкам и столбцам) */
function dilations(m: Mask): Uint8Array[] {
  let list = dilated.get(m)
  if (list) return list
  list = NEAR.map((r) => {
    const W = m.w + 2 * r
    const H = m.h + 2 * r
    const rows = new Uint8Array(W * m.h)
    for (let y = 0; y < m.h; y++) {
      for (let x = 0; x < m.w; x++) {
        if (!m.data[y * m.w + x]) continue
        rows.fill(1, y * W + x, y * W + x + 2 * r + 1)
      }
    }
    const out = new Uint8Array(W * H)
    for (let y = 0; y < m.h; y++) {
      for (let x = 0; x < W; x++) {
        if (!rows[y * W + x]) continue
        for (let d = 0; d <= 2 * r; d++) out[(y + d) * W + x] = 1
      }
    }
    return out
  })
  dilated.set(m, list)
  return list
}

export function measure(placed: Placed[], frame: { width: number; height: number }, size: SizeKey): Metrics {
  const c = cellSize(size)
  const FW = Math.round(frame.width / c)
  const FH = Math.round(frame.height / c)
  const owner = new Int16Array(FW * FH).fill(-1)
  const origin = placed.map((p) => ({ x: Math.round(p.x / c), y: Math.round(p.y / c) }))

  // Сверху вниз: ячейка, уже занятая объектом выше, у нижнего считается закрытой
  const stats = placed.map(() => ({ inside: 0, hidden: 0, sx: 0, sy: 0, perched: 0 }))
  // Попарные наложения: overlap[нижний][верхний] — ячейки нижнего, закрытые верхним
  const overlap = placed.map(() => new Map<number, number>())
  // Поверхность — крупная плоская (книга, папка): на нее класть можно, на остальное — нет
  const isSurface = placed.map((p) => !!p.surface && p.mask.count / (FW * FH) >= LARGE)
  for (let i = placed.length - 1; i >= 0; i--) {
    const { mask } = placed[i]!
    const o = origin[i]!
    const s = stats[i]!
    for (let y = Math.max(0, -o.y); y < Math.min(mask.h, FH - o.y); y++) {
      const row = (o.y + y) * FW
      for (let x = Math.max(0, -o.x); x < Math.min(mask.w, FW - o.x); x++) {
        if (!mask.data[y * mask.w + x]) continue
        s.inside++
        const k = row + o.x + x
        if (owner[k]! >= 0) {
          s.hidden++
          if (!isSurface[i]) {
            stats[owner[k]!]!.perched++
            overlap[i]!.set(owner[k]!, (overlap[i]!.get(owner[k]!) ?? 0) + 1)
          }
        }
        else {
          owner[k] = i
          s.sx += o.x + x
          s.sy += o.y + y
        }
      }
    }
  }

  // Центр тяжести видимых частей: основные весят больше фоновых
  let wx = 0
  let wy = 0
  let wsum = 0
  let covered = 0
  stats.forEach((s, i) => {
    const w = placed[i]!.state === 'main' ? 1 : 0.5
    const seen = s.inside - s.hidden
    covered += seen
    wx += s.sx * w
    wy += s.sy * w
    wsum += seen * w
  })
  const balance = wsum ? Math.hypot(wx / wsum / FW - 0.5, wy / wsum / FH - 0.5) : 0

  // Близость: расширенная маска одного объекта пересекается с формой другого внутри кадра
  const near = (a: number, b: number, level: number): boolean => {
    const r = NEAR[level]!
    const da = dilations(placed[a]!.mask)[level]!
    const ma = placed[a]!.mask
    const mb = placed[b]!.mask
    const W = ma.w + 2 * r
    const ax = origin[a]!.x - r
    const ay = origin[a]!.y - r
    const ox = origin[b]!.x - ax
    const oy = origin[b]!.y - ay
    const y0 = Math.max(0, oy, -ay)
    const y1 = Math.min(ma.h + 2 * r, oy + mb.h, FH - ay)
    const x0 = Math.max(0, ox, -ax)
    const x1 = Math.min(W, ox + mb.w, FW - ax)
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        if (da[y * W + x] && mb.data[(y - oy) * mb.w + (x - ox)]) return true
      }
    }
    return false
  }
  const n = placed.length
  const level: number[][] = Array.from({ length: n }, () => new Array<number>(n).fill(NEAR.length))
  for (let a = 0; a < n; a++) {
    for (let b = a + 1; b < n; b++) {
      let l = 0
      while (l < NEAR.length && !near(a, b, l)) l++
      level[a]![b] = l
      level[b]![a] = l
    }
  }
  const reached = new Set([0])
  const queue = [0]
  while (queue.length) {
    const a = queue.pop()!
    for (let b = 0; b < n; b++) {
      if (!reached.has(b) && level[a]![b]! <= CLOSE) {
        reached.add(b)
        queue.push(b)
      }
    }
  }

  // Наложение пары — от меньшего объекта; у каждого объекта — худшая из его пар (и снизу, и сверху)
  const clash = placed.map(() => 0)
  overlap.forEach((m, lower) => {
    for (const [upper, cells] of m) {
      const v = cells / Math.min(placed[lower]!.mask.count, placed[upper]!.mask.count)
      clash[lower] = Math.max(clash[lower]!, v)
      clash[upper] = Math.max(clash[upper]!, v)
    }
  })
  const objects = placed.map((p, i): ObjectMetrics => {
    const s = stats[i]!
    return {
      itemId: p.itemId,
      state: p.state,
      visible: s.inside / p.mask.count,
      hidden: s.inside ? s.hidden / s.inside : 1,
      perched: s.inside - s.hidden ? s.perched / (s.inside - s.hidden) : 0,
      clash: clash[i]!,
      bleedBoth: bleedsBoth(p.mask, origin[i]!, FW, FH),
      size: p.mask.count / (FW * FH),
      surface: !!p.surface,
      gap: n > 1 ? Math.min(...level[i]!.filter((_, j) => j !== i)) : 0,
    }
  })
  return { objects, coverage: covered / (FW * FH), balance, connected: reached.size === n }
}

/** Срез двумя противоположными краями больше чем на 4% размера формы с каждой стороны */
function bleedsBoth(m: Mask, o: { x: number; y: number }, FW: number, FH: number): boolean {
  let x0 = Infinity
  let y0 = Infinity
  let x1 = -Infinity
  let y1 = -Infinity
  for (let y = 0; y < m.h; y++) {
    for (let x = 0; x < m.w; x++) {
      if (!m.data[y * m.w + x]) continue
      if (x < x0) x0 = x
      if (x > x1) x1 = x
      if (y < y0) y0 = y
      if (y > y1) y1 = y
    }
  }
  const w = x1 - x0 + 1
  const h = y1 - y0 + 1
  const left = -(o.x + x0)
  const right = o.x + x1 + 1 - FW
  const top = -(o.y + y0)
  const bottom = o.y + y1 + 1 - FH
  return (left > w * 0.04 && right > w * 0.04) || (top > h * 0.04 && bottom > h * 0.04)
}

/** Штраф за выход за норму: квадрат расстояния до допустимого диапазона */
const outside = (v: number, lo: number, hi: number) => (v < lo ? (lo - v) ** 2 : v > hi ? (v - hi) ** 2 : 0)

/** Штраф раскладки: 0 — в нормах примеров дизайнера; чем больше, тем дальше от того, как делает дизайнер */
export function penalty(m: Metrics): number {
  let p = 0
  for (const o of m.objects) {
    // Класть сверху можно только на крупную плоскую «поверхность» (книга, папка) — так делает дизайнер.
    // Пазл на букете или телефон на основании лампы выглядят нелепо: остальные объекты не закрываются
    const surface = o.surface && o.size >= LARGE
    if (o.state === 'bg' && o.size >= BG_MIN) {
      // Крупный фоновый объект — подложка: уходит за край, но читается. Закрыт — только если это поверхность
      // (книга у дизайнера закрыта до 19%; лампа — не закрыта; человек с растением однажды задет на 12% —
      // это допускаем только в его же примере, иначе пазл на букете или телефон на основании лампы)
      p += 40 * outside(o.visible, 0.42, 0.8) + 8 * Math.max(0, 0.42 - o.visible) + (surface ? 10 * outside(o.hidden, 0, 0.28) : 60 * outside(o.hidden, 0, 0.04))
    } else if (o.state === 'bg') {
      // Мелкий фоновый — фоновая деталь: у дизайнера так не бывает (небольшая доплата, чтобы первым шел вариант
      // в его духе), но ТЗ разрешает. Деталь видна целиком и ничем не закрыта
      p += 0.25 + 12 * outside(o.visible, 0.85, 1) + 40 * outside(o.hidden, 0, 0.06)
    } else if (surface) {
      p += 30 * outside(o.visible, 0.55, 1) + 10 * outside(o.hidden, 0, 0.35)
    } else {
      // Основной объект — главный герой: срез и тем более перекрытие видны сразу
      p += 12 * outside(o.visible, 0.75, 1) + 60 * outside(o.visible, 0.55, 1) + 300 * outside(o.hidden, 0, 0.005)
    }
    // Объект не лежит на том, на что класть нельзя (у дизайнера наушники заходят на фоновый горшок на ~5%)
    p += 80 * outside(o.perched, 0, 0.03)
    // Наложение на чужой объект — линейно и с первых долей процента: на тени или плече лампы, на букете
    // любой объект выглядит нелепо (у дизайнера — одно касание горшка наушниками, в эталоне)
    p += 15 * Math.max(0, o.clash - 0.005)
    // Основной объект срезан с двух противоположных сторон — у дизайнера он уходит за один край или в угол
    // (фоновую книгу-подложку дизайнер срезает и с двух сторон)
    if (o.bleedBoth && o.state === 'main') p += 0.6
    // Связность: соседи на расстоянии ступени CLOSE — норма, дальше — объекты разбросаны
    if (m.objects.length > 1) p += [0, 0, 0, 0.3, 0.8][o.gap] ?? 0.8
  }
  // Крупный основной объект в кадре один (так во всех примерах): второй делает кадр тяжелым и тесным
  const largeMains = m.objects.filter((o) => o.state === 'main' && o.size >= LARGE).length
  p += 0.5 * Math.max(0, largeMains - 1)
  // Срезан краем кадра заметно (меньше 90% видно) максимум один средний основной объект (кроме поверхности):
  // три срезанных объекта по углам выглядят тесно и случайно
  const cropped = m.objects.filter((o) => o.state === 'main' && !(o.surface && o.size >= LARGE) && o.size >= BG_MIN && o.visible < 0.9).length
  p += 0.35 * Math.max(0, cropped - 1)
  if (!m.connected) p += 0.3
  // Баланс: группа, сбитая в угол при пустой половине кадра, — частая несуразность; штраф растет быстро.
  // Допуск зависит от заполнения: у дизайнера смещение до 17% только в плотном кадре с крупной подложкой,
  // а при заполнении около 30% — не больше 3%
  const tolerance = 0.08 + 0.09 * Math.min(1, Math.max(0, (m.coverage - 0.3) / 0.15))
  const off = Math.max(0, m.balance - tolerance)
  p += 12 * outside(m.coverage, 0.28, 0.76) + 4 * off + 40 * off * off
  return p
}
