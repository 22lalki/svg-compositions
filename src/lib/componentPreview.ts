import type { Component } from '../types'
import { cleanMarkup } from './markup'
import { standaloneSvg, svgDataUrl } from './svg'

/** MIME для перетаскивания карточки библиотеки на холст */
export const COMPONENT_MIME = 'application/x-svg-component'

const previewCache = new WeakMap<Component, string>()

/** data:-URL превью компонента (изолированный <img>, id не пересекаются с холстом) */
export function componentPreview(c: Component): string {
  let url = previewCache.get(c)
  if (!url) {
    url = svgDataUrl(standaloneSvg({ ...c, defs: cleanMarkup(c.defs), markup: cleanMarkup(c.markup) }))
    previewCache.set(c, url)
  }
  return url
}
