import { sanitizeSvg } from './importSvg'
import { SVG_NS, XLINK_NS } from './svg'

/**
 * Разметка компонента (defs или фигуры) → очищенный <svg>-шаблон. Разбор только парсером XML:
 * через innerHTML разметка читалась бы парсером HTML, а он понимает некоторые конструкции SVG иначе
 * (инструкция обработки внутри фигуры превращается в живой HTML-элемент). Очистка повторяется и для
 * компонентов, сохраненных раньше, — в IndexedDB могла остаться разметка до нынешних правил.
 */
const templates = new Map<string, SVGSVGElement>()
const MAX_CACHED = 500

function template(markup: string): SVGSVGElement {
  let tpl = templates.get(markup)
  if (!tpl) {
    const doc = new DOMParser().parseFromString(`<svg xmlns="${SVG_NS}" xmlns:xlink="${XLINK_NS}">${markup}</svg>`, 'image/svg+xml')
    const root = doc.documentElement
    if (doc.querySelector('parsererror') || root.namespaceURI !== SVG_NS || root.localName !== 'svg') {
      tpl = document.createElementNS(SVG_NS, 'svg')
    } else {
      sanitizeSvg(root, { keepStyles: false })
      tpl = document.importNode(root, true) as unknown as SVGSVGElement
    }
    if (templates.size >= MAX_CACHED) templates.delete(templates.keys().next().value!)
    templates.set(markup, tpl)
  }
  return tpl
}

/** Узлы для вставки в SVG страницы (каждый раз свежая копия шаблона) */
export function svgNodes(markup: string): Node[] {
  return Array.from(template(markup).cloneNode(true).childNodes)
}

const serializer = typeof XMLSerializer !== 'undefined' ? new XMLSerializer() : null
const cleaned = new Map<string, string>()

/** Очищенная разметка строкой — для экспорта и превью в <img> */
export function cleanMarkup(markup: string): string {
  let out = cleaned.get(markup)
  if (out === undefined) {
    out = Array.from(template(markup).childNodes)
      .map((n) => serializer!.serializeToString(n).replace(/ xmlns(?::xlink)?="[^"]*"/g, ''))
      .join('')
    if (cleaned.size >= MAX_CACHED) cleaned.delete(cleaned.keys().next().value!)
    cleaned.set(markup, out)
  }
  return out
}
