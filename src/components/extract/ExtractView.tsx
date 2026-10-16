import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react'
import type { Component, Point, Rect } from '../../types'
import {
  analyzeSource,
  expandToParentGroup,
  extractComponent,
  selectionBounds,
  shapesInRect,
  type SourceModel,
} from '../../lib/extract'
import { shortId } from '../../lib/ids'
import { standaloneSvg, svgDataUrl } from '../../lib/svg'
import { sanitizeSvg } from '../../lib/importSvg'
import { loadSourceText } from '../../lib/sources'
import { useLibrary } from '../../store/library'
import { notify, useUi } from '../../store/ui'
import { Icon } from '../Icon'
import { Button, Divider, IconButton } from '../ui'
import { isTypingTarget } from '../../lib/dom'
import { isDialogOpen } from '../../store/confirm'
import { mod, openContextMenu, type MenuItem } from '../../store/contextMenu'

type MarqueeMode = 'replace' | 'add' | 'subtract'
const ZOOMS = [1, 1.5, 2, 3, 4, 6, 8]

const rectFrom = (a: Point, b: Point): Rect => ({
  x: Math.min(a.x, b.x),
  y: Math.min(a.y, b.y),
  width: Math.abs(a.x - b.x),
  height: Math.abs(a.y - b.y),
})

const marqueeMode = (e: { shiftKey: boolean; altKey: boolean }): MarqueeMode =>
  e.altKey ? 'subtract' : e.shiftKey ? 'add' : 'replace'

export function ExtractView({ sourceId }: { sourceId: string }) {
  const meta = useUi((s) => s.sources.find((x) => x.id === sourceId))
  const closeSource = useUi((s) => s.closeSource)
  const fromThisSource = useLibrary((s) => s.components.filter((c) => c.sourceId === sourceId).length)

  const stageRef = useRef<HTMLDivElement>(null)
  const hostRef = useRef<HTMLDivElement>(null)
  const [model, setModel] = useState<SourceModel | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [selected, setSelected] = useState<ReadonlySet<number>>(() => new Set())
  const [hover, setHover] = useState<number | null>(null)
  /** Фигура, по которой открыто контекстное меню (подсвечена, пока меню открыто) */
  const [menuShape, setMenuShape] = useState<number | null>(null)
  const [marquee, setMarquee] = useState<{ rect: Rect; mode: MarqueeMode } | null>(null)
  const [zoom, setZoom] = useState(1)
  const [stage, setStage] = useState({ w: 0, h: 0 })
  const [name, setName] = useState('')

  // Загрузка исходника инлайном: нужны клики, getBBox и вычисленные стили.
  // Перезагружаем только при смене исходника (переименование не сбрасывает выделение)
  const metaRef = useRef(meta)
  metaRef.current = meta
  const loadedId = meta?.id
  useEffect(() => {
    const meta = metaRef.current
    if (!meta) return
    let cancelled = false
    setModel(null)
    setError(null)
    loadSourceText(meta)
      .then((text) => {
        if (cancelled || !hostRef.current) return
        const doc = new DOMParser().parseFromString(text, 'image/svg+xml')
        const root = doc.documentElement
        if (root.localName !== 'svg' || doc.querySelector('parsererror')) throw new Error('файл не является SVG')
        // Загруженные файлы очищены при импорте, встроенные — свои; чистим еще раз на всякий случай
        sanitizeSvg(root)
        const svg = document.importNode(root, true) as unknown as SVGSVGElement
        if (!svg.hasAttribute('viewBox')) {
          svg.setAttribute('viewBox', `0 0 ${parseFloat(svg.getAttribute('width') ?? '0')} ${parseFloat(svg.getAttribute('height') ?? '0')}`)
        }
        svg.removeAttribute('width')
        svg.removeAttribute('height')
        svg.setAttribute('preserveAspectRatio', 'xMidYMid meet')
        svg.setAttribute('data-source-svg', meta.id)
        svg.style.cssText = 'display:block;width:100%;height:100%;overflow:visible'
        hostRef.current.replaceChildren(svg)
        setModel(analyzeSource(svg, meta))
      })
      .catch((e: unknown) => !cancelled && setError(e instanceof Error ? e.message : String(e)))
    return () => {
      cancelled = true
    }
  }, [loadedId])

  useEffect(() => {
    const el = stageRef.current
    if (!el) return
    const ro = new ResizeObserver(([entry]) => {
      if (entry) setStage({ w: entry.contentRect.width, h: entry.contentRect.height })
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const vb = model?.viewBox ?? { x: 0, y: 0, width: 4, height: 3 }
  const fit = stage.w > 0 ? Math.max(0.05, Math.min((stage.w - 48) / vb.width, (stage.h - 48) / vb.height)) : 0
  const display = { w: vb.width * fit * zoom, h: vb.height * fit * zoom }

  const preview = useMemo(
    () => (model && selected.size > 0 ? extractComponent(model, selected, 'preview-') : null),
    [model, selected],
  )
  const previewUrl = useMemo(() => (preview ? svgDataUrl(standaloneSvg(preview)) : null), [preview])
  const bounds = useMemo(() => (model ? selectionBounds(model, selected) : null), [model, selected])

  function toRoot(clientX: number, clientY: number): Point {
    const ctm = model?.svg.getScreenCTM()
    if (!ctm) return { x: 0, y: 0 }
    const p = new DOMPoint(clientX, clientY).matrixTransform(ctm.inverse())
    return { x: p.x, y: p.y }
  }

  const shapeAt = (target: EventTarget | null) =>
    model && target instanceof Element ? model.shapeIndex.get(target) : undefined

  function selectAll() {
    if (model) setSelected(new Set(model.shapes.map((s) => s.index)))
  }

  function expand() {
    if (!model) return
    const next = expandToParentGroup(model, selected)
    if (next) setSelected(next)
    else
      notify(
        selected.size ? 'Выше только корневая обертка — добавьте фигуры рамкой' : 'Сначала выделите фигуру',
      )
  }

  function save() {
    if (!model || !meta || selected.size === 0) return
    const id = shortId()
    const result = extractComponent(model, selected, `c${id}-`)
    if (!result) return
    const component: Component = {
      id,
      name: name.trim() || `${meta.title} — фрагмент ${fromThisSource + 1}`,
      sourceId: meta.id,
      width: result.width,
      height: result.height,
      defs: result.defs,
      markup: result.markup,
      createdAt: Date.now(),
    }
    useLibrary.getState().add(component)
    notify(`«${component.name}» сохранен в библиотеку`)
    setSelected(new Set())
    setName('')
  }

  function onPointerDown(e: ReactPointerEvent<HTMLDivElement>) {
    if (e.button !== 0 || !model) return
    e.preventDefault()
    ;(document.activeElement as HTMLElement | null)?.blur?.()
    const start = toRoot(e.clientX, e.clientY)
    const startClient = { x: e.clientX, y: e.clientY }
    const hit = shapeAt(e.target)
    const downMods = { shiftKey: e.shiftKey, altKey: e.altKey }
    let dragging = false

    const mods = (ev: PointerEvent) => ({
      shiftKey: ev.shiftKey || downMods.shiftKey,
      altKey: ev.altKey || downMods.altKey,
    })
    const onMove = (ev: PointerEvent) => {
      if (!dragging && Math.hypot(ev.clientX - startClient.x, ev.clientY - startClient.y) < 4) return
      dragging = true
      setHover(null)
      setMarquee({ rect: rectFrom(start, toRoot(ev.clientX, ev.clientY)), mode: marqueeMode(mods(ev)) })
    }
    const finish = (ev: PointerEvent, cancelled = false) => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onCancel)
      setMarquee(null)
      if (cancelled) return
      const m = mods(ev)
      if (dragging) {
        const inside = shapesInRect(model, rectFrom(start, toRoot(ev.clientX, ev.clientY)))
        const mode = marqueeMode(m)
        setSelected((prev) => {
          if (mode === 'subtract') {
            const next = new Set(prev)
            inside.forEach((i) => next.delete(i))
            return next
          }
          return mode === 'add' ? new Set([...prev, ...inside]) : new Set(inside)
        })
      } else if (hit === undefined) {
        if (!m.shiftKey) setSelected(new Set())
      } else if (m.shiftKey) {
        setSelected((prev) => {
          const next = new Set(prev)
          if (next.has(hit)) next.delete(hit)
          else next.add(hit)
          return next
        })
      } else {
        setSelected(new Set([hit]))
      }
    }
    const onUp = (ev: PointerEvent) => finish(ev)
    const onCancel = (ev: PointerEvent) => finish(ev, true)
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onCancel)
  }

  /** ПКМ: действия с фигурой под курсором и с выделением целиком */
  function onContextMenu(e: ReactMouseEvent<HTMLDivElement>) {
    e.preventDefault()
    if (!model) return
    const hit = shapeAt(e.target)
    const items: MenuItem[] = []
    if (hit !== undefined) {
      const isSelected = selected.has(hit)
      const group = expandToParentGroup(model, new Set([hit]))
      if (isSelected) {
        items.push({
          label: 'Исключить из выделения',
          icon: 'minus',
          shortcut: 'Shift+клик',
          onSelect: () =>
            setSelected((prev) => {
              const next = new Set(prev)
              next.delete(hit)
              return next
            }),
        })
      } else if (selected.size) {
        items.push({
          label: 'Добавить к выделению',
          icon: 'plus',
          shortcut: 'Shift+клик',
          onSelect: () => setSelected((prev) => new Set([...prev, hit])),
        })
      }
      items.push(
        {
          label: selected.size ? 'Выделить только эту фигуру' : 'Выделить фигуру',
          icon: 'pointer',
          disabled: isSelected && selected.size === 1,
          onSelect: () => setSelected(new Set([hit])),
        },
        {
          label: group ? `Выделить ее группу (${group.size})` : 'Выделить ее группу',
          icon: 'parent',
          disabled: !group,
          onSelect: () => group && setSelected(group),
        },
        'separator',
      )
    }
    const all = model.shapes.length
    const expanded = selected.size ? expandToParentGroup(model, selected) : null
    items.push(
      { label: 'Выделить все', icon: 'selectAll', shortcut: mod('A'), disabled: selected.size === all, onSelect: selectAll },
      {
        label: 'Инвертировать выделение',
        icon: 'invert',
        disabled: !selected.size || selected.size === all,
        onSelect: () => setSelected((prev) => new Set(model.shapes.map((x) => x.index).filter((i) => !prev.has(i)))),
      },
      {
        label: 'Расширить до группы',
        icon: 'parent',
        shortcut: '↑',
        disabled: !expanded,
        onSelect: () => expanded && setSelected(expanded),
      },
      { label: 'Снять выделение', icon: 'x', shortcut: 'Esc', disabled: !selected.size, onSelect: () => setSelected(new Set()) },
      'separator',
      { label: 'Сохранить в библиотеку', icon: 'save', shortcut: 'Enter', disabled: !selected.size, onSelect: save },
    )
    setHover(null)
    setMenuShape(hit ?? null)
    openContextMenu(e.clientX, e.clientY, items, { onClose: () => setMenuShape(null) })
  }

  function onHover(e: ReactPointerEvent<HTMLDivElement>) {
    if (e.buttons !== 0) return
    const i = shapeAt(e.target) ?? null
    if (i !== hover) setHover(i)
  }

  // Клавиатура режима выделения
  const actions = useRef({ expand, selectAll, save, closeSource, selected })
  actions.current = { expand, selectAll, save, closeSource, selected }
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isDialogOpen()) return
      if (e.key === 'Alt') e.preventDefault() // иначе Alt фокусирует меню браузера
      if (isTypingTarget(e.target)) return
      const a = actions.current
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        a.expand()
      } else if ((e.ctrlKey || e.metaKey) && e.code === 'KeyA') {
        e.preventDefault()
        a.selectAll()
      } else if (e.key === 'Escape') {
        if (a.selected.size) setSelected(new Set())
        else a.closeSource()
      } else if (e.key === 'Enter' && a.selected.size && !(e.target instanceof HTMLButtonElement)) {
        a.save()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  if (!meta) return null
  const zoomIndex = ZOOMS.indexOf(zoom)
  const highlight = menuShape ?? hover
  const hoverShape = highlight !== null && (menuShape !== null || !selected.has(highlight)) ? model?.shapes[highlight] : undefined
  const marqueeColor = marquee?.mode === 'subtract' ? '#e11d48' : marquee?.mode === 'add' ? '#059669' : '#6c63ff'

  return (
    <div className="flex h-full flex-col">
      <div className="flex h-12 shrink-0 items-center gap-1 border-b border-line bg-panel px-2">
        <Button variant="ghost" onClick={closeSource} title="Вернуться к холсту (Esc)">
          <Icon name="arrowLeft" /> Холст
        </Button>
        <Divider />
        <div className="min-w-0 px-2">
          <div className="truncate text-sm font-semibold">
            <span className="text-accent">{meta.kind === 'builtin' ? meta.id : 'Мой SVG'}</span> {meta.title}
          </div>
        </div>
        <div className="flex-1" />
        <span className="px-2 text-xs text-muted" data-testid="selection-count">
          Выделено: {selected.size}
          {model ? ` из ${model.shapes.length}` : ''}
        </span>
        <IconButton icon="parent" label="Расширить до родительской группы" shortcut="↑" onClick={expand} disabled={!selected.size} />
        <IconButton icon="selectAll" label="Выделить все" shortcut="Ctrl+A" onClick={selectAll} disabled={!model} />
        <IconButton icon="x" label="Снять выделение" shortcut="Esc" onClick={() => setSelected(new Set())} disabled={!selected.size} />
        <Divider />
        <IconButton icon="minus" label="Уменьшить" disabled={zoomIndex <= 0} onClick={() => setZoom(ZOOMS[zoomIndex - 1] ?? 1)} />
        <button
          type="button"
          className="w-12 rounded-md py-1 text-center text-xs font-medium tabular-nums hover:bg-accent-soft"
          title="Вписать"
          onClick={() => setZoom(1)}
        >
          {Math.round(zoom * 100)}%
        </button>
        <IconButton icon="plus" label="Увеличить" disabled={zoomIndex >= ZOOMS.length - 1} onClick={() => setZoom(ZOOMS[zoomIndex + 1] ?? zoom)} />
      </div>

      <div className="flex min-h-0 flex-1">
        <div ref={stageRef} className="scroll-thin relative min-w-0 flex-1 overflow-auto bg-workspace">
          {/* Рамку можно начинать и с полей вокруг иллюстрации */}
          <div
            className="flex min-h-full w-max min-w-full cursor-crosshair p-6 select-none"
            onPointerDown={onPointerDown}
            onContextMenu={onContextMenu}
          >
            <div
              className="relative m-auto rounded-sm bg-white shadow-[0_1px_4px_rgb(0_0_0/0.12)]"
              style={{ width: display.w, height: display.h }}
              onPointerMove={onHover}
              onPointerLeave={() => setHover(null)}
              data-testid="extract-stage"
            >
              <div ref={hostRef} className="absolute inset-0" />
              {model && (
                <svg
                  className="pointer-events-none absolute inset-0 h-full w-full overflow-visible"
                  viewBox={`${vb.x} ${vb.y} ${vb.width} ${vb.height}`}
                  preserveAspectRatio="xMidYMid meet"
                >
                  {Array.from(selected, (i) => {
                    const s = model.shapes[i]
                    return s ? (
                      <polygon
                        key={i}
                        points={s.outline.map((p) => `${p.x},${p.y}`).join(' ')}
                        fill="#6c63ff"
                        fillOpacity={0.08}
                        stroke="#6c63ff"
                        strokeWidth={1}
                        vectorEffect="non-scaling-stroke"
                      />
                    ) : null
                  })}
                  {bounds && (
                    <rect
                      x={bounds.x}
                      y={bounds.y}
                      width={bounds.width}
                      height={bounds.height}
                      fill="none"
                      stroke="#6c63ff"
                      strokeWidth={1.5}
                      strokeDasharray="6 4"
                      vectorEffect="non-scaling-stroke"
                    />
                  )}
                  {hoverShape && (
                    <polygon
                      points={hoverShape.outline.map((p) => `${p.x},${p.y}`).join(' ')}
                      fill="#f59e0b"
                      fillOpacity={0.1}
                      stroke="#f59e0b"
                      strokeWidth={1.5}
                      vectorEffect="non-scaling-stroke"
                    />
                  )}
                  {marquee && (
                    <rect
                      x={marquee.rect.x}
                      y={marquee.rect.y}
                      width={marquee.rect.width}
                      height={marquee.rect.height}
                      fill={marqueeColor}
                      fillOpacity={0.08}
                      stroke={marqueeColor}
                      strokeWidth={1}
                      strokeDasharray="4 3"
                      vectorEffect="non-scaling-stroke"
                    />
                  )}
                </svg>
              )}
            </div>
          </div>
          {error && (
            <div className="absolute inset-0 flex items-center justify-center text-sm text-rose-600">
              Не удалось открыть исходник: {error}
            </div>
          )}
        </div>

        <aside className="flex w-72 shrink-0 flex-col border-l border-line bg-panel">
          <div className="px-4 pt-3 pb-2">
            <h2 className="text-xs font-semibold tracking-wide text-muted uppercase">Будущий компонент</h2>
          </div>
          <div className="px-4">
            <div className="checker flex aspect-square w-full items-center justify-center overflow-hidden rounded-lg border border-line p-3">
              {previewUrl && preview ? (
                <img
                  src={previewUrl}
                  alt="Превью компонента"
                  className="max-h-full max-w-full"
                  data-testid="component-preview"
                  data-origin={`${preview.origin.x} ${preview.origin.y}`}
                  data-size={`${preview.width} ${preview.height}`}
                  draggable={false}
                />
              ) : (
                <span className="px-6 text-center text-xs text-muted">Обведите рамкой персонажа или предмет</span>
              )}
            </div>
            <dl className="mt-2 grid grid-cols-3 gap-1 text-center text-[11px] text-muted">
              <div className="rounded bg-workspace/60 py-1">
                <dt>фигур</dt>
                <dd className="font-semibold text-ink">{preview?.shapeCount ?? 0}</dd>
              </div>
              <div className="rounded bg-workspace/60 py-1">
                <dt>размер</dt>
                <dd className="font-semibold text-ink">{preview ? `${Math.round(preview.width)}×${Math.round(preview.height)}` : '—'}</dd>
              </div>
              <div className="rounded bg-workspace/60 py-1">
                <dt>defs</dt>
                <dd className="font-semibold text-ink">{preview?.defsCount ?? 0}</dd>
              </div>
            </dl>
          </div>
          <form
            className="mt-3 space-y-2 px-4"
            onSubmit={(e) => {
              e.preventDefault()
              save()
            }}
          >
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={`${meta.title} — фрагмент ${fromThisSource + 1}`}
              aria-label="Название компонента"
              className="h-9 w-full rounded-md border border-line px-2.5 text-sm outline-none focus:border-accent"
            />
            <Button type="submit" variant="primary" className="h-9 w-full" disabled={!selected.size}>
              <Icon name="save" /> Сохранить в библиотеку
            </Button>
          </form>
          <ul className="mt-auto space-y-1.5 border-t border-line px-4 py-3 text-[11px] leading-snug text-muted">
            <li>
              <b className="text-ink">Рамка</b> — фигуры целиком внутри нее
            </li>
            <li>
              <kbd>Shift</kbd>+рамка — добавить, <kbd>Alt</kbd>+рамка — вычесть
            </li>
            <li>
              <b className="text-ink">Клик</b> — фигура под курсором, <kbd>Shift</kbd>+клик — добавить/убрать
            </li>
            <li>
              <kbd>↑</kbd> — до родительской группы, <kbd>Ctrl</kbd>+<kbd>A</kbd> — все
            </li>
            <li>
              <kbd>Enter</kbd> — сохранить, <kbd>Esc</kbd> — снять выделение / к холсту
            </li>
          </ul>
        </aside>
      </div>
    </div>
  )
}
