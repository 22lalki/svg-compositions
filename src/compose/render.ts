import { cleanMarkup } from '../lib/markup'
import { escapeXml, SVG_NS, XLINK_NS } from '../lib/svg'
import { getAsset, type Asset } from './assets'
import { itemSize, type Item } from './catalog'
import {
  BASE_COLORS,
  ROLES,
  SET,
  formatSize,
  isBgKey,
  schemeBgColors,
  schemeColor,
  schemeColors,
  normalizeColor,
  type CObject,
  type Composition,
  type DecorElement,
  type Role,
  type Scheme,
} from './model'

/**
 * Отрисовка композиции: одна и та же разметка идет на холст и в экспорт.
 * Перекраска — замена цветов по ролям: цвет файла → его роль в исходной схеме → цвет этой роли (или выбранной
 * пользователем) в текущей схеме. Геометрия объекта не трогается.
 */

const ROLE_BY_COLOR = new Map(ROLES.map((r) => [BASE_COLORS[r], r]))
export const roleOfColor = (c: string): Role | undefined => {
  const n = normalizeColor(c)
  return n ? ROLE_BY_COLOR.get(n) : undefined
}

/** Роли цветов, которыми нарисован файл (для панели «Цвета объекта») */
const rolesCache = new Map<string, Role[]>()
export function rolesInMarkup(markup: string): Role[] {
  let roles = rolesCache.get(markup)
  if (!roles) {
    const found = new Set<Role>()
    for (const m of markup.matchAll(/(?:fill|stroke|stop-color)\s*[=:]\s*"?([^";)]+)/g)) {
      const r = roleOfColor(m[1]!)
      if (r) found.add(r)
    }
    roles = ROLES.filter((r) => found.has(r))
    rolesCache.set(markup, roles)
  }
  return roles
}

/**
 * Итоговые цвета объекта: роль из файла → цвет схемы (выбранный пользователем или по умолчанию).
 * Фоновому объекту выбор вне цветов фона не применяется — правило схемы
 */
export function objectPalette(o: Pick<CObject, 'state' | 'colors'>, scheme: Scheme): Record<string, string> {
  const map: Record<string, string> = {}
  for (const r of ROLES) {
    const target = o.colors[r]
    map[BASE_COLORS[r]] = schemeColor(scheme, target && (o.state === 'main' || isBgKey(target, scheme)) ? target : r)
  }
  return map
}

/** Кэш перекраски: палитра → (разметка → результат). Палитр в работе немного, разметок — по числу файлов */
const recolored = new Map<string, Map<string, string>>()

export function recolorMarkup(markup: string, palette: Record<string, string>): string {
  const pk = JSON.stringify(palette)
  let byMarkup = recolored.get(pk)
  if (!byMarkup) {
    if (recolored.size >= 64) recolored.delete(recolored.keys().next().value!)
    byMarkup = new Map()
    recolored.set(pk, byMarkup)
  }
  let out = byMarkup.get(markup)
  if (out === undefined) {
    const swap = (value: string) => {
      const n = normalizeColor(value)
      return (n && palette[n]) || value
    }
    out = markup
      .replace(/\b(fill|stroke|stop-color)="([^"]*)"/g, (_, a: string, v: string) => `${a}="${swap(v)}"`)
      .replace(/\b(fill|stroke|stop-color)\s*:\s*([^;"]+)/g, (_, a: string, v: string) => `${a}:${swap(v)}`)
    byMarkup.set(markup, out)
  }
  return out
}

const fmt = (v: number) => String(Math.round(v * 100) / 100)

/** Трансформация объекта: сдвиг и поворот вокруг центра. Масштаба нет — объекты всегда в натуральную величину */
export function objectTransform(o: Pick<CObject, 'x' | 'y' | 'rotation'>, s: { width: number; height: number }): string {
  const t = `translate(${fmt(o.x)} ${fmt(o.y)})`
  return o.rotation ? `${t} rotate(${fmt(o.rotation)} ${fmt(s.width / 2)} ${fmt(s.height / 2)})` : t
}

/** Декор фона текущего размера и формата (с учетом отражения) — разметкой */
export function backgroundMarkup(c: Composition, scheme: Scheme): string {
  const { width, height } = formatSize(c.format, c.size)
  const els: DecorElement[] = c.decor === 'none' ? [] : SET.decor[c.size][c.format][c.decor]
  const paths = els
    .map((e) => {
      const fill = e.fill ? schemeColor(scheme, e.fill) : 'none'
      const stroke = e.stroke ? ` stroke="${schemeColor(scheme, e.stroke)}" stroke-width="${e.strokeWidth ?? 1}"` : ''
      return `<path d="${e.d}" fill="${fill}"${stroke}/>`
    })
    .join('')
  const decor = paths ? (c.mirror ? `<g transform="matrix(-1 0 0 1 ${fmt(width)} 0)">${paths}</g>` : paths) : ''
  return `<rect width="${fmt(width)}" height="${fmt(height)}" fill="${schemeColor(scheme, 'bgLight')}"/>${decor}`
}

export type Resolved = { obj: CObject; item: Item; asset: Asset; markup: string }

/** Объекты сцены с готовой (перекрашенной) разметкой; объекты без загруженного файла пропускаются */
export function resolveObjects(c: Composition, scheme: Scheme, lookup: (id: string) => Item | undefined): Resolved[] {
  return c.objects.flatMap((obj) => {
    const item = lookup(obj.itemId)
    const asset = item && getAsset(item, c.size, obj.state)
    if (!item || !asset) return []
    return [{ obj, item, asset, markup: recolorMarkup(asset.markup, objectPalette(obj, scheme)) }]
  })
}

/** Уникальные читаемые имена слоев: Figma показывает id группы как имя слоя */
function layerNames(list: Resolved[]): Map<string, string> {
  const count = new Map<string, number>()
  const names = new Map<string, string>()
  for (const r of list) {
    const n = (count.get(r.item.name) ?? 0) + 1
    count.set(r.item.name, n)
    names.set(r.obj.id, n === 1 ? r.item.name : `${r.item.name} ${n}`)
  }
  return names
}

const idSafe = (s: string) => escapeXml(s.replace(/\s+/g, '_'))

/**
 * Редактируемый SVG: фон и каждый объект — отдельные именованные группы с контурами (без растра и масок),
 * объединенные объекты — во вложенной группе. Кадр обрезает выступающие объекты, как в примерах.
 */
export function buildCompositionSvg(c: Composition, scheme: Scheme, lookup: (id: string) => Item | undefined): string {
  const { width, height } = formatSize(c.format, c.size)
  const list = resolveObjects(c, scheme, lookup)
  const names = layerNames(list)
  const lines: string[] = [
    `<svg xmlns="${SVG_NS}" xmlns:xlink="${XLINK_NS}" width="${fmt(width)}" height="${fmt(height)}" viewBox="0 0 ${fmt(width)} ${fmt(height)}" fill="none">`,
    `<defs><clipPath id="frame"><rect width="${fmt(width)}" height="${fmt(height)}"/></clipPath></defs>`,
    `<g id="Композиция" clip-path="url(#frame)">`,
    `<g id="Фон">${backgroundMarkup(c, scheme)}</g>`,
  ]
  let group: string | undefined
  let groupNo = 0
  for (const r of list) {
    if (r.obj.groupId !== group) {
      if (group) lines.push('</g>')
      group = r.obj.groupId
      if (group) lines.push(`<g id="Группа_${++groupNo}">`)
    }
    const s = itemSize(r.item, c.size, r.obj.state) ?? r.asset
    lines.push(
      `<g id="${idSafe(names.get(r.obj.id)!)}" data-state="${r.obj.state === 'main' ? 'основной' : 'фоновый'}" ` +
        `transform="${objectTransform(r.obj, s)}">${cleanMarkup(r.markup)}</g>`,
    )
  }
  if (group) lines.push('</g>')
  lines.push('</g>', '</svg>', '')
  return lines.join('\n')
}

/** Все цвета экспортированного SVG (для проверки, что схема не нарушена) */
export function colorsInSvg(svg: string): string[] {
  return [...new Set([...svg.matchAll(/\b(?:fill|stroke|stop-color)="([^"]*)"/g)].map((m) => m[1]!).filter((v) => v !== 'none' && !v.startsWith('url(')).map((v) => normalizeColor(v) ?? v))]
}

export type Issue = { objectId?: string; text: string }

/**
 * Правила ТЗ, проверяемые на итоговом SVG и сцене:
 *  - все цвета — из текущей схемы;
 *  - фоновые объекты и декор — только цвета фона (акценты и черный в фоне запрещены);
 *  - масштаб всегда 1: в трансформациях только сдвиг и поворот;
 *  - основной объект не уходит за кадр почти целиком (предупреждение, не ошибка схемы).
 */
export function validateComposition(c: Composition, scheme: Scheme, lookup: (id: string) => Item | undefined): Issue[] {
  const issues: Issue[] = []
  const allowed = new Set(schemeColors(scheme))
  const bgAllowed = new Set(schemeBgColors(scheme))
  for (const r of resolveObjects(c, scheme, lookup)) {
    const colors = colorsInSvg(r.markup)
    const foreign = colors.filter((x) => !allowed.has(x))
    if (foreign.length) issues.push({ objectId: r.obj.id, text: `${r.item.name}: цвета вне схемы (${foreign.join(', ')})` })
    if (r.obj.state === 'bg') {
      const accent = colors.filter((x) => !bgAllowed.has(x))
      if (accent.length) issues.push({ objectId: r.obj.id, text: `${r.item.name}: в фоновом объекте цвета объектов (${accent.join(', ')})` })
    }
  }
  const bg = colorsInSvg(backgroundMarkup(c, scheme)).filter((x) => !bgAllowed.has(x))
  if (bg.length) issues.push({ text: `Фон: цвета объектов в фоне (${bg.join(', ')})` })
  if (schemeBgColors(scheme).length < 2) {
    for (const o of c.objects.filter((x) => x.state === 'bg')) {
      issues.push({ objectId: o.id, text: `${lookup(o.itemId)?.name ?? 'Объект'}: фоновый объект не виден — в схеме один цвет фона. Сделайте его основным или добавьте в схему цвет фона` })
    }
  }
  return issues
}
