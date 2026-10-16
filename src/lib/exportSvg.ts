import type { Component, Scene } from '../types'
import { fmt } from './matrix'
import { cleanMarkup } from './markup'
import { escapeXml, SVG_NS, XLINK_NS } from './svg'
import { objectTransform } from './transform'

/** Defs всех использованных компонентов, каждого ровно один раз (по componentId) */
export function sharedDefs(scene: Scene, components: ReadonlyMap<string, Component>): string {
  const used = new Set(scene.objects.map((o) => o.componentId))
  return Array.from(used)
    .sort()
    .map((id) => components.get(id)?.defs ?? '')
    .join('')
}

/**
 * Итоговый SVG: viewBox артборда, общий <defs>, белый фон,
 * каждый объект — отдельная группа с разметкой компонента. Порядок групп = порядок слоев.
 */
export function buildExportSvg(scene: Scene, components: ReadonlyMap<string, Component>): string {
  const w = fmt(scene.width)
  const h = fmt(scene.height)
  const defs = cleanMarkup(sharedDefs(scene, components))
  const lines = [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<svg xmlns="${SVG_NS}" xmlns:xlink="${XLINK_NS}" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">`,
    defs ? `  <defs>${defs}</defs>` : `  <defs/>`,
    `  <rect id="background" width="${w}" height="${h}" fill="#ffffff"/>`,
  ]
  for (const o of scene.objects) {
    const c = components.get(o.componentId)
    if (!c) continue
    lines.push(
      `  <g id="obj-${o.id}" data-component="${escapeXml(c.id)}" data-name="${escapeXml(c.name)}" ` +
        `transform="${objectTransform(o, c)}">${cleanMarkup(c.markup)}</g>`,
    )
  }
  lines.push(`</svg>`, ``)
  return lines.join('\n')
}

export function downloadText(text: string, filename: string, type = 'image/svg+xml') {
  const url = URL.createObjectURL(new Blob([text], { type }))
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

export function exportFileName(date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return `composition-${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}-${p(date.getHours())}${p(date.getMinutes())}.svg`
}
