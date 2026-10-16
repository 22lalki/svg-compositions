import { listShapes, NON_RENDERED } from './extract'
import { normalizeUrlRefs, SVG_NS, XLINK_NS } from './svg'

export const MAX_SVG_BYTES = 5 * 1024 * 1024
/** Предел элементов после раскрытия <use>: маленький файл с вложенными <use> иначе разрастается до миллионов узлов */
export const MAX_SVG_ELEMENTS = 60_000
/** Предел фигур: дальше разбор и выделение объектов заметно подвешивают вкладку */
export const MAX_SVG_SHAPES = 5_000

const tooComplex = (what: string) => new SvgImportError(`слишком сложный файл: ${what}`)

/** Ошибка с текстом для пользователя */
export class SvgImportError extends Error {}

/* ---------- Очистка: файл будет вставлен в страницу инлайном ---------- */

/**
 * Разрешенные элементы SVG. Все прочие — включая элементы из чужих пространств имен (XHTML внутри SVG),
 * скрипты, анимации (умеют подменять ссылки), foreignObject, feImage — удаляются вместе с содержимым.
 * Белый список надежнее черного: неизвестное по умолчанию запрещено
 */
const ALLOWED_ELEMENTS = new Set([
  'svg', 'g', 'defs', 'symbol', 'use', 'a', 'style', 'title', 'desc',
  'path', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon', 'image',
  'text', 'tspan', 'textPath',
  'linearGradient', 'radialGradient', 'stop', 'pattern', 'clipPath', 'mask', 'marker',
  'filter', 'feBlend', 'feColorMatrix', 'feComponentTransfer', 'feComposite', 'feConvolveMatrix',
  'feDiffuseLighting', 'feDisplacementMap', 'feDistantLight', 'feDropShadow', 'feFlood', 'feFuncA', 'feFuncB',
  'feFuncG', 'feFuncR', 'feGaussianBlur', 'feMerge', 'feMergeNode', 'feMorphology', 'feOffset', 'fePointLight',
  'feSpecularLighting', 'feSpotLight', 'feTile', 'feTurbulence',
])

const XML_NS = 'http://www.w3.org/XML/1998/namespace'
const XMLNS_NS = 'http://www.w3.org/2000/xmlns/'
const RASTER_DATA_URL = /^\s*data:image\/(png|jpe?g|gif|webp);/i
/** CSS-функции, которые загружают ресурс не через url(): image-set("…"), cross-fade(), element(), src() */
const LOADING_FUNCTIONS = /(?:image-set|image|cross-fade|element|src)\s*\(/i

/** Все url(...) в значении ведут внутрь файла (#id). Разбор терпим к кавычкам и скобкам внутри них */
function onlyInternalUrls(value: string): boolean {
  const re = /url\s*\(/gi
  for (let m = re.exec(value); m; m = re.exec(value)) {
    let i = m.index + m[0].length
    while (/\s/.test(value[i] ?? '')) i++
    const quote = value[i] === '"' || value[i] === "'" ? value[i]! : null
    const end = quote ? value.indexOf(quote, i + 1) : value.indexOf(')', i)
    if (end < 0) return false
    const target = value.slice(quote ? i + 1 : i, end).trim()
    if (!target.startsWith('#')) return false
    re.lastIndex = end + 1
  }
  return true
}

/** Значение не выполняет код и не ходит в сеть */
function safeValue(value: string): boolean {
  if (/(?:java|vb)script:/i.test(value.replace(/[\s\u0000-\u001f]+/g, ''))) return false
  // Экранирование в CSS (u\rl(…)) прячет функции от проверки — такие значения не нужны рисунку
  if (value.includes('\\')) return false
  return onlyInternalUrls(value) && !LOADING_FUNCTIONS.test(value)
}

/** Объявления CSS (style="…" или правило таблицы) без внешних ресурсов. Значения уже разобраны браузером */
function cleanDeclarations(style: CSSStyleDeclaration) {
  for (let k = style.length - 1; k >= 0; k--) {
    const prop = style.item(k)
    if (!safeValue(style.getPropertyValue(prop))) style.removeProperty(prop)
  }
}

/**
 * Таблица стилей → только правила с безопасными объявлениями (и они же внутри @media).
 * @import, @font-face, @namespace, @keyframes и прочие at-правила отбрасываются.
 * Разбирает браузер (CSSStyleSheet без подключения к странице), регулярные выражения не нужны
 */
function cleanStylesheet(text: string): string {
  let sheet: CSSStyleSheet
  try {
    sheet = new CSSStyleSheet()
    sheet.replaceSync(text)
  } catch {
    return '' // браузер без конструируемых таблиц стилей: безопаснее не переносить стили вовсе
  }
  const rules = (list: CSSRuleList): string[] =>
    Array.from(list).flatMap((rule) => {
      if (rule instanceof CSSStyleRule) {
        if (rule.cssRules?.length) return [] // вложенные правила (CSS nesting) не разбираем
        cleanDeclarations(rule.style)
        return rule.style.length ? [rule.cssText] : []
      }
      if (rule instanceof CSSMediaRule) {
        const inner = rules(rule.cssRules)
        return inner.length ? [`@media ${rule.media.mediaText} { ${inner.join(' ')} }`] : []
      }
      return []
    })
  return rules(sheet.cssRules).join('\n')
}

/**
 * Очистка чужого SVG перед вставкой в страницу: остаются только разрешенные элементы SVG, текст и безопасные
 * атрибуты. Комментарии и инструкции обработки удаляются: при разборе как HTML они превращаются в элементы.
 * Обработчики on*, javascript:, внешние href и url(...) удаляются. Ссылки внутри файла (#id) остаются.
 * keepStyles: false — заодно удалить <style> и классы (разметка компонентов: стили уже перенесены в атрибуты)
 */
export function sanitizeSvg(root: Element, { keepStyles = true } = {}) {
  if (!keepStyles) for (const el of Array.from(root.querySelectorAll('[class]'))) el.removeAttribute('class')
  const doc = root.ownerDocument
  // Обход без рекурсии: глубокая вложенность не переполнит стек
  const stack: Element[] = [root]
  while (stack.length) {
    const el = stack.pop()!
    for (const child of Array.from(el.childNodes)) {
      if (child.nodeType === Node.ELEMENT_NODE) {
        const c = child as Element
        if (c.namespaceURI !== SVG_NS || !ALLOWED_ELEMENTS.has(c.localName) || (c.localName === 'style' && !keepStyles)) c.remove()
        else stack.push(c)
      } else if (child.nodeType === Node.CDATA_SECTION_NODE) {
        child.replaceWith(doc.createTextNode((child as CDATASection).data))
      } else if (child.nodeType !== Node.TEXT_NODE) {
        child.remove() // комментарии, инструкции обработки
      }
    }
  }
  for (const el of [root, ...Array.from(root.querySelectorAll('*'))]) {
    for (const attr of Array.from(el.attributes)) {
      const ns = attr.namespaceURI
      const name = attr.localName
      if (ns === XMLNS_NS) continue // объявления пространств имен
      const known = ns === null || (ns === XLINK_NS && name === 'href') || (ns === XML_NS && (name === 'space' || name === 'lang'))
      if (!known || /^on/i.test(name)) {
        el.removeAttributeNode(attr)
      } else if (name === 'href') {
        const internal = attr.value.trim().startsWith('#')
        if (!internal && !(el.localName === 'image' && RASTER_DATA_URL.test(attr.value))) el.removeAttributeNode(attr)
      } else if (name === 'style' && el instanceof SVGElement) {
        cleanDeclarations(el.style)
        if (!el.style.length) el.removeAttribute('style')
      } else if (!safeValue(attr.value)) {
        el.removeAttributeNode(attr)
      }
    }
  }
  // <a> разворачиваем в <g>: ссылка не нужна, содержимое нужно
  for (const a of Array.from(root.querySelectorAll('a'))) {
    const g = doc.createElementNS(SVG_NS, 'g')
    for (const attr of Array.from(a.attributes)) {
      if (attr.localName !== 'href' && attr.localName !== 'target') g.setAttributeNS(attr.namespaceURI, attr.name, attr.value)
    }
    g.append(...Array.from(a.childNodes))
    a.replaceWith(g)
  }
  for (const style of Array.from(root.querySelectorAll('style'))) style.textContent = cleanStylesheet(style.textContent ?? '')
}

/* ---------- Нормализация: к виду, на который рассчитано извлечение ---------- */

/** Свойства, которые таблица стилей может задать и которые влияют на вид фигур */
const STYLE_PROPS = [
  'color',
  'marker-start',
  'marker-mid',
  'marker-end',
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

/** Разумный размер: браузер сам отвергает viewBox вроде 1e39 или 1e-50, и рисунок схлопывается */
const sane = (n: number) => n >= 1e-3 && n <= 1e7

function parseViewBox(el: Element): ViewBox | null {
  const parts = (el.getAttribute('viewBox') ?? '').trim().split(/[\s,]+/).map(Number)
  if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n) || Math.abs(n) > 1e7)) return null
  const [x, y, w, h] = parts as [number, number, number, number]
  return sane(w) && sane(h) ? { x, y, w, h } : null
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
  let elements = svg.getElementsByTagName('*').length
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
      }
      for (const el of [content, ...Array.from(content.querySelectorAll('[id]'))]) el.removeAttribute('id')
      const transform = parts.join(' ').trim()
      if (transform) g.setAttribute('transform', transform)
      g.appendChild(content)
      elements += content.getElementsByTagName('*').length + 1
      if (elements > MAX_SVG_ELEMENTS) throw tooComplex(`больше ${MAX_SVG_ELEMENTS} элементов после раскрытия <use>`)
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
    if (w && h && sane(Number(w)) && sane(Number(h))) {
      vb = { x: 0, y: 0, w: Number(w), h: Number(h) }
    } else {
      const b = svg.getBBox()
      if (!(sane(b.width) && sane(b.height))) throw new SvgImportError('не удалось определить размеры рисунка')
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
  if (parsed.getElementsByTagName('*').length > MAX_SVG_ELEMENTS) throw tooComplex(`больше ${MAX_SVG_ELEMENTS} элементов`)
  sanitizeSvg(parsed)
  const svg = document.importNode(parsed, true) as unknown as SVGSVGElement
  const host = document.createElement('div')
  host.setAttribute('aria-hidden', 'true')
  host.style.cssText = 'position:fixed;left:-20000px;top:0;width:1200px;height:900px;visibility:hidden;pointer-events:none'
  host.appendChild(svg)
  document.body.appendChild(host)
  try {
    inlineStylesheets(svg)
    for (const el of Array.from(svg.querySelectorAll('[class]'))) el.removeAttribute('class')
    expandUses(svg)
    flattenNestedSvgs(svg)
    ensureViewBox(svg)
    const shapeCount = listShapes(svg).length
    if (shapeCount === 0) throw new SvgImportError('в файле нет векторных фигур (path, rect, circle…)')
    if (shapeCount > MAX_SVG_SHAPES) throw tooComplex(`${shapeCount} фигур, допустимо до ${MAX_SVG_SHAPES}`)
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
