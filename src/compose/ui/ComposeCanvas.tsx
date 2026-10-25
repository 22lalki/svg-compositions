import { useEffect, useRef, useState, type DragEvent as ReactDragEvent, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from 'react'
import { closeContextMenu, mod, openContextMenu, type MenuItem } from '../../store/contextMenu'
import { useAssets } from '../assets'
import { useCatalog, lookupItem, schemeById } from '../catalogStore'
import { expandGroups, normalizeAngle, rotateObjects, sizeOf, useComposition } from '../compositionStore'
import { formatSize, type CObject, type Composition } from '../model'
import { backgroundMarkup, objectTransform, resolveObjects } from '../render'
import { Markup } from './Markup'

export const ITEM_MIME = 'application/x-compose-item'

type Point = { x: number; y: number }
type Gesture =
  | { kind: 'move'; start: Point; startClient: Point; base: Composition; ids: Set<string>; active: boolean }
  | { kind: 'rotate'; center: Point; startAngle: number; base: Composition; ids: Set<string>; active: boolean }
  | { kind: 'marquee'; start: Point; startClient: Point; additive: boolean; prev: string[]; active: boolean }

const PAD = 56
const round2 = (v: number) => Math.round(v * 100) / 100

/** Углы рамки объекта с учетом поворота — для выделения и попадания в рамку выделения */
function corners(o: CObject, s: { width: number; height: number }): Point[] {
  const cx = o.x + s.width / 2
  const cy = o.y + s.height / 2
  const r = (o.rotation * Math.PI) / 180
  const cos = Math.cos(r)
  const sin = Math.sin(r)
  return [
    [-1, -1],
    [1, -1],
    [1, 1],
    [-1, 1],
  ].map(([sx, sy]) => {
    const dx = (sx! * s.width) / 2
    const dy = (sy! * s.height) / 2
    return { x: cx + dx * cos - dy * sin, y: cy + dx * sin + dy * cos }
  })
}

function bounds(points: Point[]) {
  const xs = points.map((p) => p.x)
  const ys = points.map((p) => p.y)
  return { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) }
}

/** Меню объекта: действие применяется к тому, по чему кликнули (и его группе) */
export function objectMenu(id: string): MenuItem[] {
  const s = useComposition.getState()
  const o = s.comp.objects.find((x) => x.id === id)
  if (!o) return []
  const run = (action: () => void) => () => {
    if (!useComposition.getState().comp.objects.some((x) => x.id === id)) return
    if (!useComposition.getState().selected.includes(id)) useComposition.getState().select(id)
    action()
  }
  const st = () => useComposition.getState()
  const several = s.selected.length > 1 && s.selected.includes(id)
  return [
    { label: 'Дублировать', icon: 'copy', shortcut: mod('D'), onSelect: run(() => st().duplicateSelected()) },
    o.groupId
      ? { label: 'Разъединить', icon: 'group', shortcut: mod('Shift+G'), onSelect: run(() => st().ungroupSelected()) }
      : { label: 'Объединить', icon: 'group', shortcut: mod('G'), disabled: !several, onSelect: run(() => st().groupSelected()) },
    o.state === 'main'
      ? { label: 'Сделать фоновым', icon: 'layers', disabled: !lookupItem(o.itemId)?.variants[`${s.comp.size}-bg`], onSelect: run(() => st().setState(id, 'bg')) }
      : { label: 'Сделать основным', icon: 'layers', onSelect: run(() => st().setState(id, 'main')) },
    'separator',
    { label: 'На передний план', icon: 'front', shortcut: mod('Shift+]'), onSelect: run(() => st().reorderSelected('front')) },
    { label: 'Вперед', icon: 'forward', shortcut: mod(']'), onSelect: run(() => st().reorderSelected('forward')) },
    { label: 'Назад', icon: 'backward', shortcut: mod('['), onSelect: run(() => st().reorderSelected('backward')) },
    { label: 'На задний план', icon: 'back', shortcut: mod('Shift+['), onSelect: run(() => st().reorderSelected('back')) },
    'separator',
    { label: 'Удалить', icon: 'trash', shortcut: 'Delete', danger: true, onSelect: run(() => st().removeSelected()) },
  ]
}

export function ComposeCanvas() {
  const comp = useComposition((s) => s.comp)
  const selected = useComposition((s) => s.selected)
  useAssets((s) => s.version)
  useCatalog((s) => s.items)
  useCatalog((s) => s.schemes)
  const scheme = schemeById(comp.schemeId)

  const containerRef = useRef<HTMLDivElement>(null)
  const svgRef = useRef<SVGSVGElement>(null)
  const [box, setBox] = useState<{ w: number; h: number } | null>(null)
  const [gesture, setGesture] = useState<Gesture['kind'] | null>(null)
  const [marquee, setMarquee] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null)

  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const ro = new ResizeObserver(([e]) => e && setBox({ w: e.contentRect.width, h: e.contentRect.height }))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const frame = formatSize(comp.format, comp.size)
  const resolved = resolveObjects(comp, scheme, lookupItem)
  const background = backgroundMarkup(comp, scheme)

  // Вид: кадр вписан с полями — видно и то, что выступает за край (в экспорт оно не попадет)
  let viewBox = `0 0 ${frame.width} ${frame.height}`
  let zoom = 1
  let vx = 0
  let vy = 0
  let vw = frame.width
  let vh = frame.height
  if (box) {
    zoom = Math.min((box.w - PAD * 2) / frame.width, (box.h - PAD * 2) / frame.height)
    vw = box.w / zoom
    vh = box.h / zoom
    vx = frame.width / 2 - vw / 2
    vy = frame.height / 2 - vh / 2
    viewBox = `${vx} ${vy} ${vw} ${vh}`
  }

  const toFrame = (clientX: number, clientY: number): Point => {
    const ctm = svgRef.current?.getScreenCTM()
    if (!ctm) return { x: 0, y: 0 }
    const p = new DOMPoint(clientX, clientY).matrixTransform(ctm.inverse())
    return { x: p.x, y: p.y }
  }

  const selSet = new Set(selected)
  const selObjs = comp.objects.filter((o) => selSet.has(o.id))
  const selBounds = selObjs.length ? bounds(selObjs.flatMap((o) => corners(o, sizeOf(comp, o)))) : null
  const single = selObjs.length === 1 ? selObjs[0]! : null

  function startGesture(g: Gesture) {
    setGesture(g.kind)
    const store = useComposition.getState()
    const activate = () => {
      if (g.active) return
      g.active = true
      if (g.kind !== 'marquee') store.beginGesture()
    }
    const onMove = (ev: PointerEvent) => {
      if (ev.buttons === 0) return finish()
      const p = toFrame(ev.clientX, ev.clientY)
      if (g.kind === 'move') {
        if (!g.active && Math.hypot(ev.clientX - g.startClient.x, ev.clientY - g.startClient.y) < 3) return
        activate()
        let dx = p.x - g.start.x
        let dy = p.y - g.start.y
        if (ev.shiftKey) {
          if (Math.abs(dx) > Math.abs(dy)) dy = 0
          else dx = 0
        }
        store.updateGesture(() => ({
          ...g.base,
          objects: g.base.objects.map((o) => (g.ids.has(o.id) ? { ...o, x: round2(o.x + dx), y: round2(o.y + dy) } : o)),
        }))
      } else if (g.kind === 'rotate') {
        activate()
        const angle = (Math.atan2(p.y - g.center.y, p.x - g.center.x) * 180) / Math.PI
        let delta = angle - g.startAngle
        if (ev.shiftKey) {
          // Шаг 15° — по итоговому углу одиночного объекта, иначе по приращению
          const base = g.ids.size === 1 ? (g.base.objects.find((o) => g.ids.has(o.id))?.rotation ?? 0) : 0
          delta = Math.round((base + delta) / 15) * 15 - base
        }
        store.updateGesture(() => rotateObjects(g.base, g.ids, normalizeAngle(delta), g.center))
      } else {
        if (!g.active && Math.hypot(ev.clientX - g.startClient.x, ev.clientY - g.startClient.y) < 3) return
        g.active = true
        const r = { x0: Math.min(g.start.x, p.x), y0: Math.min(g.start.y, p.y), x1: Math.max(g.start.x, p.x), y1: Math.max(g.start.y, p.y) }
        setMarquee(r)
        // Выделяются объекты, рамка которых пересекается с прямоугольником
        const { comp: c } = useComposition.getState()
        const hit = c.objects.filter((o) => {
          const b = bounds(corners(o, sizeOf(c, o)))
          return b.x0 < r.x1 && b.x1 > r.x0 && b.y0 < r.y1 && b.y1 > r.y0
        })
        const ids = hit.map((o) => o.id)
        useComposition.setState({ selected: expandGroups(c, [...(g.additive ? g.prev : []), ...ids]) })
      }
    }
    function finish() {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', finish)
      window.removeEventListener('pointercancel', finish)
      window.removeEventListener('blur', finish)
      setGesture(null)
      setMarquee(null)
      if (g.kind === 'marquee') {
        if (!g.active && !g.additive) store.select(null)
        return
      }
      if (!g.active) return
      // Сдвинутые вручную объекты больше не следуют за ячейками шаблона при смене формата
      if (g.kind === 'move' || g.ids.size > 1) {
        store.updateGesture((c) => (c.layout ? { ...c, layout: { ...c.layout, slots: Object.fromEntries(Object.entries(c.layout.slots).filter(([id]) => !g.ids.has(id))) } } : c))
      }
      store.endGesture()
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', finish)
    window.addEventListener('pointercancel', finish)
    window.addEventListener('blur', finish)
  }

  function onPointerDown(e: ReactPointerEvent<SVGSVGElement>) {
    if (e.button !== 0) return
    e.preventDefault()
    ;(document.activeElement as HTMLElement | null)?.blur?.()
    const target = e.target as Element
    const store = useComposition.getState()
    const p = toFrame(e.clientX, e.clientY)
    const startClient = { x: e.clientX, y: e.clientY }

    if (target.closest('[data-handle="rotate"]') && store.selected.length) {
      const ids = new Set(store.selected)
      const objs = store.comp.objects.filter((o) => ids.has(o.id))
      const b = bounds(objs.flatMap((o) => corners(o, sizeOf(store.comp, o))))
      const center = objs.length === 1 ? { x: objs[0]!.x + sizeOf(store.comp, objs[0]!).width / 2, y: objs[0]!.y + sizeOf(store.comp, objs[0]!).height / 2 } : { x: (b.x0 + b.x1) / 2, y: (b.y0 + b.y1) / 2 }
      const startAngle = (Math.atan2(p.y - center.y, p.x - center.x) * 180) / Math.PI
      startGesture({ kind: 'rotate', center, startAngle, base: store.comp, ids, active: false })
      return
    }

    const id = target.closest('[data-obj-id]')?.getAttribute('data-obj-id')
    if (id) {
      if (e.shiftKey) store.select(id, true)
      else if (!store.selected.includes(id)) store.select(id)
      const after = useComposition.getState()
      if (!after.selected.includes(id)) return // Shift снял выделение — тянуть нечего
      startGesture({ kind: 'move', start: p, startClient, base: after.comp, ids: new Set(after.selected), active: false })
      return
    }
    startGesture({ kind: 'marquee', start: p, startClient, additive: e.shiftKey, prev: store.selected, active: false })
  }

  function onContextMenu(e: ReactMouseEvent<SVGSVGElement>) {
    e.preventDefault()
    if (gesture) return
    const id = (e.target as Element).closest('[data-obj-id]')?.getAttribute('data-obj-id')
    if (!id) {
      closeContextMenu()
      return
    }
    if (!useComposition.getState().selected.includes(id)) useComposition.getState().select(id)
    openContextMenu(e.clientX, e.clientY, objectMenu(id))
  }

  function onDragOver(e: ReactDragEvent) {
    if (e.dataTransfer.types.includes(ITEM_MIME)) {
      e.preventDefault()
      e.dataTransfer.dropEffect = 'copy'
    }
  }
  function onDrop(e: ReactDragEvent) {
    const itemId = e.dataTransfer.getData(ITEM_MIME)
    if (!itemId) return
    e.preventDefault()
    useComposition.getState().addItem(itemId, toFrame(e.clientX, e.clientY))
  }

  const outside = `M${vx - 10} ${vy - 10}h${vw + 20}v${vh + 20}h${-vw - 20}Z M0 0h${frame.width}v${frame.height}h${-frame.width}Z`
  const rotHandle = selBounds && (single ? topHandle(single, sizeOf(comp, single), 28 / zoom) : { x: (selBounds.x0 + selBounds.x1) / 2, y: selBounds.y0 - 28 / zoom })

  return (
    <div
      ref={containerRef}
      className="relative h-full w-full overflow-hidden bg-workspace"
      onDragOver={onDragOver}
      onDrop={onDrop}
      data-testid="compose-canvas"
    >
      {box && (
        <svg
          ref={svgRef}
          width={box.w}
          height={box.h}
          viewBox={viewBox}
          className="block touch-none select-none"
          style={{ cursor: gesture === 'move' ? 'move' : gesture === 'rotate' ? 'grabbing' : undefined }}
          onPointerDown={onPointerDown}
          onContextMenu={onContextMenu}
        >
          <defs>
            <clipPath id="compose-frame">
              <rect width={frame.width} height={frame.height} />
            </clipPath>
          </defs>
          <g clipPath="url(#compose-frame)" style={{ filter: 'drop-shadow(0 1px 3px rgb(0 0 0 / 0.14))' }}>
            <Markup markup={background} />
          </g>
          {resolved.map((r) => (
            <g key={r.obj.id} data-obj-id={r.obj.id} transform={objectTransform(r.obj, r.asset)} style={{ cursor: 'move' }}>
              <Markup markup={r.markup} />
            </g>
          ))}
          <path d={outside} fill="#eceef3" fillOpacity={0.8} fillRule="evenodd" pointerEvents="none" />
          <rect width={frame.width} height={frame.height} fill="none" stroke="#cfd3dd" strokeWidth={1} vectorEffect="non-scaling-stroke" pointerEvents="none" />
          {selObjs.map((o) => (
            <polygon
              key={o.id}
              points={corners(o, sizeOf(comp, o)).map((p) => `${p.x},${p.y}`).join(' ')}
              fill="none"
              stroke="#6c63ff"
              strokeWidth={1.5}
              strokeDasharray={selObjs.length > 1 ? '5 4' : undefined}
              vectorEffect="non-scaling-stroke"
              pointerEvents="none"
            />
          ))}
          {selBounds && selObjs.length > 1 && (
            <rect
              x={selBounds.x0}
              y={selBounds.y0}
              width={selBounds.x1 - selBounds.x0}
              height={selBounds.y1 - selBounds.y0}
              fill="none"
              stroke="#6c63ff"
              strokeWidth={1.5}
              vectorEffect="non-scaling-stroke"
              pointerEvents="none"
            />
          )}
          {rotHandle && gesture !== 'move' && (
            <g data-handle="rotate" style={{ cursor: 'grab' }} data-testid="rotate-handle">
              <circle cx={rotHandle.x} cy={rotHandle.y} r={11 / zoom} fill="transparent" />
              <circle cx={rotHandle.x} cy={rotHandle.y} r={6 / zoom} fill="#fff" stroke="#6c63ff" strokeWidth={1.5} vectorEffect="non-scaling-stroke" />
              <path
                d={`M${rotHandle.x - 2.5 / zoom} ${rotHandle.y - 1 / zoom}a${2.6 / zoom} ${2.6 / zoom} 0 1 1 ${0.6 / zoom} ${2.4 / zoom}`}
                fill="none"
                stroke="#6c63ff"
                strokeWidth={1.2}
                vectorEffect="non-scaling-stroke"
              />
            </g>
          )}
          {marquee && (
            <rect
              x={marquee.x0}
              y={marquee.y0}
              width={marquee.x1 - marquee.x0}
              height={marquee.y1 - marquee.y0}
              fill="#6c63ff"
              fillOpacity={0.08}
              stroke="#6c63ff"
              strokeWidth={1}
              vectorEffect="non-scaling-stroke"
              pointerEvents="none"
            />
          )}
        </svg>
      )}
      {comp.objects.length === 0 && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center p-6">
          <div className="max-w-sm rounded-xl bg-white/90 px-5 py-4 text-center text-sm leading-relaxed text-muted shadow-sm">
            Опишите метафору или перечислите объекты слева и нажмите «Собрать». Объекты из набора можно и перетащить сюда.
          </div>
        </div>
      )}
    </div>
  )
}

/** Ручка поворота над верхней серединой рамки одиночного объекта (с учетом его поворота) */
function topHandle(o: CObject, s: { width: number; height: number }, offset: number): Point {
  const r = (o.rotation * Math.PI) / 180
  const dy = -s.height / 2 - offset
  return { x: o.x + s.width / 2 - dy * Math.sin(r), y: o.y + s.height / 2 + dy * Math.cos(r) }
}

