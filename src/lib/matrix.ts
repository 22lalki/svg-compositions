import type { Point, Rect } from '../types'

/** Аффинная матрица SVG: [a b c d e f] ⇔ matrix(a b c d e f) */
export type Mat = readonly [number, number, number, number, number, number]

export const IDENTITY: Mat = [1, 0, 0, 1, 0, 0]

/** m × n: сначала применяется n, затем m (как в цепочке transform="m n") */
export function mul(m: Mat, n: Mat): Mat {
  return [
    m[0] * n[0] + m[2] * n[1],
    m[1] * n[0] + m[3] * n[1],
    m[0] * n[2] + m[2] * n[3],
    m[1] * n[2] + m[3] * n[3],
    m[0] * n[4] + m[2] * n[5] + m[4],
    m[1] * n[4] + m[3] * n[5] + m[5],
  ]
}

export const translate = (tx: number, ty: number): Mat => [1, 0, 0, 1, tx, ty]
export const scaling = (sx: number, sy: number): Mat => [sx, 0, 0, sy, 0, 0]

export function rotation(deg: number): Mat {
  const r = (deg * Math.PI) / 180
  const cos = Math.cos(r)
  const sin = Math.sin(r)
  return [cos, sin, -sin, cos, 0, 0]
}

export function apply(m: Mat, p: Point): Point {
  return { x: m[0] * p.x + m[2] * p.y + m[4], y: m[1] * p.x + m[3] * p.y + m[5] }
}

export function invert(m: Mat): Mat {
  const det = m[0] * m[3] - m[1] * m[2]
  if (Math.abs(det) < 1e-12) return IDENTITY
  return [
    m[3] / det,
    -m[1] / det,
    -m[2] / det,
    m[0] / det,
    (m[2] * m[5] - m[3] * m[4]) / det,
    (m[1] * m[4] - m[0] * m[5]) / det,
  ]
}

/** Средний линейный масштаб матрицы (для толщины обводки) */
/** Наибольшее растяжение по осям: обводка в scale(4 1) толще по растянутой оси, средний масштаб ее недооценит */
export const maxScale = (m: Mat) => Math.max(Math.hypot(m[0], m[1]), Math.hypot(m[2], m[3]))

/** Нет поворота и скоса: bbox переносится точно по углам */
export const isAxisAligned = (m: Mat) => Math.abs(m[1]) < 1e-9 && Math.abs(m[2]) < 1e-9

/** Bbox прямоугольника после преобразования (по четырем углам) */
export function transformRect(m: Mat, r: Rect): Rect {
  return boundsOf(rectCorners(r).map((p) => apply(m, p)))
}

export function rectCorners(r: Rect): Point[] {
  return [
    { x: r.x, y: r.y },
    { x: r.x + r.width, y: r.y },
    { x: r.x + r.width, y: r.y + r.height },
    { x: r.x, y: r.y + r.height },
  ]
}

export function boundsOf(points: Point[]): Rect {
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const p of points) {
    if (p.x < minX) minX = p.x
    if (p.y < minY) minY = p.y
    if (p.x > maxX) maxX = p.x
    if (p.y > maxY) maxY = p.y
  }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY }
}

export function unionRects(rects: Rect[]): Rect | null {
  if (rects.length === 0) return null
  return boundsOf(rects.flatMap((r) => [
    { x: r.x, y: r.y },
    { x: r.x + r.width, y: r.y + r.height },
  ]))
}

export function inflate(r: Rect, d: number): Rect {
  return { x: r.x - d, y: r.y - d, width: r.width + 2 * d, height: r.height + 2 * d }
}

export const rectContains = (outer: Rect, inner: Rect) =>
  inner.x >= outer.x &&
  inner.y >= outer.y &&
  inner.x + inner.width <= outer.x + outer.width &&
  inner.y + inner.height <= outer.y + outer.height

/** Матрица из SVGTransformList без consolidate() (тот мутирует атрибут) */
export function fromTransformList(list: SVGTransformList): Mat {
  let m: Mat = IDENTITY
  for (let i = 0; i < list.numberOfItems; i++) {
    const t = list.getItem(i).matrix
    m = mul(m, [t.a, t.b, t.c, t.d, t.e, t.f])
  }
  return m
}

/** Число для атрибутов SVG: без хвостовых нулей, без -0 и экспоненты */
export function fmt(n: number, digits = 3): string {
  const v = Number(n.toFixed(digits))
  return Object.is(v, -0) ? '0' : String(v)
}

/** translate(...) для чистого сдвига, иначе matrix(...) */
export function toTransformString(m: Mat): string {
  const [a, b, c, d, e, f] = m
  if (Math.abs(a - 1) < 1e-9 && Math.abs(d - 1) < 1e-9 && isAxisAligned(m)) {
    return `translate(${fmt(e, 4)} ${fmt(f, 4)})`
  }
  return `matrix(${fmt(a, 6)} ${fmt(b, 6)} ${fmt(c, 6)} ${fmt(d, 6)} ${fmt(e, 4)} ${fmt(f, 4)})`
}
