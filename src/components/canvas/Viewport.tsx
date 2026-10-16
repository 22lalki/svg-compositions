import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent as ReactDragEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react'
import type { Component, Point, Scene, SceneObject } from '../../types'
import { sharedDefs } from '../../lib/exportSvg'
import { framePoint, normalizeAngle, objectFrame, objectTransform, rotateVec } from '../../lib/transform'
import { useComponentMap } from '../../store/library'
import { useScene } from '../../store/scene'
import { isTypingTarget } from '../../lib/dom'
import { isDialogOpen } from '../../store/confirm'
import { COMPONENT_MIME } from '../../lib/componentPreview'
import { svgNodes } from '../../lib/markup'
import { Icon } from '../Icon'
import { closeContextMenu, openContextMenu } from '../../store/contextMenu'
import { objectMenuItems } from './objectMenu'

type View = { zoom: number; cx: number; cy: number }

const MIN_SCALE = 0.02
const MIN_ZOOM = 0.05
const MAX_ZOOM = 16
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))
const round = (v: number, digits: number) => Number(v.toFixed(digits))

/** Вид переживает переключение в режим выделения и обратно */
let rememberedView: { view: View; artboard: string } | null = null

type Gesture =
  | { kind: 'move'; id: string; start: Point; startClient: Point; orig: SceneObject; active: boolean }
  | { kind: 'scale'; id: string; sx: number; sy: number; start: Point; orig: SceneObject; size: Component; active: boolean }
  | { kind: 'rotate'; id: string; startAngle: number; orig: SceneObject; size: Component; active: boolean }
  | { kind: 'pan'; startClient: Point; orig: View; deselect: boolean; active: boolean }

const patchObject = (id: string, patch: Partial<SceneObject>) => (s: Scene): Scene => ({
  ...s,
  objects: s.objects.map((o) => (o.id === id ? { ...o, ...patch } : o)),
})

export function Viewport() {
  const scene = useScene((s) => s.scene)
  const selectedId = useScene((s) => s.selectedId)
  const components = useComponentMap()

  const containerRef = useRef<HTMLDivElement>(null)
  const svgRef = useRef<SVGSVGElement>(null)
  const [size, setSize] = useState<{ w: number; h: number } | null>(null)
  const artboardKey = `${scene.width}x${scene.height}`
  const [view, setView] = useState<View | null>(() =>
    rememberedView?.artboard === artboardKey ? rememberedView.view : null,
  )
  const [spaceDown, setSpaceDown] = useState(false)
  const [gestureKind, setGestureKind] = useState<Gesture['kind'] | null>(null)

  useEffect(() => {
    if (view) rememberedView = { view, artboard: artboardKey }
  }, [view, artboardKey])

  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const ro = new ResizeObserver(([entry]) => {
      if (entry) setSize({ w: entry.contentRect.width, h: entry.contentRect.height })
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const fitView = useCallback(() => {
    if (!size) return
    const pad = 40
    const zoom = clamp(Math.min((size.w - pad * 2) / scene.width, (size.h - pad * 2) / scene.height), MIN_ZOOM, MAX_ZOOM)
    setView({ zoom, cx: scene.width / 2, cy: scene.height / 2 })
  }, [size, scene.width, scene.height])

  // Вписать при первом показе и при смене размера артборда
  const fittedFor = useRef<string | null>(view ? artboardKey : null)
  useEffect(() => {
    if (!size || fittedFor.current === artboardKey) return
    fittedFor.current = artboardKey
    fitView()
  }, [size, artboardKey, fitView])

  const viewRef = useRef(view)
  viewRef.current = view

  const toArtboard = useCallback((clientX: number, clientY: number): Point => {
    const ctm = svgRef.current?.getScreenCTM()
    if (!ctm) return { x: 0, y: 0 }
    const p = new DOMPoint(clientX, clientY).matrixTransform(ctm.inverse())
    return { x: p.x, y: p.y }
  }, [])

  // Колесо: прокрутка двигает, Ctrl/⌘ (и щипок тачпада) масштабирует к курсору
  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const onWheel = (e: WheelEvent) => {
      const v = viewRef.current
      if (!v) return
      e.preventDefault()
      if (e.ctrlKey || e.metaKey) {
        const p = toArtboard(e.clientX, e.clientY)
        const zoom = clamp(v.zoom * Math.exp(-e.deltaY * (e.deltaMode === 1 ? 0.05 : 0.0025)), MIN_ZOOM, MAX_ZOOM)
        const k = v.zoom / zoom
        setView({ zoom, cx: p.x + (v.cx - p.x) * k, cy: p.y + (v.cy - p.y) * k })
      } else {
        const unit = e.deltaMode === 1 ? 16 : 1
        const dx = (e.shiftKey && !e.deltaX ? e.deltaY : e.deltaX) * unit
        const dy = (e.shiftKey && !e.deltaX ? 0 : e.deltaY) * unit
        setView({ ...v, cx: v.cx + dx / v.zoom, cy: v.cy + dy / v.zoom })
      }
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [toArtboard])

  // Пробел — временная рука
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      const control = e.target instanceof Element && e.target.closest('button, a[href], select, [role="button"], [role="menuitem"]')
      if (e.code === 'Space' && !isTypingTarget(e.target) && !control && !isDialogOpen()) {
        e.preventDefault()
        setSpaceDown(true)
      }
    }
    const up = (e: KeyboardEvent) => e.code === 'Space' && setSpaceDown(false)
    const blur = () => setSpaceDown(false)
    window.addEventListener('keydown', down)
    window.addEventListener('keyup', up)
    window.addEventListener('blur', blur)
    return () => {
      window.removeEventListener('keydown', down)
      window.removeEventListener('keyup', up)
      window.removeEventListener('blur', blur)
    }
  }, [])

  function startGesture(g: Gesture) {
    setGestureKind(g.kind)
    const store = useScene.getState()

    const activate = () => {
      if (g.active) return
      g.active = true
      if (g.kind !== 'pan') store.beginGesture()
    }

    const onMove = (ev: PointerEvent) => {
      if (ev.buttons === 0) {
        finish()
        return
      }
      const p = toArtboard(ev.clientX, ev.clientY)
      switch (g.kind) {
        case 'pan': {
          const dx = ev.clientX - g.startClient.x
          const dy = ev.clientY - g.startClient.y
          if (!g.active && Math.hypot(dx, dy) < 3) return
          activate()
          setView({ ...g.orig, cx: g.orig.cx - dx / g.orig.zoom, cy: g.orig.cy - dy / g.orig.zoom })
          return
        }
        case 'move': {
          if (!g.active && Math.hypot(ev.clientX - g.startClient.x, ev.clientY - g.startClient.y) < 3) return
          activate()
          let dx = p.x - g.start.x
          let dy = p.y - g.start.y
          if (ev.shiftKey) {
            if (Math.abs(dx) > Math.abs(dy)) dy = 0
            else dx = 0
          }
          store.updateGesture(patchObject(g.id, { x: round(g.orig.x + dx, 2), y: round(g.orig.y + dy, 2) }))
          return
        }
        case 'scale': {
          activate()
          const o = g.orig
          const f = objectFrame(o, g.size)
          // Курсор в системе координат объекта: поворот снят, масштаб — от центра. Считаем относительно точки,
          // где ручку взяли (обычно в паре пикселей от угла), иначе объект прыгает на первом же движении
          const toLocal = (q: Point) => rotateVec({ x: q.x - f.center.x, y: q.y - f.center.y }, -o.rotation)
          const local = toLocal(p)
          const local0 = toLocal(g.start)
          const ratio = (now: number, then: number, fallback: number) => (Math.abs(then) > 1e-6 ? now / then : fallback)
          let scale: number
          let scaleY: number
          if (ev.shiftKey) {
            scale = Math.max(MIN_SCALE, o.scale * ratio(local.x * g.sx, local0.x * g.sx, (local.x * g.sx) / (g.size.width / 2) / o.scale))
            scaleY = Math.max(MIN_SCALE, o.scaleY * ratio(local.y * g.sy, local0.y * g.sy, (local.y * g.sy) / (g.size.height / 2) / o.scaleY))
          } else {
            const d = { x: g.sx * f.hw, y: g.sy * f.hh }
            const proj = (v: Point) => (v.x * d.x + v.y * d.y) / (d.x * d.x + d.y * d.y)
            const k0 = proj(local0)
            const k = Math.max(k0 > 0.2 ? proj(local) / k0 : proj(local), MIN_SCALE / Math.min(o.scale, o.scaleY))
            scale = o.scale * k
            scaleY = o.scaleY * k
          }
          store.updateGesture(patchObject(g.id, { scale: round(scale, 4), scaleY: round(scaleY, 4) }))
          return
        }
        case 'rotate': {
          activate()
          const c = objectFrame(g.orig, g.size).center
          const angle = (Math.atan2(p.y - c.y, p.x - c.x) * 180) / Math.PI
          let r = g.orig.rotation + angle - g.startAngle
          if (ev.shiftKey) r = Math.round(r / 15) * 15
          store.updateGesture(patchObject(g.id, { rotation: normalizeAngle(round(r, 2)) }))
          return
        }
      }
    }

    function finish() {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', finish)
      window.removeEventListener('pointercancel', finish)
      window.removeEventListener('blur', finish)
      setGestureKind(null)
      if (g.kind === 'pan') {
        if (!g.active && g.deselect) store.select(null)
      } else if (g.active) {
        store.endGesture()
      }
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', finish)
    window.addEventListener('pointercancel', finish)
    window.addEventListener('blur', finish)
  }

  function onPointerDown(e: ReactPointerEvent<SVGSVGElement>) {
    const v = viewRef.current
    if (!v) return
    const target = e.target as Element
    const startClient = { x: e.clientX, y: e.clientY }
    if (e.button === 1 || (e.button === 0 && spaceDown)) {
      e.preventDefault()
      startGesture({ kind: 'pan', startClient, orig: v, deselect: false, active: false })
      return
    }
    if (e.button !== 0) return
    e.preventDefault()
    ;(document.activeElement as HTMLElement | null)?.blur?.()

    const { scene: s, selectedId: sel, select } = useScene.getState()
    const handle = target.closest('[data-handle]')?.getAttribute('data-handle')
    const selectedObj = s.objects.find((o) => o.id === sel)
    const selectedComp = selectedObj && components.get(selectedObj.componentId)
    if (handle && selectedObj && selectedComp) {
      if (handle === 'rotate') {
        const c = objectFrame(selectedObj, selectedComp).center
        const p = toArtboard(e.clientX, e.clientY)
        const startAngle = (Math.atan2(p.y - c.y, p.x - c.x) * 180) / Math.PI
        startGesture({ kind: 'rotate', id: selectedObj.id, startAngle, orig: selectedObj, size: selectedComp, active: false })
      } else {
        const [, sx, sy] = handle.split(':').map(Number)
        const start = toArtboard(e.clientX, e.clientY)
        startGesture({ kind: 'scale', id: selectedObj.id, sx: sx!, sy: sy!, start, orig: selectedObj, size: selectedComp, active: false })
      }
      return
    }

    const objId = target.closest('[data-obj-id]')?.getAttribute('data-obj-id')
    const obj = objId ? s.objects.find((o) => o.id === objId) : undefined
    if (obj) {
      select(obj.id)
      startGesture({ kind: 'move', id: obj.id, start: toArtboard(e.clientX, e.clientY), startClient, orig: obj, active: false })
      return
    }
    startGesture({ kind: 'pan', startClient, orig: v, deselect: true, active: false })
  }

  /** ПКМ по объекту (или по ручкам выделенного): выбрать его и открыть меню у курсора */
  function onContextMenu(e: ReactMouseEvent<SVGSVGElement>) {
    e.preventDefault()
    if (gestureKind) return
    const target = e.target as Element
    const { scene: s, selectedId: sel, select } = useScene.getState()
    const id = target.closest('[data-handle]') ? sel : target.closest('[data-obj-id]')?.getAttribute('data-obj-id')
    if (!id || !s.objects.some((o) => o.id === id)) {
      closeContextMenu()
      return
    }
    select(id)
    openContextMenu(e.clientX, e.clientY, objectMenuItems(id))
  }

  function onDragOver(e: ReactDragEvent) {
    if (e.dataTransfer.types.includes(COMPONENT_MIME)) {
      e.preventDefault()
      e.dataTransfer.dropEffect = 'copy'
    }
  }

  function onDrop(e: ReactDragEvent) {
    const id = e.dataTransfer.getData(COMPONENT_MIME)
    const comp = id ? components.get(id) : undefined
    if (!comp) return
    e.preventDefault()
    useScene.getState().addObject(comp, toArtboard(e.clientX, e.clientY))
  }

  const defs = useMemo(() => sharedDefs(scene, components), [scene, components])
  const selected = scene.objects.find((o) => o.id === selectedId)
  const selectedComp = selected ? components.get(selected.componentId) : undefined

  let viewBox = '0 0 1 1'
  let outside = ''
  if (size && view) {
    const vw = size.w / view.zoom
    const vh = size.h / view.zoom
    const vx = view.cx - vw / 2
    const vy = view.cy - vh / 2
    viewBox = `${vx} ${vy} ${vw} ${vh}`
    // Все, что вне артборда, приглушено: в экспорт оно не попадет
    outside = `M${vx - 10} ${vy - 10}h${vw + 20}v${vh + 20}h${-vw - 20}Z M0 0h${scene.width}v${scene.height}h${-scene.width}Z`
  }

  const cursor = gestureKind === 'pan' && spaceDown ? 'grabbing' : spaceDown ? 'grab' : gestureKind === 'move' ? 'move' : undefined

  return (
    <div
      ref={containerRef}
      className="relative h-full w-full overflow-hidden bg-workspace"
      onDragOver={onDragOver}
      onDrop={onDrop}
      data-testid="canvas"
      data-selected={selectedId ?? ''}
    >
      {size && view && (
        <svg
          ref={svgRef}
          width={size.w}
          height={size.h}
          viewBox={viewBox}
          className="block touch-none select-none"
          style={{ cursor }}
          onPointerDown={onPointerDown}
          onContextMenu={onContextMenu}
        >
          <SvgMarkup markup={defs} defs />
          <rect
            data-artboard=""
            width={scene.width}
            height={scene.height}
            fill="#ffffff"
            style={{ filter: 'drop-shadow(0 1px 3px rgb(0 0 0 / 0.14))' }}
          />
          {/* color: как в отдельном SVG (экспорт, превью) — currentColor черный, а не цвет текста интерфейса */}
          <g color="#000">
            {scene.objects.map((o) => {
              const c = components.get(o.componentId)
              return c ? <ObjectView key={o.id} obj={o} comp={c} interactive={!spaceDown} /> : null
            })}
          </g>
          <path d={outside} fill="#eceef3" fillOpacity={0.78} fillRule="evenodd" pointerEvents="none" />
          <rect
            width={scene.width}
            height={scene.height}
            fill="none"
            stroke="#cfd3dd"
            strokeWidth={1}
            vectorEffect="non-scaling-stroke"
            pointerEvents="none"
          />
          {selected && selectedComp && (
            <SelectionFrame obj={selected} comp={selectedComp} zoom={view.zoom} hideHandles={gestureKind === 'move'} />
          )}
        </svg>
      )}

      {scene.objects.length === 0 && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <div className="max-w-xs rounded-xl bg-white/90 px-5 py-4 text-center text-sm leading-relaxed text-muted shadow-sm">
            Холст пуст. Добавьте компоненты из библиотеки справа: кликом или перетаскиванием.
          </div>
        </div>
      )}

      {view && (
        <div className="absolute right-3 bottom-3 flex items-center gap-0.5 rounded-lg border border-line bg-white p-0.5 shadow-sm">
          <button
            type="button"
            className="rounded-md p-1.5 hover:bg-accent-soft"
            title="Уменьшить"
            onClick={() => setView({ ...view, zoom: clamp(view.zoom / 1.25, MIN_ZOOM, MAX_ZOOM) })}
          >
            <Icon name="minus" size={14} />
          </button>
          <span className="w-11 text-center text-xs tabular-nums">{Math.round(view.zoom * 100)}%</span>
          <button
            type="button"
            className="rounded-md p-1.5 hover:bg-accent-soft"
            title="Увеличить"
            onClick={() => setView({ ...view, zoom: clamp(view.zoom * 1.25, MIN_ZOOM, MAX_ZOOM) })}
          >
            <Icon name="plus" size={14} />
          </button>
          <button type="button" className="rounded-md p-1.5 hover:bg-accent-soft" title="Вписать артборд" onClick={fitView}>
            <Icon name="fit" size={14} />
          </button>
        </div>
      )}
    </div>
  )
}

const ObjectView = memo(function ObjectView({
  obj,
  comp,
  interactive,
}: {
  obj: SceneObject
  comp: Component
  interactive: boolean
}) {
  return (
    <g data-obj-id={obj.id} transform={objectTransform(obj, comp)} style={{ cursor: interactive ? 'move' : undefined }}>
      <SvgMarkup markup={comp.markup} />
    </g>
  )
})

/**
 * Разметка компонента вставляется готовыми узлами SVG (разбор XML + очистка, см. lib/markup.ts), а не через
 * innerHTML. Пересобирается только при смене разметки, не при перемещении
 */
const SvgMarkup = memo(function SvgMarkup({ markup, defs = false }: { markup: string; defs?: boolean }) {
  const ref = useRef<SVGGElement & SVGDefsElement>(null)
  useLayoutEffect(() => {
    ref.current?.replaceChildren(...svgNodes(markup))
  }, [markup])
  return defs ? <defs ref={ref} /> : <g ref={ref} />
})

const CORNERS: Array<[number, number]> = [
  [-1, -1],
  [1, -1],
  [1, 1],
  [-1, 1],
]
const RESIZE_CURSORS = ['ew-resize', 'nwse-resize', 'ns-resize', 'nesw-resize']

function resizeCursor(dirDeg: number) {
  const a = ((dirDeg % 180) + 180) % 180
  return RESIZE_CURSORS[Math.round(a / 45) % 4]
}

function SelectionFrame({
  obj,
  comp,
  zoom,
  hideHandles,
}: {
  obj: SceneObject
  comp: Component
  zoom: number
  hideHandles: boolean
}) {
  const f = objectFrame(obj, comp)
  const corners = CORNERS.map(([sx, sy]) => framePoint(f, sx, sy))
  const topMid = framePoint(f, 0, -1)
  const rotHandle = framePoint(f, 0, -1, -26 / zoom)
  const hs = 9 / zoom
  const hit = 18 / zoom
  return (
    <g data-selection-frame="">
      <polygon
        points={corners.map((p) => `${p.x},${p.y}`).join(' ')}
        fill="none"
        stroke="#6c63ff"
        strokeWidth={1.5}
        vectorEffect="non-scaling-stroke"
        pointerEvents="none"
      />
      {!hideHandles && (
        <>
          <line
            x1={topMid.x}
            y1={topMid.y}
            x2={rotHandle.x}
            y2={rotHandle.y}
            stroke="#6c63ff"
            strokeWidth={1.5}
            vectorEffect="non-scaling-stroke"
            pointerEvents="none"
          />
          <g data-handle="rotate" style={{ cursor: 'grab' }}>
            <circle cx={rotHandle.x} cy={rotHandle.y} r={hit / 2} fill="transparent" />
            <circle
              cx={rotHandle.x}
              cy={rotHandle.y}
              r={5.5 / zoom}
              fill="#fff"
              stroke="#6c63ff"
              strokeWidth={1.5}
              vectorEffect="non-scaling-stroke"
            />
          </g>
          {CORNERS.map(([sx, sy], i) => {
            const p = corners[i]!
            const dir = f.rotation + (Math.atan2(sy * f.hh, sx * f.hw) * 180) / Math.PI
            return (
              <g
                key={i}
                data-handle={`scale:${sx}:${sy}`}
                transform={`translate(${p.x} ${p.y}) rotate(${f.rotation})`}
                style={{ cursor: resizeCursor(dir) }}
              >
                <rect x={-hit / 2} y={-hit / 2} width={hit} height={hit} fill="transparent" />
                <rect
                  x={-hs / 2}
                  y={-hs / 2}
                  width={hs}
                  height={hs}
                  fill="#fff"
                  stroke="#6c63ff"
                  strokeWidth={1.5}
                  vectorEffect="non-scaling-stroke"
                />
              </g>
            )
          })}
        </>
      )}
    </g>
  )
}
