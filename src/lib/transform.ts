import type { Point, SceneObject } from '../types'
import { fmt, mul, rotation, scaling, translate, type Mat } from './matrix'

type Size = { width: number; height: number }

/**
 * Единственный источник трансформации объекта — и для холста, и для экспорта:
 * translate(x + cx, y + cy) rotate(rotation) scale(±scale, scaleY) translate(-cx, -cy)
 */
export function objectTransform(o: SceneObject, size: Size): string {
  const cx = size.width / 2
  const cy = size.height / 2
  const sx = o.flipX ? -o.scale : o.scale
  return (
    `translate(${fmt(o.x + cx)} ${fmt(o.y + cy)}) rotate(${fmt(o.rotation)}) ` +
    `scale(${fmt(sx, 5)} ${fmt(o.scaleY, 5)}) translate(${fmt(-cx)} ${fmt(-cy)})`
  )
}

/** Та же трансформация в виде матрицы (для ручек и проверок) */
export function objectMatrix(o: SceneObject, size: Size): Mat {
  const cx = size.width / 2
  const cy = size.height / 2
  return [
    translate(o.x + cx, o.y + cy),
    rotation(o.rotation),
    scaling(o.flipX ? -o.scale : o.scale, o.scaleY),
    translate(-cx, -cy),
  ].reduce(mul)
}

export const objectCenter = (o: SceneObject, size: Size): Point => ({
  x: o.x + size.width / 2,
  y: o.y + size.height / 2,
})

/** Видимая рамка объекта: центр, полуразмеры и угол (отражение на рамку не влияет) */
export function objectFrame(o: SceneObject, size: Size) {
  return {
    center: objectCenter(o, size),
    hw: (size.width / 2) * o.scale,
    hh: (size.height / 2) * o.scaleY,
    rotation: o.rotation,
  }
}

export function rotateVec(v: Point, deg: number): Point {
  const r = (deg * Math.PI) / 180
  const cos = Math.cos(r)
  const sin = Math.sin(r)
  return { x: v.x * cos - v.y * sin, y: v.x * sin + v.y * cos }
}

/** Точка в системе видимой рамки (sx, sy ∈ [-1, 1]) → координаты артборда */
export function framePoint(frame: ReturnType<typeof objectFrame>, sx: number, sy: number, extraY = 0): Point {
  const v = rotateVec({ x: sx * frame.hw, y: sy * frame.hh + extraY }, frame.rotation)
  return { x: frame.center.x + v.x, y: frame.center.y + v.y }
}

/** Угол в (-180, 180] */
export function normalizeAngle(deg: number): number {
  let a = deg % 360
  if (a <= -180) a += 360
  if (a > 180) a -= 360
  return Object.is(a, -0) ? 0 : a
}
