import { memo, useLayoutEffect, useMemo, useRef } from 'react'
import { svgNodes } from '../../lib/markup'
import { svgDataUrl, SVG_NS, XLINK_NS } from '../../lib/svg'
import { getAsset, useAssets } from '../assets'
import type { Item } from '../catalog'
import { objectPalette, recolorMarkup } from '../render'
import type { ObjState, Scheme, SizeKey } from '../model'

/**
 * Разметка вставляется готовыми узлами SVG (разбор XML + очистка, lib/markup.ts), а не через innerHTML.
 * Пересобирается только при смене разметки (перекраска), не при перемещении
 */
export const Markup = memo(function Markup({ markup }: { markup: string }) {
  const ref = useRef<SVGGElement>(null)
  useLayoutEffect(() => {
    ref.current?.replaceChildren(...svgNodes(markup))
  }, [markup])
  return <g ref={ref} />
})

/** Превью объекта в текущей схеме (картинкой: в списке их много, живой SVG не нужен) */
export function ItemThumb({ item, size, state = 'main', scheme, className = '' }: { item: Item; size: SizeKey; state?: ObjState; scheme: Scheme; className?: string }) {
  useAssets((s) => s.version)
  const asset = getAsset(item, size, state)
  const url = useMemo(() => {
    if (!asset) return null
    const markup = recolorMarkup(asset.markup, objectPalette({ state, colors: {} }, scheme))
    return svgDataUrl(`<svg xmlns="${SVG_NS}" xmlns:xlink="${XLINK_NS}" viewBox="0 0 ${asset.width} ${asset.height}">${markup}</svg>`)
  }, [asset, scheme, state])
  if (!url) return <div className={`animate-pulse rounded bg-line/60 ${className}`} />
  return <img src={url} alt="" draggable={false} className={`object-contain ${className}`} />
}
