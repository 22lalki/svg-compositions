import type { SourceModel, SourceShape } from './extract'
import { listShapes } from './extract'

/**
 * Логические объекты исходника (персонаж, животное, предмет) для выделения одним кликом.
 * Встроенные исходники (и загруженные копии тех же иллюстраций) размечены вручную (public/sources/objects.json),
 * эта эвристика — для остальных загруженных SVG; ее точность на эталонной разметке меряет scripts/eval-objects.mjs.
 *
 * 1. Группа верхнего уровня — готовый объект: в unDraw персонажи и животные часто сгруппированы
 *    (девушка, собака и косточка в 02, мужчина в 07, девушка и пес в 04). Группа почти со всеми фигурами
 *    рисунка (≥ 85%, как обертка из Figma) считается контейнером, объекты ищутся внутри нее.
 *    Группа с подложкой внутри — сцена: объекты ищутся в ней. Повторяющийся мелкий предмет из 2–3 фигур
 *    (летящая купюра, брызга) — тоже готовая единица.
 * 2. Плоские фигуры собираются в прогоны: иллюстрацию рисуют объект за объектом, поэтому фигура
 *    продолжает текущий прогон, если касается его по реальной форме (растровые маски с допуском)
 *    или стоит вплотную, как строки текста. Две крупные формы, лишь краем наложенные друг на друга
 *    (кроны соседних деревьев), и пересекающиеся длинные линии (орбиты) прогон не связывают;
 *    ряд одинаковых фигур (фестоны навеса) начинает новый прогон.
 * 3. Обрывки (до 3 фигур: шапка, ботинки, арка колеса) присоединяются к соседнему по порядку объекту,
 *    которого касаются, — если между ними нет другого полноценного объекта. Деталь, лежащая на объекте
 *    или внутри его контура (звезды в окне, глаз собаки, волосы), присоединяется к нему на любом расстоянии;
 *    так же — многодетальный узел, целиком лежащий на объекте (крестовина на корпусе геймпада), если только он
 *    не внутри объекта (продавщица в окне фургона за навесом и прилавком). Порядок весомее геометрии: деталь,
 *    нарисованная между частями мужчины, — его, даже если лежит на борту фургона.
 * 4. Прогоны, нарисованные вперемешку (рука, торс, брюки, снова рука) или сильно наложенные (пальто на торсе),
 *    — один объект.
 * 5. Фон — отдельный объект: земля во всю ширину, подложка на весь рисунок или на большую часть нарисованного
 *    вместе со своими слоями, разделителями и подставкой (рамка и экран монитора, ножка). Фигура на весь
 *    рисунок, которую перекрывают другие крупные части, — тело единственного объекта (банка, геймпад), а не фон.
 * 6. Рассыпанная мелочь одного вида (звезды, снег, монеты, купюры в полете) — один объект.
 */

const MASK_SIZE = 360 // длинная сторона растра для масок
const ALPHA_MIN = 40
/** Допуск касания в пикселях растра (~1,4% рисунка): стекла окна за тонкой рамкой — один объект */
const TOUCH_TOL = 5

/** Маска формы в пикселях растра; opaque — фигура не полупрозрачная тень или блик */
type Mask = { x0: number; y0: number; w: number; h: number; data: Uint8Array; count: number; opaque?: boolean }

type Cluster = {
  shapes: number[]
  group: boolean
  background: boolean
  /** Детали, присоединенные как лежащие поверх (звезды в окне, снег на елке): не растягивают объект по порядку */
  overlays: Set<number>
}

function shapePath(el: SVGGeometryElement): Path2D | null {
  const p = new Path2D()
  switch (el.localName) {
    case 'path':
      return new Path2D(el.getAttribute('d') ?? '')
    case 'rect': {
      const r = el as SVGRectElement
      p.rect(r.x.baseVal.value, r.y.baseVal.value, r.width.baseVal.value, r.height.baseVal.value)
      return p
    }
    case 'circle': {
      const c = el as SVGCircleElement
      p.arc(c.cx.baseVal.value, c.cy.baseVal.value, c.r.baseVal.value, 0, Math.PI * 2)
      return p
    }
    case 'ellipse': {
      const e = el as SVGEllipseElement
      p.ellipse(e.cx.baseVal.value, e.cy.baseVal.value, e.rx.baseVal.value, e.ry.baseVal.value, 0, 0, Math.PI * 2)
      return p
    }
    case 'polygon':
    case 'polyline': {
      const pts = Array.from((el as SVGPolygonElement).points)
      pts.forEach((pt, i) => (i ? p.lineTo(pt.x, pt.y) : p.moveTo(pt.x, pt.y)))
      if (el.localName === 'polygon') p.closePath()
      return p
    }
    case 'line': {
      const l = el as SVGLineElement
      p.moveTo(l.x1.baseVal.value, l.y1.baseVal.value)
      p.lineTo(l.x2.baseVal.value, l.y2.baseVal.value)
      return p
    }
  }
  return null
}

/** Растровые маски фигур в общей сетке (координаты корня → пиксели) */
function buildMasks(model: SourceModel): Mask[] {
  const vb = model.viewBox
  const s = MASK_SIZE / Math.max(vb.width, vb.height)
  const W = Math.ceil(vb.width * s) + 2
  const H = Math.ceil(vb.height * s) + 2
  const canvas = document.createElement('canvas')
  canvas.width = W
  canvas.height = H
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!
  return model.shapes.map((shape) => {
    const empty: Mask = { x0: 0, y0: 0, w: 0, h: 0, data: new Uint8Array(0), count: 0 }
    const path = shapePath(shape.el)
    if (!path) return empty
    const cs = getComputedStyle(shape.el)
    if (cs.display === 'none' || cs.visibility === 'hidden' || parseFloat(cs.opacity) === 0) return empty
    const b = shape.bbox
    const x0 = Math.max(0, Math.floor((b.x - vb.x) * s))
    const y0 = Math.max(0, Math.floor((b.y - vb.y) * s))
    const x1 = Math.min(W, Math.ceil((b.x + b.width - vb.x) * s) + 3)
    const y1 = Math.min(H, Math.ceil((b.y + b.height - vb.y) * s) + 3)
    if (x1 <= x0 || y1 <= y0) return empty
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.clearRect(x0, y0, x1 - x0, y1 - y0)
    const m = shape.matrix
    ctx.setTransform(s * m[0], s * m[1], s * m[2], s * m[3], s * (m[4] - vb.x) + 1, s * (m[5] - vb.y) + 1)
    ctx.fillStyle = '#000'
    ctx.strokeStyle = '#000'
    if (cs.fill !== 'none' && parseFloat(cs.fillOpacity) !== 0) ctx.fill(path, cs.fillRule === 'evenodd' ? 'evenodd' : 'nonzero')
    const sw = parseFloat(cs.strokeWidth) || 0
    if (cs.stroke !== 'none' && sw > 0) {
      ctx.lineWidth = sw
      ctx.stroke(path)
    }
    const img = ctx.getImageData(x0, y0, x1 - x0, y1 - y0).data
    const data = new Uint8Array((x1 - x0) * (y1 - y0))
    let count = 0
    for (let i = 0; i < data.length; i++) {
      if (img[i * 4 + 3]! > ALPHA_MIN) {
        data[i] = 1
        count++
      }
    }
    const alpha = parseFloat(cs.opacity) * (cs.fill !== 'none' ? parseFloat(cs.fillOpacity) : 1)
    return { x0, y0, w: x1 - x0, h: y1 - y0, data, count, opaque: alpha >= 0.5 }
  })
}

const at = (m: Mask, x: number, y: number) =>
  x >= m.x0 && y >= m.y0 && x < m.x0 + m.w && y < m.y0 + m.h && m.data[(y - m.y0) * m.w + (x - m.x0)] === 1

const dilatedCache = new WeakMap<Mask, Mask>()

/** Маска, расширенная на r пикселей во все стороны (раздельный max-фильтр) */
function dilated(m: Mask, r = TOUCH_TOL): Mask {
  const cached = dilatedCache.get(m)
  if (cached) return cached
  const w = m.w + 2 * r
  const h = m.h + 2 * r
  const horiz = new Uint8Array(w * h)
  for (let y = 0; y < m.h; y++) {
    for (let x = 0; x < m.w; x++) {
      if (!m.data[y * m.w + x]) continue
      const row = (y + r) * w
      for (let dx = 0; dx <= 2 * r; dx++) horiz[row + x + dx] = 1
    }
  }
  const data = new Uint8Array(w * h)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!horiz[y * w + x]) continue
      for (let dy = -r; dy <= r; dy++) {
        const yy = y + dy
        if (yy >= 0 && yy < h) data[yy * w + x] = 1
      }
    }
  }
  const out = { x0: m.x0 - r, y0: m.y0 - r, w, h, data, count: m.count }
  dilatedCache.set(m, out)
  return out
}

/** Тонкий контур: закрашено не больше трети рамки фигуры */
const hollow = (m: Mask) => m.count > 0 && m.count <= 0.35 * m.w * m.h

/** Касаются ли формы (с допуском TOUCH_TOL пикселей растра) */
function touches(a: Mask, b: Mask): boolean {
  if (!a.count || !b.count) return false
  const da = dilated(a)
  const x0 = Math.max(da.x0, b.x0)
  const y0 = Math.max(da.y0, b.y0)
  const x1 = Math.min(da.x0 + da.w, b.x0 + b.w)
  const y1 = Math.min(da.y0 + da.h, b.y0 + b.h)
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      if (at(b, x, y) && at(da, x, y)) return true
    }
  }
  return false
}

/** Доля пикселей формы x, закрытых фигурами набора */
function coverage(x: Mask, all: Mask[]): number {
  if (!x.count) return 0
  const shapes = all.filter((m) => m.count && m.x0 < x.x0 + x.w && x.x0 < m.x0 + m.w && m.y0 < x.y0 + x.h && x.y0 < m.y0 + m.h)
  if (!shapes.length) return 0
  let covered = 0
  for (let yy = 0; yy < x.h; yy++) {
    for (let xx = 0; xx < x.w; xx++) {
      if (!x.data[yy * x.w + xx]) continue
      const px = x.x0 + xx
      const py = x.y0 + yy
      if (shapes.some((m) => at(m, px, py))) covered++
    }
  }
  return covered / x.count
}

/** Доля перекрытия двух форм от меньшей из них (без допуска) */
function overlapRatio(a: Mask, b: Mask): number {
  if (!a.count || !b.count) return 0
  const x0 = Math.max(a.x0, b.x0)
  const y0 = Math.max(a.y0, b.y0)
  const x1 = Math.min(a.x0 + a.w, b.x0 + b.w)
  const y1 = Math.min(a.y0 + a.h, b.y0 + b.h)
  let n = 0
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) if (at(a, x, y) && at(b, x, y)) n++
  return n / Math.min(a.count, b.count)
}

/**
 * Фон — отдельный объект:
 * земля — полоса во всю ширину у нижнего края (подоконник посреди рисунка — не земля);
 * подложка — фигура почти на весь рисунок.
 */
function isBackground(shape: SourceShape, model: SourceModel): boolean {
  const { y: Y, width: W, height: H } = model.viewBox
  const b = shape.bbox
  return (b.width >= 0.9 * W && b.height <= 0.25 * H && b.y + b.height >= Y + 0.8 * H) || b.width * b.height >= 0.7 * W * H
}

/** Фигура занимает большую часть всего нарисованного (экран, небо в рамке): подложка, даже если рамка невелика */
const isDominant = (i: number, masks: Mask[], total: number) => masks[i]!.count >= 0.6 * total

/**
 * Фигура на весь рисунок, на которую сразу следом наложены другие крупные части, выходящие за ее край
 * (корпус геймпада под ручками, банка под крышкой), — тело единственного объекта рисунка, а не подложка.
 * Облако, перед которым позже нарисовано другое облако, остается подложкой: между ними его собственный контур.
 * Преобладающую фигуру (сердце под линией кардиограммы) выдает любая такая часть, а не только идущая следом;
 * подложкой она становится, только если на ней лежит россыпь деталей (звезды на небе), а не пара (кружок со значком)
 */
function isObjectBody(i: number, model: SourceModel, masks: Mask[], total: number): boolean {
  const { width: W, height: H } = model.viewBox
  const b = model.shapes[i]!.bbox
  const full = b.width * b.height >= 0.7 * W * H
  if (!full && !isDominant(i, masks, total)) return false // земля у нижнего края — всегда фон
  const base = masks[i]!
  let lying = 0
  for (let j = i + 1; j < masks.length; j++) {
    const c = coverage(masks[j]!, [base])
    if (masks[j]!.count >= 0.06 * base.count && !isBackground(model.shapes[j]!, model) && c >= 0.1 && c <= 0.9) return true
    if (full && c < 0.8) return false // цепочка деталей поверх тела прервалась
    if (c >= 0.8) lying++
  }
  return !full && lying < 6
}

/**
 * Линия пола: тонкая горизонтальная линия на четверть рисунка и длиннее, лежащая не поверх других фигур
 * (разделители внутри окна интерфейса лежат на окне — это его детали, а не пол).
 */
function isFloorLine(i: number, model: SourceModel, masks: Mask[]): boolean {
  const { width: W, height: H } = model.viewBox
  const b = model.shapes[i]!.bbox
  if (b.height > 0.012 * Math.max(W, H) || b.width < 0.25 * W) return false
  return coverage(masks[i]!, masks.slice(0, i)) < 0.5
}

type Unit = { shapes: number[]; group: boolean; item?: boolean }

/**
 * Единицы: атомарные группы и отдельные плоские фигуры, в порядке документа.
 * Группа с подложкой внутри (экран VR вместе с путником на нем) — сцена, а не объект: ищем объекты в ней
 */
function collectUnits(model: SourceModel, isPanel: (i: number) => boolean): Unit[] {
  const total = model.shapes.length
  const units: Unit[] = []
  const walk = (container: Element) => {
    for (const child of Array.from(container.children)) {
      const index = model.shapeIndex.get(child)
      if (index !== undefined) {
        units.push({ shapes: [index], group: false })
        continue
      }
      const inside = listShapes(child)
        .map((el) => model.shapeIndex.get(el))
        .filter((i): i is number => i !== undefined)
      if (inside.length === 0) continue
      if (inside.length >= total * 0.85 && inside.length > 1) walk(child) // контейнер всего рисунка, а не объект
      else if (inside.length > 1 && inside.some(isPanel)) walk(child)
      else if (inside.length === 1) units.push({ shapes: inside, group: false })
      else units.push({ shapes: inside, group: true })
    }
  }
  walk(model.wrapper ?? model.svg)
  return units
}

/**
 * Повторяющиеся мелкие предметы (летящие купюры, брызги): пара или тройка фигур подряд, связанных между собой,
 * одинаковая по составу и размеру: копии нарисованы подряд, хотя бы три, и не касаются друг друга.
 * Такая копия — готовая единица, а не продолжение соседнего объекта (брызга у крышки банки — не банка).
 * Пачки из тех же купюр (копии вперемешку с другими фигурами, лежат друг на друге) остаются обычными фигурами
 */
function markItems(units: Unit[], model: SourceModel, masks: Mask[]): Unit[] {
  const { width: W, height: H } = model.viewBox
  const used = new Set<number>()
  const items = new Map<number, number>() // начало копии в units → длина
  const shapeAt = (p: number) => units[p]!.shapes[0]!
  const area = (i: number) => Math.max(model.shapes[i]!.bbox.width * model.shapes[i]!.bbox.height, 1e-9)
  for (const k of [3, 2]) {
    const starts: number[] = []
    for (let p = 0; p + k <= units.length; p++) {
      const run = units.slice(p, p + k)
      if (run.some((u, d) => u.group || u.shapes.length !== 1 || used.has(p + d))) continue
      const ids = run.map((u) => u.shapes[0]!)
      const boxes = ids.map((i) => model.shapes[i]!.bbox)
      const w = Math.max(...boxes.map((b) => b.x + b.width)) - Math.min(...boxes.map((b) => b.x))
      const h = Math.max(...boxes.map((b) => b.y + b.height)) - Math.min(...boxes.map((b) => b.y))
      if (w * h > 0.006 * W * H) continue
      if (!ids.every((i) => ids.some((j) => j !== i && touches(masks[i]!, masks[j]!)))) continue
      starts.push(p)
    }
    const same = (p: number, q: number) =>
      Array.from({ length: k }, (_, d) => [shapeAt(p + d), shapeAt(q + d)] as const).every(
        ([a, b]) => model.shapes[a]!.el.localName === model.shapes[b]!.el.localName && Math.max(area(a), area(b)) <= 2 * Math.min(area(a), area(b)),
      )
    const families: number[][] = []
    for (const p of starts) {
      const family = families.find((f) => same(f[0]!, p))
      if (family) family.push(p)
      else families.push([p])
    }
    for (const family of families.sort((a, b) => b.length - a.length)) {
      const copies = family.filter((p) => !Array.from({ length: k }, (_, d) => p + d).some((x) => used.has(x)))
      const shapesOf = (p: number) => units.slice(p, p + k).map((u) => u.shapes[0]!)
      const alone = copies.filter((p) => !copies.some((q) => q !== p && shapesOf(p).some((i) => shapesOf(q).some((j) => touches(masks[i]!, masks[j]!)))))
      // Цепочки копий, идущих в документе вплотную одна за другой
      const chained = alone.filter((p) => {
        let n = 1
        for (let q = p - k; alone.includes(q); q -= k) n++
        for (let q = p + k; alone.includes(q); q += k) n++
        return n >= 3
      })
      if (chained.length < 3) continue
      for (const p of chained) {
        items.set(p, k)
        for (let d = 0; d < k; d++) used.add(p + d)
      }
    }
  }
  const out: Unit[] = []
  for (let p = 0; p < units.length; p++) {
    const k = items.get(p)
    if (k) {
      out.push({ shapes: units.slice(p, p + k).map((u) => u.shapes[0]!), group: true, item: true })
      p += k - 1
    } else out.push(units[p]!)
  }
  return out
}

/** Площадь фигур в пикселях растра — для оценки качества эвристики (scripts/eval-objects.mjs) */
export const shapeAreas = (model: SourceModel) => buildMasks(model).map((m) => m.count)

export function detectObjects(model: SourceModel): number[][] {
  const masks = buildMasks(model)
  const total = masks.reduce((n, m) => n + m.count, 0)
  const { width: VW, height: VH } = model.viewBox
  const side = Math.max(VW, VH)
  const clusters: Cluster[] = []
  // Две крупные формы, лишь частично перекрывающие друг друга (кроны деревьев, солнце за зонтом), — разные объекты
  // Крупное «пятно»: заметная площадь и компактная рамка (кроны, солнце, купол зонта; не полоска подоконника)
  const big = (k: number) => {
    const b = model.shapes[k]!.bbox
    return masks[k]!.count >= 0.02 * total && Math.max(b.width, b.height) <= 4 * Math.min(b.width, b.height)
  }
  // Компактные формы похожего размера (кроны соседних деревьев, солнце за горой)
  const compact = (k: number) => {
    const b = model.shapes[k]!.bbox
    return masks[k]!.count >= 0.002 * total && Math.max(b.width, b.height) <= 4 * Math.min(b.width, b.height)
  }
  const similar = (a: number, b: number) => {
    const r = masks[a]!.count / Math.max(masks[b]!.count, 1)
    return r >= 1 / 3 && r <= 3
  }
  /**
   * Строки абзаца, флажок и подпись: тонкие фигуры (толщина до 3,5% рисунка) с зазором меньше своей толщины
   * и не больше 2% рисунка — связь даже без касания. Крупные формы рядом — разные предметы, им нужно касание
   */
  const near = (i: number, j: number) => {
    const a = model.shapes[i]!.bbox
    const b = model.shapes[j]!.bbox
    const thick = Math.min(a.width, a.height, b.width, b.height)
    if (Math.max(Math.min(a.width, a.height), Math.min(b.width, b.height)) > 0.035 * side) return false
    const gap = Math.max(a.x - b.x - b.width, b.x - a.x - a.width, a.y - b.y - b.height, b.y - a.y - a.height, 0)
    return gap <= Math.min(0.8 * thick, 0.02 * side)
  }
  /** Две длинные тонкие линии, пересекающиеся лишь в точках (орбиты, провода), — разные объекты */
  const long = (k: number) => hollow(masks[k]!) && Math.max(model.shapes[k]!.bbox.width, model.shapes[k]!.bbox.height) >= 0.3 * side
  const crossing = (i: number, j: number) => long(i) && long(j) && overlapRatio(masks[i]!, masks[j]!) < 0.05
  const linked = (i: number, j: number) => {
    if (!touches(masks[j]!, masks[i]!)) return near(i, j)
    if (crossing(i, j)) return false
    const partial = (r: number) => r > 0 && r < 0.3 // соседство через тонкую раму (стекла окна) — связь, наложение краем — нет
    if (big(i) && big(j)) return !partial(overlapRatio(masks[i]!, masks[j]!))
    if (compact(i) && compact(j) && similar(i, j)) return !partial(overlapRatio(masks[i]!, masks[j]!))
    return true
  }
  /** Контур фигуры b со сдвигом: полая фигура почти той же рамки */
  const outlineOf = (i: number, b: number) => {
    if (!hollow(masks[i]!)) return false
    const p = model.shapes[i]!.bbox
    const q = model.shapes[b]!.bbox
    const w = Math.min(p.x + p.width, q.x + q.width) - Math.max(p.x, q.x)
    const h = Math.min(p.y + p.height, q.y + q.height) - Math.max(p.y, q.y)
    const inter = Math.max(w, 0) * Math.max(h, 0)
    return inter >= 0.8 * (p.width * p.height + q.width * q.height - inter)
  }
  let current: Cluster | null = null
  let backdrop: Cluster | null = null
  /** Предыдущая единица — слой подложки */
  let layered = false
  /** Полоса на подложке во всю ее ширину или высоту (разделители в окне интерфейса) */
  const spansBackdrop = (i: number, bd: Cluster) => {
    const b = model.shapes[i]!.bbox
    const p = model.shapes[bd.shapes[0]!]!.bbox
    if (b.width < 0.9 * p.width && b.height < 0.9 * p.height) return false
    return coverage(masks[i]!, bd.shapes.map((j) => masks[j]!)) >= 0.8
  }

  const units = markItems(
    collectUnits(model, (i) => isBackground(model.shapes[i]!, model) || isDominant(i, masks, total)),
    model,
    masks,
  )
  /** Фигуры одного вида и размера (фестоны навеса, ступени, зубцы) */
  const sameShape = (a: number, b: number) => {
    const [p, q] = [model.shapes[a]!, model.shapes[b]!]
    const close = (x: number, y: number) => Math.abs(x - y) <= 0.15 * Math.max(x, y)
    return p.el.localName === q.el.localName && close(p.bbox.width, q.bbox.width) && close(p.bbox.height, q.bbox.height)
  }
  /** С единицы p начинается ряд из трех и более одинаковых фигур подряд */
  const startsRow = (p: number) => {
    const row = units.slice(p, p + 3)
    return row.length === 3 && row.every((u) => !u.group && u.shapes.length === 1) && sameShape(row[0]!.shapes[0]!, row[1]!.shapes[0]!) && sameShape(row[0]!.shapes[0]!, row[2]!.shapes[0]!)
  }

  // 1–2, 5: группы, фон и прогоны в порядке документа
  for (const [p, unit] of units.entries()) {
    if (unit.group) {
      clusters.push({ shapes: unit.shapes, group: true, background: false, overlays: new Set() })
      if (!unit.item) current = null // повторяющийся предмет не прерывает объект, рядом с которым нарисован
      layered = false
      continue
    }
    const i = unit.shapes[0]!
    // Разделитель во всю ширину подложки — ее часть, даже у нижнего края (нижняя линия в окне интерфейса — не земля)
    const ib = model.shapes[i]!.bbox
    // Рамка-контур сразу после подложки (рамка экрана VR, обводка облака) — ее слой
    if (backdrop && ((ib.width * ib.height < 0.7 * VW * VH && spansBackdrop(i, backdrop)) || (layered && outlineOf(i, backdrop.shapes[0]!)))) {
      backdrop.shapes.push(i)
      continue
    }
    if ((isBackground(model.shapes[i]!, model) || isDominant(i, masks, total)) && !isObjectBody(i, model, masks, total)) {
      // Слои одной подложки: рамка окна и белое поле в ней, небо и полупрозрачная дымка поверх
      if (backdrop && layered && coverage(masks[i]!, backdrop.shapes.map((j) => masks[j]!)) >= 0.97) backdrop.shapes.push(i)
      else {
        backdrop = { shapes: [i], group: false, background: true, overlays: new Set() }
        clusters.push(backdrop)
      }
      layered = true
      continue
    }
    layered = false
    if (isFloorLine(i, model, masks)) {
      clusters.push({ shapes: [i], group: false, background: true, overlays: new Set() })
      continue
    }
    // Фигура без видимой площади (штрих в полпикселя) не может ничего касаться — остается с соседями по порядку
    if (current && !masks[i]!.count) {
      current.shapes.push(i)
      continue
    }
    // Ряд одинаковых фигур — отдельная деталь, а не продолжение того, чего коснулся: фестоны навеса над головой
    // продавщицы принадлежат навесу. Внутри самого ряда прогон продолжается
    const row = current !== null && startsRow(p) && !sameShape(current.shapes[current.shapes.length - 1]!, i)
    if (current && !row && current.shapes.some((j) => linked(i, j))) {
      current.shapes.push(i)
      continue
    }
    current = { shapes: [i], group: false, background: false, overlays: new Set() }
    clusters.push(current)
  }

  const merged = new WeakSet<Cluster>() // поглощенные объекты
  const alive = (c: Cluster) => !merged.has(c)
  /**
   * Сведения об объекте, пересчитываемые только после слияния (фигуры лишь добавляются):
   * свои фигуры — без далеких по порядку деталей «поверх» (снег на елке не растягивает елку до человека),
   * их диапазон в порядке документа, площадь и рамка в пикселях растра
   */
  type Info = { n: number; own: number[]; span: readonly [number, number]; area: number; box: readonly [number, number, number, number] }
  const infos = new WeakMap<Cluster, Info>()
  const info = (c: Cluster): Info => {
    const hit = infos.get(c)
    if (hit && hit.n === c.shapes.length) return hit
    const core = c.shapes.filter((i) => !c.overlays.has(i))
    const [lo, hi] = [Math.min(...core), Math.max(...core)]
    const own = c.shapes.filter((i) => !c.overlays.has(i) || (i >= lo - 8 && i <= hi + 8))
    let [x0, y0, x1, y1, sum] = [Infinity, Infinity, -Infinity, -Infinity, 0]
    for (const i of c.shapes) {
      const m = masks[i]!
      if (!m.count) continue
      ;[x0, y0, x1, y1] = [Math.min(x0, m.x0), Math.min(y0, m.y0), Math.max(x1, m.x0 + m.w), Math.max(y1, m.y0 + m.h)]
      sum += m.count
    }
    const out: Info = { n: c.shapes.length, own, span: [Math.min(...own), Math.max(...own)], area: sum, box: [x0, y0, x1, y1] }
    infos.set(c, out)
    return out
  }
  const area = (c: Cluster) => info(c).area
  /** Число видимых фигур: штрихи нулевой площади не делают обрывок «полноценным объектом» */
  const visible = (c: Cluster) => c.shapes.filter((i) => masks[i]!.count).length
  const own = (c: Cluster) => info(c).own
  const span = (c: Cluster) => info(c).span
  /**
   * Сетка по растру: объекты, чьи рамки (с запасом 8 px) задевают ячейку. Строится на проход;
   * объект, выросший в этом проходе, найдется в следующем
   */
  const CELL = 24
  const gridOf = (list: Cluster[]) => {
    const cells = new Map<number, Cluster[]>()
    const range = (c: Cluster) => {
      const [x0, y0, x1, y1] = info(c).box
      if (!Number.isFinite(x0)) return null
      return [Math.floor((x0 - 8) / CELL), Math.floor((y0 - 8) / CELL), Math.floor((x1 + 8) / CELL), Math.floor((y1 + 8) / CELL)] as const
    }
    for (const c of list) {
      const r = range(c)
      if (!r) continue
      for (let gy = r[1]; gy <= r[3]; gy++) for (let gx = r[0]; gx <= r[2]; gx++) {
        const key = gy * 4096 + gx
        const bucket = cells.get(key)
        if (bucket) bucket.push(c)
        else cells.set(key, [c])
      }
    }
    return (c: Cluster) => {
      const r = range(c)
      const out = new Set<Cluster>()
      if (r) for (let gy = r[1]; gy <= r[3]; gy++) for (let gx = r[0]; gx <= r[2]; gx++) for (const t of cells.get(gy * 4096 + gx) ?? []) out.add(t)
      return out
    }
  }
  /** Рамки объектов сближены не дальше pad пикселей растра — иначе ни касания, ни наложения быть не может */
  const close = (a: Cluster, b: Cluster, pad = 8) => {
    const [p, q] = [info(a).box, info(b).box]
    return p[0] - pad < q[2] && q[0] - pad < p[2] && p[1] - pad < q[3] && q[1] - pad < p[3]
  }
  const touching = (a: Cluster, b: Cluster) =>
    a.shapes.some((i) => b.shapes.some((j) => !crossing(i, j) && touches(masks[j]!, masks[i]!)))
  /** Объект, которому сейчас принадлежит фигура */
  const owner = new Map<number, Cluster>()
  for (const c of clusters) for (const i of c.shapes) owner.set(i, c)
  const merge = (into: Cluster, from: Cluster, asOverlay: boolean) => {
    for (const i of from.shapes) owner.set(i, into)
    into.shapes.push(...from.shapes)
    for (const i of from.shapes) if (asOverlay || from.overlays.has(i)) into.overlays.add(i)
    clusters.splice(clusters.indexOf(from), 1)
    merged.add(from)
  }
  /** Между a и b по порядку нет другого полноценного (2+ фигуры) объекта */
  const neighbors = (a: Cluster, b: Cluster) => {
    const [lo, hi] = span(a)[0] < span(b)[0] ? [span(a)[1], span(b)[0]] : [span(b)[1], span(a)[0]]
    return !clusters.some((c) => c !== a && c !== b && !c.background && own(c).length >= 2 && span(c)[0] > lo && span(c)[1] < hi)
  }

  const interleaved = (a: Cluster, b: Cluster) => {
    const [lo, hi] = span(a)
    return own(b).some((j) => j > lo && j < hi)
  }
  /**
   * Какая доля раньше нарисованного объекта закрыта позже нарисованным. Пальто закрывает заметную часть торса,
   * а человек перед фургоном — крошечную долю фургона
   */
  const overlapShare = (earlier: Cluster, later: Cluster) =>
    earlier.shapes.reduce((n, i) => n + coverage(masks[i]!, later.shapes.map((j) => masks[j]!)) * masks[i]!.count, 0) /
    Math.max(area(earlier), 1)

  /**
   * Фигура внутри объекта, а не на нем: лежит на объекте, и его же части, нарисованные позже, закрывают ее спереди
   * (продавщицу в окне фургона — навес и прилавок). Крестовину на корпусе геймпада спереди ничто не закрывает;
   * мелочь за прилавком (бутылочки соусов) — обрывок и решается раньше
   */
  const inside = (run: Cluster, host: Cluster) => {
    if (overlapShare(run, host) < 0.9) return false
    const last = Math.max(...run.shapes)
    const front = host.shapes.filter((j) => j > last && masks[j]!.opaque).map((j) => masks[j]!) // тени поверх не в счет
    if (!front.length) return false
    const hidden = run.shapes.reduce((n, i) => n + coverage(masks[i]!, front) * masks[i]!.count, 0)
    return hidden >= 0.03 * area(run)
  }

  /**
   * Деталь внутри полого контура (сектор внутри обводки диаграммы, знак в рамке карточки): рамка фигуры объекта
   * охватывает рамку детали, сама фигура — тонкий контур, а деталь не теряется в нем точкой (звезда внутри орбиты)
   */
  const insideOutline = (piece: Cluster, target: Cluster) => {
    const boxes = piece.shapes.map((i) => model.shapes[i]!.bbox)
    const x0 = Math.min(...boxes.map((b) => b.x))
    const y0 = Math.min(...boxes.map((b) => b.y))
    const x1 = Math.max(...boxes.map((b) => b.x + b.width))
    const y1 = Math.max(...boxes.map((b) => b.y + b.height))
    return target.shapes.some((t) => {
      const m = masks[t]!
      const b = model.shapes[t]!.bbox
      if (!hollow(m)) return false
      if (x0 < b.x || y0 < b.y || x1 > b.x + b.width || y1 > b.y + b.height) return false
      return (x1 - x0) * (y1 - y0) >= 0.05 * b.width * b.height
    })
  }

  /** Рамка объекта: доля площади рисунка и «точка» (до 1,5% рисунка) */
  const box = (c: Cluster) => {
    const boxes = c.shapes.map((i) => model.shapes[i]!.bbox)
    const w = Math.max(...boxes.map((b) => b.x + b.width)) - Math.min(...boxes.map((b) => b.x))
    const h = Math.max(...boxes.map((b) => b.y + b.height)) - Math.min(...boxes.map((b) => b.y))
    return { share: Math.max(w * h, 1e-9) / (VW * VH), dot: Math.max(w, h) <= 0.015 * side }
  }

  /**
   * Точка из рассыпанного поля (снег): такие же точки висят и в пустоте, не на объектах. Снежинка на елке тогда — часть
   * снегопада, а не елки; звезды, которые все лежат на стекле окна, остаются деталями окна
   */
  const bgMasks = new Set(clusters.filter((c) => c.background).flatMap((c) => c.shapes))
  const dots = clusters.filter((c) => !c.group && !c.background && c.shapes.length === 1 && box(c).dot).map((c) => c.shapes[0]!)
  const dotSet = new Set(dots)
  const free = dots.filter((i) => coverage(masks[i]!, masks.filter((_, j) => j !== i && !bgMasks.has(j))) < 0.2)
  const dotArea = (i: number) => Math.max(model.shapes[i]!.bbox.width * model.shapes[i]!.bbox.height, 1e-9)
  const inField = (piece: Cluster) => {
    const i = piece.shapes[0]!
    if (piece.shapes.length !== 1 || !dotSet.has(i)) return false
    return free.filter((j) => j !== i && Math.max(dotArea(i), dotArea(j)) <= 2 * Math.min(dotArea(i), dotArea(j))).length >= 3
  }
  // Расстояние по порядку документа без точек поля: звезды, нарисованные между планетой и ее орбитой, не разделяют их
  const field = clusters.filter(inField).map((c) => c.shapes[0]!)
  const before = model.shapes.map((_, k) => field.filter((i) => i < k).length)
  const gap = (a: Cluster, b: Cluster) =>
    Math.min(...own(a).flatMap((i) => own(b).map((j) => Math.abs(i - j) - Math.abs(before[Math.max(i, j)]! - before[Math.min(i, j) + 1]!))))

  // 3–4 повторяем, пока что-то склеивается: после слияния торса и брюк к ним может прилипнуть ботинок
  /**
   * Соседи обрывка по порядку документа (без невидимых штрихов, точек поля и фона) с обеих сторон принадлежат одному
   * объекту, и обрывок его касается: рука со стаканом нарисована между ботинками и брюками мужчины — значит, она его,
   * хотя лежит на борту фургона
   */
  const sandwich = (piece: Cluster) => {
    const skip = (k: number) => piece.shapes.includes(k) || !masks[k]!.count || field.includes(k) || owner.get(k)?.background
    let a = Math.min(...piece.shapes) - 1
    while (a >= 0 && skip(a)) a--
    let b = Math.max(...piece.shapes) + 1
    while (b < masks.length && skip(b)) b++
    const [pa, pb] = [a >= 0 ? owner.get(a) : undefined, b < masks.length ? owner.get(b) : undefined]
    const host = pa && pb ? (pa === pb ? pa : undefined) : (pa ?? pb)
    return host && !host.group && touching(piece, host) ? host : null
  }

  let patient = true // пока что-то склеивается, деталь может подождать ближнего соседа
  for (let changed = true; changed || patient; ) {
    if (!changed) patient = false
    changed = false
    // 3: обрывки — по одному, от меньших к большим; выросший после слияния обрывок уже не обрывок
    const pieces = clusters.filter((c) => !c.group && !c.background && visible(c) <= 3).sort((a, b) => area(a) - area(b))
    const around = gridOf(clusters.filter((c) => !c.background))
    for (const piece of pieces) {
      if (!alive(piece) || visible(piece) > 3 || inField(piece)) continue
      const mid = (span(piece)[0] + span(piece)[1]) / 2
      // Деталь «поверх» судим по ее главной фигуре: тень горы на соседней горе не тянет за собой саму гору
      const main = piece.shapes.reduce((m, i) => (masks[i]!.count > masks[m]!.count ? i : m))
      let lay: { target: Cluster; gap: number } | null = null
      const others: Array<{ target: Cluster; gap: number }> = []
      for (const target of around(piece)) {
        if (target === piece || !alive(target) || !close(piece, target)) continue
        const g = gap(piece, target)
        // Деталь, хотя бы наполовину лежащая на объекте (волосы, нарисованные последними) или внутри его контура, —
        // к нему, на любом расстоянии
        if (area(piece) <= area(target) && (coverage(masks[main]!, target.shapes.map((j) => masks[j]!)) >= 0.5 || insideOutline(piece, target))) {
          if (!lay || g < lay.gap) lay = { target, gap: g }
        } else others.push({ target, gap: g })
      }
      // Касание проверяется лениво, от ближних по порядку
      others.sort((a, b) => a.gap - b.gap)
      let touch: { target: Cluster; gap: number } | null = null
      // При равном расстоянии — объект, нарисованный после: unDraw рисует снизу вверх (ботинки, ноги, туловище)
      const later = (c: Cluster) => (span(c)[0] + span(c)[1]) / 2 > mid
      for (const o of others) {
        if (o.gap > 12 || (touch && o.gap > touch.gap)) break
        // К группе исходника (персонаж, животное) по касанию не прилипаем: рядом стоящий предмет — отдельный объект
        if (o.target.group || area(piece) > 2 * area(o.target) || !neighbors(piece, o.target) || !touching(piece, o.target)) continue
        if (!touch || (later(o.target) && !later(touch.target))) touch = o
      }
      // Лежать на объекте весомее касания. Но если деталь касается чего-то, нарисованного ближе по порядку, она ждет,
      // пока соседи соберутся: руке мужчины, лежащей на борту фургона, нужно дождаться самого мужчины
      const host = sandwich(piece)
      const waits = lay !== null && patient && others.some((o) => o.gap < lay!.gap && touching(piece, o.target))
      const best = host ? { target: host, overlay: false } : lay ? (waits ? null : { ...lay, overlay: true }) : touch ? { ...touch, overlay: false } : null
      if (best) {
        merge(best.target, piece, best.overlay)
        changed = true
      }
    }
    if (changed) continue
    // 4: прогоны вперемешку
    const runs = clusters.filter((c) => !c.group && !c.background)
    const nearRuns = gridOf(runs)
    outer: for (const a of runs) {
      for (const b of nearRuns(a)) {
        if (a === b || !close(a, b) || !(interleaved(a, b) || interleaved(b, a)) || !touching(a, b)) continue
        if (inside(a, b) || inside(b, a)) continue // продавщица нарисована между частями фургона, но она внутри него
        merge(a, b, false)
        changed = true
        break outer
      }
    }
    if (changed) continue
    // 4б: соседние по порядку части, сильно наложенные друг на друга (пальто поверх торса), — один объект;
    //     соседние деревья соприкасаются лишь краями и остаются раздельными
    const ordered = runs.slice().sort((a, b) => span(a)[0] - span(b)[0])
    for (let k = 0; k + 1 < ordered.length; k++) {
      const a = ordered[k]!
      const b = ordered[k + 1]!
      if (!close(a, b) || !neighbors(a, b) || !a.shapes.some((i) => b.shapes.some((j) => linked(i, j)))) continue
      if (overlapShare(a, b) >= 0.2) {
        merge(a, b, false)
        changed = true
        break
      }
    }
    if (changed) continue
    // 4в: многодетальный узел целиком на другом объекте (крестовина на корпусе геймпада) — его часть,
    //     если только он не внутри объекта (человек в окне фургона). С конца рисунка: передние части фургона
    //     (навес, прилавок) присоединяются раньше, чем решается судьба продавщицы за ними
    const nodes = clusters.filter((c) => !c.group && !c.background && visible(c) > 3).sort((a, b) => span(b)[0] - span(a)[0])
    const nearAll = gridOf(clusters.filter((c) => !c.background))
    for (const run of nodes) {
      const target = [...nearAll(run)].find(
        (t) => t !== run && close(run, t, 0) && area(t) >= area(run) && overlapShare(run, t) >= 0.98 && !inside(run, t),
      )
      if (!target) continue
      merge(target, run, true)
      changed = true
      break
    }
  }

  // 5б: подставка, нарисованная прямо перед подложкой на весь рисунок и касающаяся ее (ножка монитора), — ее часть
  for (const bd of clusters.filter((c) => c.background)) {
    const b = model.shapes[bd.shapes[0]!]!.bbox
    if (b.width * b.height < 0.7 * VW * VH) continue
    const stand = clusters.find((c) => !c.group && !c.background && Math.max(...c.shapes) === bd.shapes[0]! - 1)
    if (!stand || !touching(stand, bd)) continue
    const lying = stand.shapes.reduce((n, i) => n + coverage(masks[i]!, bd.shapes.map((j) => masks[j]!)) * masks[i]!.count, 0)
    if (lying < 0.5 * area(stand)) merge(bd, stand, false)
  }

  // 6: рассыпанная мелочь (снег, звезды, летящие купюры, брызги), не прилипшая ни к одному объекту, — один объект
  //    на каждый вид: одинаковое число фигур и близкий размер. Точки до 1,5% рисунка (звезды любого калибра) — один вид,
  //    более крупные предметы — цепочкой, где соседи по площади различаются не больше чем в 3 раза
  //    (кружки-планеты 20–33 px вместе, но не с точками звезд)
  const kinds = new Map<string, Cluster[]>()
  for (const c of clusters) {
    if (c.background || c.shapes.length > 3 || box(c).share > 0.006) continue // мелкая группа исходника — тоже предмет
    const key = `${c.shapes.length}:${box(c).dot ? 'dot' : 'item'}`
    kinds.set(key, [...(kinds.get(key) ?? []), c])
  }
  for (const [key, list] of kinds) {
    list.sort((a, b) => box(a).share - box(b).share)
    let bin: Cluster[] = []
    const flush = () => {
      if (bin.length >= 3) for (const c of bin.slice(1)) merge(bin[0]!, c, false)
      bin = []
    }
    for (const c of list) {
      if (bin.length && !key.endsWith('dot') && box(c).share > 3 * box(bin[bin.length - 1]!).share) flush()
      bin.push(c)
    }
    flush()
  }

  return clusters.map((c) => [...c.shapes].sort((a, b) => a - b))
}
