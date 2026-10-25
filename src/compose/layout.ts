import { itemSize, type Item } from './catalog'
import {
  SET,
  SIZE_FACTOR,
  formatSize,
  type Composition,
  type DecorKind,
  type FormatKey,
  type ObjState,
  type Role,
  type SizeKey,
  type Template,
  type TemplateSlot,
} from './model'
import { BG_MIN, LARGE, measure, penalty } from './aesthetics'
import { boxMask, cellSize, getMask } from './masks'

/**
 * Автоматическая раскладка. Основа — шаблоны из примеров дизайнера (6 композиций × 3 формата, scripts/build-set.mjs).
 * В шаблоне у каждой ячейки есть позиция, состояние (основной/фоновый) и объект, который в ней стоял.
 * Объекты пользователя распределяются по ячейкам так, чтобы размеры были ближе всего к исходным:
 * крупный объект — в ячейку крупного, мелкий — мелкого. Масштаб не меняется никогда.
 *
 * Позиция в ячейке сохраняет привязку к краю кадра: если исходный объект уходил за левый край, новый
 * ставится по правому краю ячейки (видимая часть остается на месте), если за правый — по левому, иначе по центру.
 * Если объекты совпадают с примером, раскладка совпадает с ним точно (это проверяет scripts/verify-compose.mjs).
 */

export type Placement = { itemId: string; state: ObjState; x: number; y: number; slot: number | null; colors?: Partial<Record<Role, Role>> }
export type Arrangement = {
  templateId: string | null
  mirror: boolean
  decor: Exclude<DecorKind, 'none'>
  placements: Placement[]
  cost: number
  /** Качество без бонуса эталона: им сравнивают наборы объектов между собой (cost у точной раскладки
   *  дизайнера занижен, чтобы она была первой среди раскладок, — для сравнения наборов это неверно) */
  quality: number
  /** Доля кадра, занятая объектами: меньше SPARSE — кадр полупустой */
  coverage: number
}

type Size = { width: number; height: number }
type Frame = { width: number; height: number }

/** Позиция по одной оси с привязкой к краю кадра (см. описание модуля) */
function anchored(x0: number, w0: number, w: number, frame: number): number {
  const offLow = x0 < -0.5
  const offHigh = x0 + w0 > frame + 0.5
  const a = offLow && !offHigh ? 1 : offHigh && !offLow ? 0 : 0.5
  return x0 + (w0 - w) * a
}

const slotItemSize = (slot: TemplateSlot, size: SizeKey): Size => {
  const [width, height] = SET.items[slot.item]![size]
  return { width, height }
}

/** Позиция объекта в ячейке шаблона для заданного формата и размера */
export function placeInSlot(slot: TemplateSlot, item: Size, size: SizeKey, frame: Frame): { x: number; y: number } {
  const k = SIZE_FACTOR[size]
  const orig = slotItemSize(slot, size)
  return {
    x: anchored(slot.x * k, orig.width, item.width, frame.width),
    y: anchored(slot.y * k, orig.height, item.height, frame.height),
  }
}

/** Доля площади объекта внутри кадра */
export function visibleShare(x: number, y: number, s: Size, frame: Frame): number {
  const w = Math.max(0, Math.min(x + s.width, frame.width) - Math.max(x, 0))
  const h = Math.max(0, Math.min(y + s.height, frame.height) - Math.max(y, 0))
  return (w * h) / (s.width * s.height)
}

/** Минимальная видимая доля: основной объект должен читаться, фоновый может почти целиком уходить за край */
const MIN_VISIBLE: Record<ObjState, number> = { main: 0.55, bg: 0.2 }

/** Сдвигаем объект к центру кадра, пока не станет видна нужная доля (для чужих объектов в ячейках шаблона) */
function ensureVisible(p: { x: number; y: number }, s: Size, state: ObjState, frame: Frame): { x: number; y: number } {
  let { x, y } = p
  const cx = (frame.width - s.width) / 2
  const cy = (frame.height - s.height) / 2
  for (let i = 0; i < 20 && visibleShare(x, y, s, frame) < MIN_VISIBLE[state]; i++) {
    x += (cx - x) * 0.15
    y += (cy - y) * 0.15
  }
  return { x, y }
}

const round2 = (v: number) => Math.round(v * 100) / 100

/** Свободное место для объекта сверх ячеек шаблона: минимум перекрытия с уже стоящими и выхода за кадр */
function freeSpot(s: Size, frame: Frame, placed: Array<{ x: number; y: number } & Size>): { x: number; y: number } {
  let best = { x: (frame.width - s.width) / 2, y: (frame.height - s.height) / 2 }
  let bestCost = Infinity
  const steps = 8
  for (let i = 0; i <= steps; i++) {
    for (let j = 0; j <= steps; j++) {
      const x = (frame.width - s.width) * (i / steps)
      const y = (frame.height - s.height) * (j / steps)
      let overlap = 0
      for (const r of placed) {
        const ow = Math.max(0, Math.min(x + s.width, r.x + r.width) - Math.max(x, r.x))
        const oh = Math.max(0, Math.min(y + s.height, r.y + r.height) - Math.max(y, r.y))
        overlap += ow * oh
      }
      // Небольшое предпочтение центру: при равном перекрытии объект не прилипает к углу
      const dc = Math.hypot(x + s.width / 2 - frame.width / 2, y + s.height / 2 - frame.height / 2) / Math.hypot(frame.width, frame.height)
      const cost = overlap / (s.width * s.height) + (1 - visibleShare(x, y, s, frame)) * 2 + dc * 0.2
      if (cost < bestCost) {
        bestCost = cost
        best = { x, y }
      }
    }
  }
  return best
}

function permutations<T>(list: T[]): T[][] {
  if (list.length <= 1) return [list]
  return list.flatMap((x, i) => permutations([...list.slice(0, i), ...list.slice(i + 1)]).map((p) => [x, ...p]))
}

function combinations(n: number, k: number): number[][] {
  if (k === 0) return [[]]
  if (n < k) return []
  return [...combinations(n - 1, k - 1).map((c) => [...c, n - 1]), ...combinations(n - 1, k)]
}

const area = (s: Size) => s.width * s.height

/** Кадр меньше чем на эту долю занят объектами — полупустой (у дизайнера минимум 29%) */
export const SPARSE = 0.22

/** Крупный объект: может держать композицию как фон */
export function isLarge(item: Item, format: FormatKey, size: SizeKey): boolean {
  const s = itemSize(item, size, 'main') ?? itemSize(item, size, 'bg')
  return !!s && relativeSize(item, s, size, formatSize(format, size)) >= LARGE
}

/** Площадь формы объекта относительно кадра (по маске; пока маски нет — половина рамки) */
function relativeSize(item: Item, s: Size, size: SizeKey, frame: Frame): number {
  const mask = getMask(item.id, size)
  const c = cellSize(size)
  return mask ? (mask.count * c * c) / area(frame) : (area(s) * 0.5) / area(frame)
}

/**
 * Как дизайнер ставил объект: только фоновым (лампа, человек с растением) или и основным. Крупный объект,
 * который у дизайнера бывает только фоновым, основным в кадре выглядит тяжелым — небольшая доплата за это
 */
const ONLY_BG = new Set(
  Object.keys(SET.items).filter((id) => {
    const states = SET.templates.flatMap((t) => Object.values(t.formats).flatMap((f) => f.slots.filter((s) => s.item === id).map((s) => s.state)))
    return states.length > 0 && states.every((s) => s === 'bg')
  }),
)

/** Плоские объекты, на которые дизайнер кладет другие: основной объект в самом низу шаблона (книга, папка) */
const SURFACE = new Set(
  SET.templates.flatMap((t) => Object.values(t.formats).flatMap((f) => (f.slots.length > 1 && f.slots[0]!.state === 'main' ? [f.slots[0]!.item] : []))),
)

/** Бонус точной раскладки дизайнера (в единицах fit): она — эталон и первая среди раскладок */
const EXACT_BONUS = 10

/** Вес похожести на шаблон дизайнера относительно штрафа формы (aesthetics.ts) */
const FIT_WEIGHT = 0.4
/** Сколько вариантов доводить локальным поиском и показывать в «Другом» */
const SHOWN = 10
/** Больше стольких объектов — перебор состояний сокращается (иначе сотни кандидатов) */
const MANY = 4
/** Бюджет времени на доводку вариантов, мс: дальше вкладка заметно «думает» */
const BUDGET_MS = 300
/**
 * «Другой вариант» листает варианты не хуже лучшего на VARIANT_SLACK. Если таких меньше трех, добирает до трех
 * из тех, что хуже не больше чем на VARIANT_EXTRA: явно слабые раскладки не показываются ради количества
 */
const VARIANT_SLACK = 1
const VARIANT_EXTRA = 0.6
/**
 * Разнообразие «Другого»: доплата за то, что вариант повторяет уже показанный — тот же набор фоновых объектов
 * или тот же шаблон. Так подряд идут разные по сути варианты, а не сдвиги одного и того же
 */
const SAME_STATES = 0.45
const SAME_TEMPLATE = 0.25

/** Какие объекты в варианте фоновые — главное, чем варианты различаются для глаза */
const statesKey = (c: Candidate) => c.placements.filter((p) => p.state === 'bg').map((p) => p.itemId).sort().join()

/** Жадный выбор: каждый следующий — лучший с учетом доплаты за похожесть на уже выбранные */
function diverse(list: Candidate[], limit: number, maxCost: number): Candidate[] {
  const out: Candidate[] = []
  const pool = list.filter((c) => c.cost <= maxCost)
  while (out.length < limit && pool.length) {
    let bi = 0
    let bv = Infinity
    pool.forEach((c, i) => {
      const v =
        c.cost +
        SAME_STATES * out.filter((o) => statesKey(o) === statesKey(c)).length +
        SAME_TEMPLATE * out.filter((o) => o.templateId === c.templateId && o.mirror === c.mirror).length
      if (v < bv) {
        bv = v
        bi = i
      }
    })
    out.push(pool.splice(bi, 1)[0]!)
  }
  return out
}

/** readable — все объекты читаются (жесткие правила, как в автопроверке); нечитаемый вариант «Другой» не показывает */
type Candidate = Omit<Arrangement, 'quality'> & { fit: number; exact: boolean; sizes: Size[]; readable?: boolean }

/** Штраф формы раскладки + плата за уход от исходных позиций (держит структуру шаблона) */
function shapeScore(c: Candidate, start: Placement[], format: FormatKey, size: SizeKey): number {
  const frame = formatSize(format, size)
  const placed = c.placements.map((p, i) => ({
    itemId: p.itemId,
    state: p.state,
    x: p.x,
    y: p.y,
    mask: getMask(p.itemId, size) ?? boxMask(c.sizes[i]!.width, c.sizes[i]!.height, size),
    surface: SURFACE.has(p.itemId),
  }))
  const m = measure(placed, frame, size)
  c.coverage = m.coverage
  c.readable = m.objects.every((o) =>
    o.state === 'bg' ? o.visible >= 0.35 : o.visible >= 0.5 && (o.size >= LARGE || o.hidden <= 0.15),
  )
  const diag = Math.hypot(frame.width, frame.height)
  const drift = c.placements.reduce((sum, p, i) => sum + (Math.hypot(p.x - start[i]!.x, p.y - start[i]!.y) / diag) ** 2, 0)
  return penalty(m) + drift
}

const DIRS = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
  [1, 1],
  [1, -1],
  [-1, 1],
  [-1, -1],
] as const

/**
 * Доводка позиций локальным поиском: каждый объект пробует шаг в 8 направлениях, шаг уменьшается от 8% до 1%
 * кадра. Принимается любое улучшение оценки. Детерминированно: одни и те же объекты дают одну и ту же раскладку
 */
function polish(c: Candidate, format: FormatKey, size: SizeKey, deadline = Infinity): number {
  const frame = formatSize(format, size)
  const start = c.placements.map((p) => ({ ...p }))
  let best = shapeScore(c, start, format, size)
  const span = Math.max(frame.width, frame.height)
  for (const k of [0.08, 0.04, 0.02, 0.01]) {
    const step = span * k
    // Бюджет времени: сборка не должна подвешивать вкладку (10 объектов — сотни кандидатов)
    for (let pass = 0, improved = true; improved && pass < 8 && performance.now() < deadline; pass++) {
      improved = false
      for (const p of c.placements) {
        for (const [dx, dy] of DIRS) {
          const x0 = p.x
          const y0 = p.y
          p.x = round2(x0 + dx * step)
          p.y = round2(y0 + dy * step)
          const s = shapeScore(c, start, format, size)
          if (s < best - 1e-6) {
            best = s
            improved = true
          } else {
            p.x = x0
            p.y = y0
          }
        }
      }
    }
  }
  shapeScore(c, start, format, size) // метрики (заполнение) — для принятых позиций, а не последней пробы
  return best
}

/**
 * Варианты раскладки, от лучшего к худшему. «Другой вариант» в интерфейсе листает этот список.
 * Кандидаты — шаблоны дизайнера (и их зеркала) с объектами пользователя в ячейках. Каждый оценивается по формам
 * объектов (aesthetics.ts) и похожести на шаблон, лучшие доводятся локальным поиском. Точная раскладка
 * дизайнера (те же объекты в своих ячейках) не доводится — она и есть эталон
 */
/**
 * noBg — в схеме меньше двух различимых цветов фона: фоновый объект (он рисуется только цветами фона)
 * слился бы с фоном, поэтому все объекты остаются основными. hero — главный по смыслу объект (метафора):
 * он остается основным, фоновыми становятся дополняющие
 */
export function arrangements(
  items: readonly Item[],
  format: FormatKey,
  size: SizeKey,
  templates: readonly Template[] = SET.templates,
  { noBg = false, bestOnly = false, hero, budget = BUDGET_MS }: { noBg?: boolean; bestOnly?: boolean; hero?: string; budget?: number } = {},
): Arrangement[] {
  const frame = formatSize(format, size)
  const sized = items.flatMap((item) => {
    const s = itemSize(item, size, 'main')
    return s ? [{ item, s }] : []
  })
  if (!sized.length) return []
  const raw: Candidate[] = []
  const byId = (id: string) => items.find((i) => i.id === id)!
  const hasBg = (item: Item) => !!item.variants[`${size}-bg`]

  // Один объект: по центру, основной. Плюс его же в основных ячейках шаблонов — для разнообразия
  if (sized.length === 1) {
    const { item, s } = sized[0]!
    raw.push({
      templateId: null,
      mirror: false,
      decor: 'circles',
      cost: 0,
      coverage: 0,
      fit: 0,
      exact: false,
      sizes: [s],
      placements: [{ itemId: item.id, state: 'main', x: round2((frame.width - s.width) / 2), y: round2((frame.height - s.height) / 2), slot: null }],
    })
  }

  for (const t of templates) {
    const tf = t.formats[format]
    const slots = tf.slots
    // Если объектов больше, чем ячеек, в ячейки идут самые крупные, остальные — на свободное место
    const byArea = [...sized].sort((a, b) => area(b.s) - area(a.s))
    const core = byArea.slice(0, slots.length)
    const extra = byArea.slice(slots.length)
    const m = core.length
    let best: { cost: number; slotIdx: number[]; perm: typeof core } | null = null
    for (const slotIdx of combinations(slots.length, m)) {
      for (const perm of permutations(core)) {
        // Шаблон с лишними ячейками хуже подходящего по числу. Пустая фоновая ячейка — сильно хуже:
        // крупный фоновый объект держит композицию, без него кадр пустеет
        const used = new Set(slotIdx)
        let cost = slots.reduce((sum, sl, i) => sum + (used.has(i) ? 0 : sl.state === 'bg' ? 2 : 0.6), 0)
        perm.forEach((c, i) => {
          const slot = slots[slotIdx[i]!]!
          const orig = slotItemSize(slot, size)
          cost += Math.abs(Math.log(area(c.s) / area(orig)))
          cost += Math.abs(Math.log(c.s.width / c.s.height / (orig.width / orig.height))) * 0.3
          if (c.item.id === slot.item) cost -= 0.25 // объект на своем месте из примера
          if (m === 1 && slot.state === 'bg') cost += 1 // одиночный объект не прячем в фон
        })
        if (!best || cost < best.cost) best = { cost, slotIdx, perm }
      }
    }
    if (!best) continue
    const placed: Array<{ x: number; y: number } & Size> = []
    const placements: Placement[] = []
    const sizes: Size[] = []
    // Порядок слоев — как в шаблоне
    const order = best.slotIdx.map((si, i) => ({ si, c: best.perm[i]! })).sort((a, b) => a.si - b.si)
    for (const { si, c } of order) {
      const slot = slots[si]!
      // Мелкий объект в фоновой ячейке остается основным: фоновым у дизайнера бывает только крупный
      const small = relativeSize(c.item, c.s, size, frame) < BG_MIN
      // Фоновым — только при наличии фонового варианта (у загруженного объекта его может не быть)
      const state: ObjState = m === 1 || noBg || (slot.state === 'bg' && (small || !hasBg(c.item))) ? 'main' : slot.state
      const s = itemSize(c.item, size, state) ?? c.s
      let p = placeInSlot(slot, s, size, frame)
      if (c.item.id !== slot.item) p = ensureVisible(p, s, state, frame)
      // Перекраска дизайнера переносится, только если в ячейке тот же объект: чужому она не подходит
      const colors = c.item.id === slot.item && state === slot.state ? slot.colors : undefined
      placements.push({ itemId: c.item.id, state, x: round2(p.x), y: round2(p.y), slot: si, ...(colors ? { colors } : {}) })
      sizes.push(s)
      if (state === 'main') placed.push({ ...p, ...s })
    }
    for (const e of extra) {
      const p = freeSpot(e.s, frame, placed)
      placements.push({ itemId: e.item.id, state: 'main', x: round2(p.x), y: round2(p.y), slot: null })
      sizes.push(e.s)
      placed.push({ ...p, ...e.s })
    }
    const exact = !extra.length && m === slots.length && order.every(({ si, c }) => c.item.id === slots[si]!.item)
    const fit = best.cost + extra.length * 0.5
    raw.push({ templateId: t.id, mirror: false, decor: tf.decor, cost: fit, coverage: 0, fit, exact, sizes, placements })
  }

  // Состояния — тоже вариант: фоновым по очереди становится каждый объект (и мелкий), плюс «все основные».
  // ТЗ разрешает объекту менять состояние; первым все равно останется вариант в духе дизайнера (оценка)
  const withState = (a: Candidate, bg: Set<number>): Candidate => ({
    ...a,
    exact: false,
    fit: a.fit + 0.2,
    placements: a.placements.map((p, i) => {
      const state: ObjState = bg.has(i) ? 'bg' : 'main'
      // Копия, а не тот же объект: доводка двигает позиции на месте и сдвинула бы исходного кандидата
      return state === p.state ? { ...p } : { ...p, state, colors: undefined }
    }),
  })
  // При многих объектах вариантов «каждый фоновый» становятся десятки на шаблон — только «все основные»
  if (!noBg && sized.length > 1) {
    for (const a of [...raw]) {
      const key = (bg: Set<number>) => a.placements.map((_, i) => (bg.has(i) ? 'b' : 'm')).join('')
      const current = key(new Set(a.placements.flatMap((p, i) => (p.state === 'bg' ? [i] : []))))
      const options = (sized.length <= MANY ? [new Set<number>(), ...a.placements.map((_, i) => new Set([i]))] : [new Set<number>()]).filter(
        (bg) => [...bg].every((i) => hasBg(byId(a.placements[i]!.itemId))),
      )
      for (const bg of options) if (key(bg) !== current) raw.push(withState(a, bg))
    }
  }

  // Несколько крупных основных объектов: варианты, где лишние становятся фоновыми и уходят под остальные.
  // У дизайнера крупный основной объект в кадре один, а состояние объекта менять разрешено
  for (const a of [...raw]) {
    const large = a.placements.flatMap((p, i) =>
      p.state === 'main' && relativeSize(items.find((x) => x.id === p.itemId)!, a.sizes[i]!, size, frame) >= LARGE ? [i] : [],
    )
    if (large.length < 2 || noBg) continue
    // Какой крупный оставить основным: при многих объектах — только самый крупный, иначе каждый по очереди
    const keeps = sized.length <= MANY ? large : [large.reduce((x, y) => (area(a.sizes[y]!) > area(a.sizes[x]!) ? y : x))]
    for (const keep of keeps) {
      const toBg = new Set(large.filter((i) => i !== keep))
      if (![...toBg].every((i) => hasBg(byId(a.placements[i]!.itemId)))) continue
      const order = [...a.placements.keys()].sort((i, j) => Number(toBg.has(j)) - Number(toBg.has(i)) || i - j)
      raw.push({
        ...a,
        exact: false,
        fit: a.fit + 0.2,
        sizes: order.map((i) => a.sizes[i]!),
        placements: order.map((i) => {
          const p = a.placements[i]!
          return toBg.has(i) ? { ...p, state: 'bg' as const, colors: undefined } : { ...p }
        }),
      })
    }
  }

  // Зеркальные варианты: раскладка отражается по горизонтали, сами объекты — нет
  for (const a of raw.filter((x) => x.templateId)) {
    raw.push({
      ...a,
      mirror: true,
      exact: false,
      fit: a.fit + 0.05,
      placements: a.placements.map((p, i) => ({ ...p, x: round2(frame.width - p.x - a.sizes[i]!.width) })),
    })
  }

  // Герой метафоры (главный по смыслу объект) — основной: бледный фоновый герой теряет смысл композиции
  // Крупный герой (лампа) может быть подложкой — так у дизайнера; в основном он не влезает в кадр
  const heroItem = hero ? items.find((i) => i.id === hero) : undefined
  if (heroItem && !isLarge(heroItem, format, size)) {
    for (const c of raw) if (c.placements.some((p) => p.itemId === hero && p.state === 'bg')) c.fit += 3
  }

  // Крупный объект, который у дизайнера только фоновый, — основным
  for (const c of raw) {
    c.fit += 0.8 * c.placements.filter((p, i) => p.state === 'main' && ONLY_BG.has(p.itemId) && relativeSize(items.find((x) => x.id === p.itemId)!, c.sizes[i]!, size, frame) >= LARGE).length
  }

  // Фоновые объекты — под основными (у дизайнера фоновый объект основной не перекрывает).
  // Точная раскладка дизайнера — эталон: ее порядок не трогаем, и она всегда первая
  for (const c of raw) {
    if (c.exact) {
      // Эталон: первый при любых нормах (в размере S маски грубее, и строгие нормы могли бы задеть сам пример)
      c.fit -= EXACT_BONUS
      continue
    }
    const order = [...c.placements.keys()].sort((i, j) => Number(c.placements[i]!.state === 'main') - Number(c.placements[j]!.state === 'main') || i - j)
    c.placements = order.map((i) => c.placements[i]!)
    c.sizes = order.map((i) => c.sizes[i]!)
  }

  // Первичная оценка всех кандидатов. Доводятся разные по сути кандидаты (жадный выбор с доплатой за похожесть):
  // доводка сильно улучшает раскладку, поэтому берем с запасом по стоимости
  for (const c of raw) c.cost = FIT_WEIGHT * c.fit + shapeScore(c, c.placements, format, size)
  raw.sort((a, b) => a.cost - b.cost)
  const first = (raw.find((c) => !c.exact) ?? raw[0]!).cost
  // Запас по стоимости — с ростом штрафа (тесный кадр) растет и разброс между кандидатами
  const picked = bestOnly ? raw.slice(0, 3) : diverse(raw, SHOWN + 4, first + Math.max(3, Math.abs(first) * 0.5))
  // Каждое состояние (кто фоновый) — хотя бы одним кандидатом, даже если по первичной оценке он дальше порога:
  // после доводки он часто становится хорошим, а «Другой» должен показывать и такие варианты
  if (!bestOnly && sized.length <= MANY) {
    for (const c of raw) if (!picked.some((p) => statesKey(p) === statesKey(c))) picked.push(c)
  }
  // Доводка — в бюджете времени; лучшие по первичной оценке доводятся первыми, не успевшие остаются как есть
  const deadline = performance.now() + (bestOnly ? 80 : budget)
  for (const c of [...picked].sort((a, b) => a.cost - b.cost)) {
    if (!c.exact && performance.now() < deadline) c.cost = FIT_WEIGHT * c.fit + polish(c, format, size, deadline)
  }
  picked.sort((a, b) => a.cost - b.cost)

  // Одинаковые раскладки (разные шаблоны могут дать одно и то же) показываем один раз
  const seen = new Set<string>()
  const unique = picked.filter((a) => {
    const key = a.placements.map((p) => `${p.itemId}:${p.state}:${Math.round(p.x / 20)}:${Math.round(p.y / 20)}`).join('|')
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
  // Нечитаемые варианты (объект срезан или закрыт) не показываются, если есть хоть один читаемый
  const readable = unique.filter((c) => c.exact || c.readable !== false)
  const pool = readable.length ? readable : unique
  const best = pool[0]!
  // Порог качества — от лучшего обычного варианта: у точной раскладки дизайнера бонус эталона, и от нее
  // порог отсек бы все остальные шаблоны
  const top = (pool.find((c) => !c.exact) ?? best).cost
  // В тесном кадре (много объектов) у всех вариантов большой штраф, и разброс тоже большой: порог растет вместе с ним
  const slack = Math.max(VARIANT_SLACK, Math.abs(top) * 0.3)
  const good = pool.filter((a, i) => a === best || a.cost <= top + slack || (i < 3 && a.cost <= top + slack + VARIANT_EXTRA))
  // Каждое состояние, которое удалось сделать читаемым, попадает в «Другой» (лучший вариант с этим состоянием)
  for (const c of pool) if (c.cost <= top + slack + 0.3 && !good.some((g) => statesKey(g) === statesKey(c))) good.push(c)
  // Первый — лучший; дальше — по разнообразию
  const ordered = [best, ...diverse(good.filter((c) => c !== best), SHOWN - 1, Infinity)]
  return ordered.map(({ templateId, mirror, decor, placements, cost, coverage, exact }) => ({
    templateId,
    mirror,
    decor,
    placements,
    cost,
    quality: exact ? cost + FIT_WEIGHT * EXACT_BONUS : cost,
    coverage,
  }))
}

/**
 * Смена формата или размера. При смене формата объекты из ячеек шаблона встают в те же ячейки нового формата
 * (так дизайнер перекладывал примеры между форматами); добавленные вручную сохраняют относительное положение центра.
 * Смена размера L↔S масштабирует позиции вдвое — сами объекты подменяются вариантами нужного размера.
 */
export function relayout(
  c: Composition,
  next: { format: FormatKey; size: SizeKey },
  lookup: (itemId: string) => Item | undefined,
  templates: readonly Template[] = SET.templates,
): Pick<Composition, 'objects' | 'layout'> {
  const from = formatSize(c.format, c.size)
  const to = formatSize(next.format, next.size)
  const template = c.layout ? templates.find((t) => t.id === c.layout!.templateId) : undefined
  // Ячейки шаблона — только при смене формата: при смене размера ручные правки сохраняются (позиции ×2 или ÷2).
  // Ячейку в новом формате ищем по объекту, который в ней стоял у дизайнера: порядок ячеек в форматах разный
  const newSlot = (id: string): number | undefined => {
    const i = c.layout?.slots[id]
    if (!template || i === undefined || next.format === c.format) return undefined
    const old = template.formats[c.format].slots[i]
    const j = old ? template.formats[next.format].slots.findIndex((s) => s.item === old.item) : -1
    return j >= 0 ? j : undefined
  }
  const slotOf = new Map(c.objects.flatMap((o) => {
    const j = newSlot(o.id)
    return j === undefined ? [] : [[o.id, j] as const]
  }))
  const objects = c.objects.map((o) => {
    const item = lookup(o.itemId)
    const sOld = item && itemSize(item, c.size, o.state)
    const sNew = item && itemSize(item, next.size, o.state)
    if (!sOld || !sNew) return o
    const j = slotOf.get(o.id)
    const slot = j !== undefined ? template!.formats[next.format].slots[j] : undefined
    if (slot) {
      let p = placeInSlot(slot, sNew, next.size, to)
      if (item.id !== slot.item) p = ensureVisible(p, sNew, o.state, to)
      const x = c.layout!.mirror ? to.width - p.x - sNew.width : p.x
      return { ...o, x: round2(x), y: round2(p.y) }
    }
    const cx = ((o.x + sOld.width / 2) / from.width) * to.width
    const cy = ((o.y + sOld.height / 2) / from.height) * to.height
    return { ...o, x: round2(cx - sNew.width / 2), y: round2(cy - sNew.height / 2) }
  })
  if (!slotOf.size) return { objects, layout: c.layout }
  // Порядок слоев объектов из ячеек — как в новом формате (места в списке слоев они меняют только между собой)
  const placed = objects.filter((o) => slotOf.has(o.id)).sort((a, b) => slotOf.get(a.id)! - slotOf.get(b.id)!)
  let k = 0
  const ordered = objects.map((o) => (slotOf.has(o.id) ? placed[k++]! : o))
  return { objects: ordered, layout: { ...c.layout!, slots: Object.fromEntries(slotOf) } }
}

/** Оценка готовой композиции по нормам дизайнера (та же, что при автосборке): метрики и штраф */
export function scoreComposition(c: Pick<Composition, 'objects' | 'format' | 'size'>, lookup: (itemId: string) => Item | undefined) {
  const placed = c.objects.flatMap((o) => {
    const item = lookup(o.itemId)
    const s = item && itemSize(item, c.size, o.state)
    if (!s) return []
    return [{ itemId: o.itemId, state: o.state, x: o.x, y: o.y, mask: getMask(o.itemId, c.size) ?? boxMask(s.width, s.height, c.size), surface: SURFACE.has(o.itemId) }]
  })
  const metrics = measure(placed, formatSize(c.format, c.size), c.size)
  return { metrics, penalty: penalty(metrics) }
}
