import { listShapes, NON_RENDERED } from './extract'
import { normalizeUrlRefs, SVG_NS, XLINK_NS } from './svg'

export const MAX_SVG_BYTES = 5 * 1024 * 1024

/** Ошибка с текстом для пользователя */
export class SvgImportError extends Error {}

/* ---------- Очистка: файл будет вставлен в страницу инлайном ---------- */

const FORBIDDEN = new Set([
  'script',
  'foreignobject',
  'iframe',
  'object',
  'embed',
  'audio',
  'video',
  'canvas',
  'animate',
  'animatemotion',
  'animatetransform',
  'animatecolor',
  'set',
  'discard',
  'handler',
  'listener',
])

const RASTER_DATA_URL = /^\s*data:image\/(png|jpe?g|gif|webp);/i

/** url(...) наружу (не #id) заменяем на none: никаких внешних запросов из чужого файла */
const stripExternalUrls = (value: string) =>
  value.replace(/url\(\s*(['"]?)([^)'"]*)\1\s*\)/gi, (whole, _q: string, target: string) =>
    target.trim().startsWith('#') ? whole : 'none',
  )

/**
 * Удаляет все, что может выполнить код или сходить в сеть: скрипты, обработчики,
 * анимации (умеют подменять href), внешние ссылки и @import. Ссылки внутри файла (#id) остаются.
 */
export function sanitizeSvg(root: Element) {
  for (const el of Array.from(root.querySelectorAll('*'))) {
    if (FORBIDDEN.has(el.localName.toLowerCase())) el.remove()
  }
  // <a> разворачиваем в <g>: ссылка не нужна, содержимое нужно
  for (const a of Array.from(root.querySelectorAll('a'))) {
    const g = root.ownerDocument.createElementNS(SVG_NS, 'g')
    for (const attr of Array.from(a.attributes)) {
      if (attr.localName !== 'href' && attr.localName !== 'target') g.setAttribute(attr.name, attr.value)
    }
    g.append(...Array.from(a.childNodes))
    a.replaceWith(g)
  }
  for (const el of [root, ...Array.from(root.querySelectorAll('*'))]) {
    for (const attr of Array.from(el.attributes)) {
      const value = attr.value
      if (/^on/i.test(attr.localName) || /javascript:/i.test(value)) {
        el.removeAttributeNode(attr)
      } else if (attr.localName === 'href') {
        const internal = value.trim().startsWith('#')
        if (!internal && !(el.localName === 'image' && RASTER_DATA_URL.test(value))) el.removeAttributeNode(attr)
      } else if (value.includes('url(')) {
        attr.value = stripExternalUrls(value)
      }
    }
  }
  for (const style of Array.from(root.querySelectorAll('style'))) {
    style.textContent = stripExternalUrls((style.textContent ?? '').replace(/@import[^;]*;?/gi, ''))
  }
}

/* ---------- Нормализация: к виду, на который рассчитано извлечение ---------- */

/** Свойства, которые таблица стилей может задать и которые влияют на вид фигур */
const STYLE_PROPS = [
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
  'opacity',
  'display',
  'visibility',
  'stop-color',
  'stop-opacity',
  'clip-path',
  'clip-rule',
  'mask',
  'filter',
  'paint-order',
  'vector-effect',
  'mix-blend-mode',
]

/**
 * <style> и классы → inline-стили. Сравниваем вычисленные значения со стилями и без них:
 * так учитываются специфичность, порядок правил и наследование от групп.
 * После этого <style> удаляется: CSS пользователя не протечет в интерфейс, а клоны фигур
 * при извлечении сохранят цвета.
 */
function inlineStylesheets(svg: SVGSVGElement) {
  const sheets = Array.from(svg.querySelectorAll('style'))
  if (sheets.length === 0) return
  const elements = [svg, ...Array.from(svg.querySelectorAll('*'))].filter(
    (el): el is SVGElement => el instanceof SVGElement && el.localName !== 'style',
  )
  const read = () =>
    elements.map((el) => {
      const cs = getComputedStyle(el)
      return STYLE_PROPS.map((p) => cs.getPropertyValue(p))
    })
  const styled = read()
  sheets.forEach((s) => s.remove())
  const plain = read()
  elements.forEach((el, i) => {
    STYLE_PROPS.forEach((prop, j) => {
      const value = styled[i]![j]!
      if (value !== plain[i]![j]) el.style.setProperty(prop, normalizeUrlRefs(value))
    })
    el.removeAttribute('class')
  })
}

const num = (v: string | null, fallback = 0) => {
  const n = parseFloat(v ?? '')
  return Number.isFinite(n) ? n : fallback
}

type ViewBox = { x: number; y: number; w: number; h: number }

function parseViewBox(el: Element): ViewBox | null {
  const parts = (el.getAttribute('viewBox') ?? '').trim().split(/[\s,]+/).map(Number)
  if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) return null
  const [x, y, w, h] = parts as [number, number, number, number]
  return w > 0 && h > 0 ? { x, y, w, h } : null
}

/** Вписывание viewBox в окно w×h (preserveAspectRatio по умолчанию: xMidYMid meet) */
function viewBoxTransform(vb: ViewBox, w: number, h: number): string {
  const s = Math.min(w / vb.w, h / vb.h)
  const tx = (w - vb.w * s) / 2 - vb.x * s
  const ty = (h - vb.h * s) / 2 - vb.y * s
  return `translate(${tx} ${ty}) scale(${s})`
}

const PLACEMENT_ATTRS = new Set(['x', 'y', 'width', 'height', 'viewBox', 'preserveAspectRatio', 'href', 'transform', 'id'])

/** Перенос стилевых атрибутов (fill, class-стили уже inline и т.п.) на группу-замену */
function copyPresentation(from: Element, to: Element) {
  for (const attr of Array.from(from.attributes)) {
    if (!PLACEMENT_ATTRS.has(attr.localName) && !attr.name.startsWith('xmlns')) to.setAttribute(attr.name, attr.value)
  }
}

/**
 * <use> → копия того, на что он ссылается, в <g transform>. Извлечение работает с реальными
 * фигурами в DOM, а содержимое <use> живет в теневом дереве и недоступно для клика и getBBox.
 */
function expandUses(svg: SVGSVGElement) {
  const doc = svg.ownerDocument
  for (let pass = 0; pass < 8; pass++) {
    const uses = Array.from(svg.querySelectorAll('use')).filter((u) => !u.closest(NON_RENDERED))
    if (uses.length === 0) return
    for (const use of uses) {
      const href = use.getAttribute('href') ?? use.getAttributeNS(XLINK_NS, 'href') ?? ''
      const target = href.startsWith('#') ? svg.querySelector(`#${CSS.escape(href.slice(1))}`) : null
      if (!target || target.contains(use)) {
        use.remove()
        continue
      }
      const g = doc.createElementNS(SVG_NS, 'g')
      copyPresentation(use, g)
      const parts = [use.getAttribute('transform') ?? '']
      const x = num(use.getAttribute('x'))
      const y = num(use.getAttribute('y'))
      if (x || y) parts.push(`translate(${x} ${y})`)
      let content: Element
      if (target.localName === 'symbol' || target.localName === 'svg') {
        content = doc.createElementNS(SVG_NS, 'g')
        copyPresentation(target, content)
        content.append(...Array.from(target.cloneNode(true).childNodes))
        const vb = parseViewBox(target)
        const w = num(use.getAttribute('width'), num(target.getAttribute('width')))
        const h = num(use.getAttribute('height'), num(target.getAttribute('height')))
        if (vb && w > 0 && h > 0) parts.push(viewBoxTransform(vb, w, h))
      } else {
        content = target.cloneNode(true) as Element
        content.removeAttribute('id')
      }
      const transform = parts.join(' ').trim()
      if (transform) g.setAttribute('transform', transform)
      g.appendChild(content)
      use.replaceWith(g)
    }
  }
}

/** Вложенные <svg> → <g> с эквивалентным переносом и масштабом (обрезка по окну теряется) */
function flattenNestedSvgs(svg: SVGSVGElement) {
  const doc = svg.ownerDocument
  const nested = Array.from(svg.querySelectorAll('svg')).filter((s) => !s.closest(NON_RENDERED)) as SVGSVGElement[]
  // Изнутри наружу, чтобы размеры вложенных считались в еще не тронутом окружении
  for (const inner of nested.reverse()) {
    const x = inner.x.baseVal.value
    const y = inner.y.baseVal.value
    const w = inner.width.baseVal.value
    const h = inner.height.baseVal.value
    const g = doc.createElementNS(SVG_NS, 'g')
    copyPresentation(inner, g)
    const parts: string[] = []
    if (x || y) parts.push(`translate(${x} ${y})`)
    const vb = parseViewBox(inner)
    if (vb && w > 0 && h > 0) parts.push(viewBoxTransform(vb, w, h))
    if (parts.length) g.setAttribute('transform', parts.join(' '))
    g.append(...Array.from(inner.childNodes))
    inner.replaceWith(g)
  }
}

const ABSOLUTE_LENGTH = /^\s*([\d.]+)\s*(px)?\s*$/i

/** Нужен viewBox (координаты корня) и абсолютные width/height (для превью в <img>) */
function ensureViewBox(svg: SVGSVGElement) {
  let vb = parseViewBox(svg)
  if (!vb) {
    const w = ABSOLUTE_LENGTH.exec(svg.getAttribute('width') ?? '')?.[1]
    const h = ABSOLUTE_LENGTH.exec(svg.getAttribute('height') ?? '')?.[1]
    if (w && h && Number(w) > 0 && Number(h) > 0) {
      vb = { x: 0, y: 0, w: Number(w), h: Number(h) }
    } else {
      const b = svg.getBBox()
      if (!(b.width > 0 && b.height > 0)) throw new SvgImportError('не удалось определить размеры рисунка')
      vb = { x: b.x, y: b.y, w: b.width, h: b.height }
    }
    svg.setAttribute('viewBox', `${vb.x} ${vb.y} ${vb.w} ${vb.h}`)
  }
  if (!ABSOLUTE_LENGTH.test(svg.getAttribute('width') ?? '') || !ABSOLUTE_LENGTH.test(svg.getAttribute('height') ?? '')) {
    svg.setAttribute('width', String(vb.w))
    svg.setAttribute('height', String(vb.h))
  }
}

/**
 * Текст SVG → безопасный нормализованный SVG, готовый к извлечению.
 * Для вычисления стилей и размеров файл временно монтируется вне экрана.
 */
export function prepareSvgText(text: string): { svgText: string; shapeCount: number } {
  const doc = new DOMParser().parseFromString(text, 'image/svg+xml')
  const parsed = doc.documentElement
  if (doc.querySelector('parsererror') || parsed.localName !== 'svg' || parsed.namespaceURI !== SVG_NS) {
    throw new SvgImportError('файл не является корректным SVG')
  }
  sanitizeSvg(parsed)
  const svg = document.importNode(parsed, true) as unknown as SVGSVGElement
  const host = document.createElement('div')
  host.setAttribute('aria-hidden', 'true')
  host.style.cssText = 'position:fixed;left:-20000px;top:0;width:1200px;height:900px;visibility:hidden;pointer-events:none'
  host.appendChild(svg)
  document.body.appendChild(host)
  try {
    inlineStylesheets(svg)
    expandUses(svg)
    flattenNestedSvgs(svg)
    ensureViewBox(svg)
    const shapeCount = listShapes(svg).length
    if (shapeCount === 0) throw new SvgImportError('в файле нет векторных фигур (path, rect, circle…)')
    return { svgText: new XMLSerializer().serializeToString(svg), shapeCount }
  } finally {
    host.remove()
  }
}

/** Файл пользователя → нормализованный SVG и название */
export async function importSvgFile(file: File): Promise<{ title: string; svgText: string; shapeCount: number }> {
  if (!/\.svg$/i.test(file.name) && file.type !== 'image/svg+xml') throw new SvgImportError('нужен файл .svg')
  if (file.size > MAX_SVG_BYTES) throw new SvgImportError(`файл больше ${MAX_SVG_BYTES / 1024 / 1024} МБ`)
  const prepared = prepareSvgText(await file.text())
  const title = file.name.replace(/\.svg$/i, '').replace(/[_-]+/g, ' ').trim() || 'Мой SVG'
  return { title, ...prepared }
}
