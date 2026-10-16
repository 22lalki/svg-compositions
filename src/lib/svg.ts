export const SVG_NS = 'http://www.w3.org/2000/svg'
export const XLINK_NS = 'http://www.w3.org/1999/xlink'

const serializer = typeof XMLSerializer !== 'undefined' ? new XMLSerializer() : null

/**
 * XML-разметка узла без объявлений пространств имен:
 * они ставятся один раз на корневой <svg> (превью, экспорт, разбор в lib/markup.ts).
 */
export function serializeFragment(node: Element): string {
  if (!serializer) throw new Error('XMLSerializer недоступен')
  return serializer.serializeToString(node).replace(/ xmlns(?::xlink)?="[^"]*"/g, '')
}

export function escapeXml(s: string): string {
  return s.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`)
}

/** Самостоятельный SVG-документ из defs и разметки (превью компонента) */
export function standaloneSvg(c: { width: number; height: number; defs: string; markup: string }): string {
  const w = Math.max(c.width, 1)
  const h = Math.max(c.height, 1)
  return (
    `<svg xmlns="${SVG_NS}" xmlns:xlink="${XLINK_NS}" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">` +
    (c.defs ? `<defs>${c.defs}</defs>` : '') +
    c.markup +
    `</svg>`
  )
}

export const svgDataUrl = (svg: string) => `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`

/** url(#id) в атрибутах и style; кавычки и абсолютный URL (из getComputedStyle) допускаются */
export const URL_REF_RE = /url\(\s*(['"]?)[^)'"#]*#([^)'"\s]+)\1\s*\)/g

/** url("http://host/page#id") из getComputedStyle → url(#id) */
export function normalizeUrlRefs(value: string): string {
  return value.replace(URL_REF_RE, (_w, _q: string, id: string) => `url(#${id})`)
}

/** Все id, на которые ссылается элемент своими атрибутами */
export function refsOf(el: Element): string[] {
  const ids: string[] = []
  for (const attr of Array.from(el.attributes)) {
    if (attr.localName === 'href') {
      if (attr.value.startsWith('#')) ids.push(attr.value.slice(1))
    } else if (attr.value.includes('url(')) {
      for (const m of attr.value.matchAll(URL_REF_RE)) if (m[2]) ids.push(m[2])
    }
  }
  return ids
}

/** Переписывает ссылки url(#id) и href="#id" по карте переименования */
export function rewriteRefs(el: Element, rename: Map<string, string>) {
  for (const attr of Array.from(el.attributes)) {
    if (attr.localName === 'href') {
      const next = attr.value.startsWith('#') ? rename.get(attr.value.slice(1)) : undefined
      if (next) attr.value = `#${next}`
    } else if (attr.value.includes('url(')) {
      attr.value = attr.value.replace(URL_REF_RE, (whole, _q: string, id: string) => {
        const next = rename.get(id)
        return next ? `url(#${next})` : whole
      })
    }
  }
}

/** Элемент и все его потомки */
export function selfAndDescendants(el: Element): Element[] {
  return [el, ...Array.from(el.querySelectorAll('*'))]
}
