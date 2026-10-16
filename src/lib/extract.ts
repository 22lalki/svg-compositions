import type { Point, Rect, SourceMeta } from '../types'
import {
  apply,
  boundsOf,
  fmt,
  fromTransformList,
  IDENTITY,
  inflate,
  isAxisAligned,
  meanScale,
  mul,
  rectCorners,
  toTransformString,
  transformRect,
  translate,
  unionRects,
  type Mat,
} from './matrix'
import { refsOf, rewriteRefs, selfAndDescendants, serializeFragment, SVG_NS, URL_REF_RE } from './svg'

/** Что считаем фигурами при выделении */
export const SHAPE_SELECTOR = 'path, circle, ellipse, rect, polygon, polyline, line'
/** Контейнеры, содержимое которых не рисуется само по себе */
const NON_RENDERED = 'defs, clipPath, mask, pattern, symbol, marker, linearGradient, radialGradient, filter'

/** Наследуемые свойства, которые переносим на клон, если они пришли от предка */
const INHERITED_PROPS = [
  'fill',
  'fill-opacity',
  'fill-rule',
  'stroke',
  'stroke-width',
  'stroke-opacity',
  'stroke-linecap',
  'stroke-linejoin',
  'stroke-miterlimit',
  'stroke-dasharray',
  'stroke-dashoffset',
  'clip-rule',
] as const

export type SourceShape = {
  el: SVGGeometryElement
  /** Порядок в документе */
  index: number
  /** Матрица предков (включая корневую обертку) → координаты корня */
  ancestors: Mat
  /** ancestors × собственный transform: координаты геометрии → координаты корня */
  matrix: Mat
  /** Bbox в координатах корня с учетом поворотов и обводки */
  bbox: Rect
  /** Углы локального bbox в координатах корня — контур подсветки (повернут вместе с фигурой) */
  outline: Point[]
}

export type SourceModel = {
  meta: SourceMeta
  svg: SVGSVGElement
  viewBox: Rect
  shapes: SourceShape[]
  /** Корневая обертка <g transform="translate(...)"> — до нее ↑ не поднимается */
  wrapper: Element | null
  shapeIndex: WeakMap<Element, number>
}

export type Extraction = {
  width: number
  height: number
  /** Начало bbox выделения в координатах исходника */
  origin: Point
  defs: string
  markup: string
  shapeCount: number
  defsCount: number
}

function localMatrix(el: Element): Mat {
  return el instanceof SVGGraphicsElement ? fromTransformList(el.transform.baseVal) : IDENTITY
}

function hasOwnProp(el: Element, prop: string): boolean {
  return el.hasAttribute(prop) || (el instanceof SVGElement && el.style.getPropertyValue(prop) !== '')
}

function isRenderedShape(el: Element): el is SVGGeometryElement {
  return el instanceof SVGGeometryElement && !el.closest(NON_RENDERED)
}

/** Фигуры исходника в порядке документа (без содержимого defs, clipPath и т.п.) */
export function listShapes(root: Element): SVGGeometryElement[] {
  return Array.from(root.querySelectorAll(SHAPE_SELECTOR)).filter(isRenderedShape)
}

/** Точный bbox повернутой фигуры: выборка точек контура вместо углов локального bbox */
function sampledBounds(el: SVGGeometryElement, m: Mat): Rect | null {
  let length = 0
  try {
    length = el.getTotalLength()
  } catch {
    return null
  }
  if (!(length > 0)) return null
  const steps = Math.min(800, Math.max(64, Math.ceil(length / 3)))
  const points: Point[] = []
  for (let i = 0; i <= steps; i++) {
    const p = el.getPointAtLength((length * i) / steps)
    points.push(apply(m, { x: p.x, y: p.y }))
  }
  return boundsOf(points)
}

function shapeBounds(el: SVGGeometryElement, m: Mat, local: Rect): Rect {
  const geometry = isAxisAligned(m) ? transformRect(m, local) : (sampledBounds(el, m) ?? transformRect(m, local))
  const cs = getComputedStyle(el)
  if (cs.stroke && cs.stroke !== 'none') {
    const sw = parseFloat(cs.strokeWidth) || 0
    if (sw > 0) return inflate(geometry, (sw / 2) * meanScale(m))
  }
  return geometry
}

/**
 * Разбор исходника, уже вставленного в DOM инлайном:
 * для каждой фигуры — матрица относительно корня и bbox в координатах корня.
 */
export function analyzeSource(svg: SVGSVGElement, meta: SourceMeta): SourceModel {
  const vb = svg.viewBox.baseVal
  const viewBox =
    vb && vb.width > 0
      ? { x: vb.x, y: vb.y, width: vb.width, height: vb.height }
      : { x: 0, y: 0, width: svg.width.baseVal.value, height: svg.height.baseVal.value }

  const content = Array.from(svg.children).filter(
    (c) => !['defs', 'title', 'desc', 'metadata', 'style'].includes(c.localName),
  )
  const wrapper = content.length === 1 && content[0]?.localName === 'g' ? content[0] : null

  // Матрицы предков считаем один раз на группу
  const groupCache = new Map<Element, Mat>()
  const ancestorsOf = (el: Element): Mat => {
    const parent = el.parentElement as Element | null
    if (!parent || parent === svg) return IDENTITY
    const cached = groupCache.get(parent)
    if (cached) return cached
    const m = mul(ancestorsOf(parent), localMatrix(parent))
    groupCache.set(parent, m)
    return m
  }

  const shapes: SourceShape[] = []
  const shapeIndex = new WeakMap<Element, number>()
  for (const el of listShapes(svg)) {
    const ancestors = ancestorsOf(el)
    const matrix = mul(ancestors, localMatrix(el))
    const b = el.getBBox()
    const local = { x: b.x, y: b.y, width: b.width, height: b.height }
    const index = shapes.length
    shapes.push({
      el,
      index,
      ancestors,
      matrix,
      bbox: shapeBounds(el, matrix, local),
      outline: rectCorners(local).map((p) => apply(matrix, p)),
    })
    shapeIndex.set(el, index)
  }
  return { meta, svg, viewBox, shapes, wrapper, shapeIndex }
}

/** Фигура повернута или скошена относительно корня */
export const isAxisAlignedShape = (s: SourceShape) => isAxisAligned(s.matrix)

/** Фигуры, чей bbox целиком внутри рамки */
export function shapesInRect(model: SourceModel, r: Rect): number[] {
  const eps = 1e-6
  return model.shapes
    .filter(
      (s) =>
        s.bbox.x >= r.x - eps &&
        s.bbox.y >= r.y - eps &&
        s.bbox.x + s.bbox.width <= r.x + r.width + eps &&
        s.bbox.y + s.bbox.height <= r.y + r.height + eps,
    )
    .map((s) => s.index)
}

export function selectionBounds(model: SourceModel, selected: Iterable<number>): Rect | null {
  const rects: Rect[] = []
  for (const i of selected) {
    const s = model.shapes[i]
    if (s) rects.push(s.bbox)
  }
  return unionRects(rects)
}

/**
 * Клавиша ↑: ближайшая группа-предок, в которой есть еще не выделенные фигуры.
 * Корень и корневая обертка не считаются. null — расширять некуда.
 */
export function expandToParentGroup(model: SourceModel, selected: ReadonlySet<number>): Set<number> | null {
  const els = Array.from(selected, (i) => model.shapes[i]?.el).filter((e): e is SVGGeometryElement => !!e)
  if (els.length === 0) return null

  // Наименьший общий предок
  let group: Element | null = els[0]!.parentElement
  while (group && !els.every((e) => group!.contains(e))) group = group.parentElement

  while (group && group !== model.svg && group !== model.wrapper) {
    const inside = Array.from(group.querySelectorAll(SHAPE_SELECTOR))
      .map((e) => model.shapeIndex.get(e))
      .filter((i): i is number => i !== undefined)
    if (inside.some((i) => !selected.has(i))) return new Set([...selected, ...inside])
    group = group.parentElement
  }
  return null
}

/** Произведение opacity предков (opacity не наследуется, но влияет на вид фигуры) */
function ancestorsOpacity(el: Element, root: Element): number {
  let product = 1
  for (let n = el.parentElement; n && n !== root.parentElement; n = n.parentElement) {
    const v = parseFloat(getComputedStyle(n).opacity)
    if (Number.isFinite(v)) product *= v
  }
  return product
}

function normalizeUrl(value: string): string {
  return value.replace(URL_REF_RE, (_w, _q: string, id: string) => `url(#${id})`)
}

/** Клон фигуры с явными цветами там, где они пришли от предков */
function cloneShape(shape: SourceShape, root: SVGSVGElement): Element {
  const el = shape.el
  const clone = el.cloneNode(true) as Element
  clone.removeAttribute('id')
  let cs: CSSStyleDeclaration | null = null
  for (const prop of INHERITED_PROPS) {
    if (hasOwnProp(el, prop)) continue
    let inherited = false
    for (let n = el.parentElement; n && n !== root.parentElement; n = n.parentElement) {
      if (hasOwnProp(n, prop)) {
        inherited = true
        break
      }
    }
    if (!inherited) continue
    cs ??= getComputedStyle(el)
    const value = cs.getPropertyValue(prop)
    if (value) clone.setAttribute(prop, normalizeUrl(value))
  }
  const groupOpacity = ancestorsOpacity(el, root)
  if (groupOpacity < 1 - 1e-6) {
    const own = parseFloat(getComputedStyle(el).opacity)
    clone.setAttribute('opacity', fmt((Number.isFinite(own) ? own : 1) * groupOpacity, 4))
  }
  return clone
}

/** Рекурсивно собирает элементы, на которые ссылаются узлы (градиент → href → градиент …) */
function collectDependencies(root: SVGSVGElement, nodes: Element[]): Element[] {
  const found = new Set<Element>()
  const queue: string[] = nodes.flatMap((n) => selfAndDescendants(n).flatMap(refsOf))
  const seen = new Set<string>()
  while (queue.length) {
    const id = queue.shift()!
    if (seen.has(id)) continue
    seen.add(id)
    const target = root.querySelector(`#${CSS.escape(id)}`)
    if (!target) continue
    found.add(target)
    for (const n of selfAndDescendants(target)) queue.push(...refsOf(n))
  }
  // Вложенные в уже найденные элементы копировать отдельно не нужно
  const list = Array.from(found).filter((el) => {
    for (let p = el.parentElement; p; p = p.parentElement) if (found.has(p)) return false
    return true
  })
  return list.sort((a, b) => (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1))
}

/**
 * Извлечение компонента из выделения.
 * 1) клоны фигур в порядке документа, обернутые в <g transform> с матрицей предков;
 * 2) сдвиг так, чтобы bbox выделения начинался в (0,0);
 * 3) цвета/opacity, унаследованные от групп, записываются в атрибуты клона;
 * 4) зависимости из defs собираются рекурсивно;
 * 5) все id получают префикс компонента, ссылки переписываются.
 */
export function extractComponent(
  model: SourceModel,
  selected: Iterable<number>,
  idPrefix: string,
): Extraction | null {
  const shapes = Array.from(new Set(selected))
    .sort((a, b) => a - b)
    .map((i) => model.shapes[i])
    .filter((s): s is SourceShape => !!s)
  const bounds = selectionBounds(model, shapes.map((s) => s.index))
  if (shapes.length === 0 || !bounds) return null

  // Округляем наружу до 1/1000, чтобы размеры были аккуратными и ничего не обрезалось
  const x0 = Math.floor(bounds.x * 1000) / 1000
  const y0 = Math.floor(bounds.y * 1000) / 1000
  const width = Math.max(Math.ceil((bounds.x + bounds.width - x0) * 1000) / 1000, 0.001)
  const height = Math.max(Math.ceil((bounds.y + bounds.height - y0) * 1000) / 1000, 0.001)
  const shift = translate(-x0, -y0)

  // Соседние фигуры с одинаковой матрицей предков делят одну обертку
  const wrappers: Element[] = []
  let current: { key: string; g: Element } | null = null
  for (const shape of shapes) {
    const transform = toTransformString(mul(shift, shape.ancestors))
    if (!current || current.key !== transform) {
      const g = document.createElementNS(SVG_NS, 'g')
      g.setAttribute('transform', transform)
      wrappers.push(g)
      current = { key: transform, g }
    }
    current.g.appendChild(cloneShape(shape, model.svg))
  }

  const defs = collectDependencies(model.svg, wrappers).map((el) => el.cloneNode(true) as Element)

  // Префикс id и обновление ссылок
  const rename = new Map<string, string>()
  for (const el of defs.flatMap(selfAndDescendants)) {
    const id = el.getAttribute('id')
    if (id) {
      rename.set(id, idPrefix + id)
      el.setAttribute('id', idPrefix + id)
    }
  }
  for (const el of [...defs, ...wrappers].flatMap(selfAndDescendants)) rewriteRefs(el, rename)

  return {
    width,
    height,
    origin: { x: x0, y: y0 },
    defs: defs.map(serializeFragment).join(''),
    markup: wrappers.map(serializeFragment).join(''),
    shapeCount: shapes.length,
    defsCount: defs.length,
  }
}
