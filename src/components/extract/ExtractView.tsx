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
import { loadSourceObjects, loadSourceText, type SourceObject } from '../../lib/sources'
import { detectObjects } from '../../lib/objects'
import { annotateWithAi } from '../../lib/aiObjects'
import { GENERAL_LIBRARY_NAME, libraryName, useLibrary } from '../../store/library'
import { notify, useUi } from '../../store/ui'
import { Icon } from '../Icon'
import { Button, Divider, IconButton } from '../ui'
import { isTypingTarget } from '../../lib/dom'
import { isDialogOpen } from '../../store/confirm'
import { mod, openContextMenu, type MenuItem } from '../../store/contextMenu'

type MarqueeMode = 'replace' | 'add' | 'subtract'
/** Объекты: клик выделяет персонажа/предмет целиком. Элементы: клик выделяет отдельную фигуру */
type ClickMode = 'objects' | 'elements'
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
  const libraries = useLibrary((s) => s.libraries)
  const saveTarget = useLibrary((s) => s.saveTarget)

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
  const [mode, setMode] = useState<ClickMode>('objects')
  /** Разметка объектов (objects.json или ИИ); null — нет, работает эвристика */
  const [annotated, setAnnotated] = useState<SourceObject[] | null>(null)
  /** Состояние ИИ-разметки загруженного SVG */
  const [ai, setAi] = useState<AiState>({ state: 'idle' })
  const aiRun = useRef(0)

  /** ИИ-разметка своего SVG: пока идет запрос, работает эвристика; результат кешируется в IndexedDB */
  function runAi(m: SourceModel, force: boolean) {
    const current = metaRef.current
    if (!current || current.kind !== 'user') return
    const run = ++aiRun.current
    setAi({ state: 'running' })
    const hint = detectObjects(m)
    void annotateWithAi(current, m, hint, force).then((result) => {
      if (run !== aiRun.current) return
      if (result.status === 'done') {
        setAnnotated(result.objects)
        const named = result.objects.filter((o) => o.name).length
        setAi({ state: 'done', count: named })
        if (!result.cached) notify(`ИИ определил объекты: ${named}`)
      } else {
        setAi({ state: result.status, message: result.message })
      }
    })
  }

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
        const next = analyzeSource(svg, meta)
        setAnnotated(null)
        setModel(next)
        // Готовая разметка объектов для встроенных исходников (иначе — эвристика)
        // Свои SVG размечает ИИ (с кешем), встроенные — готовая разметка
        if (meta.kind === 'user') runAi(next, false)
        else void loadSourceObjects(meta, next.shapes.length).then((list) => !cancelled && setAnnotated(list))
      })
      .catch((e: unknown) => !cancelled && setError(e instanceof Error ? e.message : String(e)))
    return () => {
      cancelled = true
      aiRun.current++
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

  // Логические объекты (персонаж, животное, предмет) для выделения одним кликом:
  // у встроенных исходников — готовая именованная разметка, у загруженных — эвристика
  const objects = useMemo(() => {
    if (!model) return null
    const list: SourceObject[] = annotated ?? detectObjects(model).map((shapes) => ({ name: null, shapes }))
    const of = new Int32Array(model.shapes.length)
    list.forEach((o, k) => o.shapes.forEach((i) => (of[i] = k)))
    return { list, of }
  }, [model, annotated])
  const objectAt = (i: number): SourceObject => objects?.list[objects.of[i]!] ?? { name: null, shapes: [i] }
  const objectOf = (i: number): number[] => objectAt(i).shapes

  /** Имя по умолчанию: если выделены ровно 1–3 именованных объекта — их имена */
  const suggestedName = useMemo(() => {
    if (!objects || selected.size === 0) return null
    const ks = new Set([...selected].map((i) => objects.of[i]!))
    if (ks.size > 3) return null
    const list = [...ks].map((k) => objects.list[k]!)
    const exact = list.every((o) => o.name && o.shapes.every((i) => selected.has(i)))
    const total = list.reduce((n, o) => n + o.shapes.length, 0)
    if (!exact || total !== selected.size) return null
    const names = list.map((o) => o.name!)
    return names.length === 1 ? names[0]! : `${names.slice(0, -1).join(', ')} и ${names.at(-1)!.toLowerCase()}`
  }, [objects, selected])
  const defaultName = suggestedName ?? `${meta?.title ?? ''} — фрагмент ${fromThisSource + 1}`

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
      name: name.trim() || defaultName,
      sourceId: meta.id,
      width: result.width,
      height: result.height,
      defs: result.defs,
      markup: result.markup,
      createdAt: Date.now(),
      libraryId: saveTarget ?? undefined,
    }
    useLibrary.getState().add(component)
    notify(`«${component.name}» сохранен в «${libraryName(libraries, saveTarget)}»`)
    setSelected(new Set())
    setName('')
    setMode('objects')
  }

  /** Выделить объекты, в которые входят выбранные фигуры, и вернуться к режиму объектов */
  function selectObjectsOfSelection() {
    setSelected((prev) => new Set([...prev].flatMap((i) => objectOf(i))))
    setMode('objects')
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
        // Клик по пустому месту: снять выделение и вернуться к объектам
        if (!m.shiftKey) {
          setSelected(new Set())
          setMode('objects')
        }
      } else {
        // Режим объектов — персонаж/предмет целиком, режим элементов — одна фигура
        const target = mode === 'objects' ? objectOf(hit) : [hit]
        if (m.shiftKey) {
          setSelected((prev) => {
            const next = new Set(prev)
            const all = target.every((i) => next.has(i))
            target.forEach((i) => (all ? next.delete(i) : next.add(i)))
            return next
          })
        } else {
          setSelected(new Set(target))
        }
      }
    }
    const onUp = (ev: PointerEvent) => finish(ev)
    const onCancel = (ev: PointerEvent) => finish(ev, true)
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onCancel)
  }

  /** Двойной клик — режим элементов: выделяется сама фигура, дальше Shift+клик добавляет фигуры */
  function onDoubleClick(e: ReactMouseEvent<HTMLDivElement>) {
    const hit = shapeAt(e.target)
    if (hit === undefined) return
    setMode('elements')
    setSelected((prev) => (e.shiftKey ? new Set([...prev, hit]) : new Set([hit])))
  }

  /** ПКМ: действия с фигурой под курсором и с выделением целиком */
  function onContextMenu(e: ReactMouseEvent<HTMLDivElement>) {
    e.preventDefault()
    if (!model) return
    const hit = shapeAt(e.target)
    const items: MenuItem[] = []
    if (hit !== undefined) {
      const obj = objectOf(hit)
      const objSelected = obj.every((i) => selected.has(i))
      const isSelected = selected.has(hit)
      // Объект целиком (персонаж, предмет)
      items.push({
        label: objectAt(hit).name ? `Выделить «${objectAt(hit).name}»` : `Выделить объект (${obj.length})`,
        icon: 'marquee',
        disabled: objSelected && selected.size === obj.length,
        onSelect: () => {
          setSelected(new Set(obj))
          setMode('objects')
        },
      })
      if (selected.size && !objSelected) {
        items.push({
          label: 'Добавить объект к выделению',
          icon: 'plus',
          onSelect: () => setSelected((prev) => new Set([...prev, ...obj])),
        })
      } else if (objSelected && selected.size > obj.length) {
        items.push({
          label: 'Убрать объект из выделения',
          icon: 'minus',
          onSelect: () => setSelected((prev) => new Set([...prev].filter((i) => !obj.includes(i)))),
        })
      }
      items.push('separator')
      // Отдельная фигура (режим элементов)
      items.push({
        label: 'Выделить только эту фигуру',
        icon: 'pointer',
        shortcut: 'двойной клик',
        disabled: isSelected && selected.size === 1,
        onSelect: () => {
          setSelected(new Set([hit]))
          setMode('elements')
        },
      })
      if (isSelected) {
        items.push({
          label: 'Исключить фигуру из выделения',
          icon: 'minus',
          onSelect: () => {
            setSelected((prev) => new Set([...prev].filter((i) => i !== hit)))
            setMode('elements')
          },
        })
      } else if (selected.size) {
        items.push({
          label: 'Добавить фигуру к выделению',
          icon: 'plus',
          onSelect: () => {
            setSelected((prev) => new Set([...prev, hit]))
            setMode('elements')
          },
        })
      }
      items.push('separator')
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
  const actions = useRef({ expand, selectAll, save, closeSource, selected, mode, selectObjectsOfSelection })
  actions.current = { expand, selectAll, save, closeSource, selected, mode, selectObjectsOfSelection }
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isDialogOpen()) return
      if (e.key === 'Alt') e.preventDefault() // иначе Alt фокусирует меню браузера
      if (isTypingTarget(e.target)) return
      const a = actions.current
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        // Из элементов ↑ возвращает к объектам целиком, из объектов — к родительской группе исходника
        if (a.mode === 'elements' && a.selected.size) a.selectObjectsOfSelection()
        else a.expand()
      } else if ((e.ctrlKey || e.metaKey) && e.code === 'KeyA') {
        e.preventDefault()
        a.selectAll()
      } else if (e.key === 'Escape') {
        if (a.mode === 'elements') setMode('objects')
        else if (a.selected.size) setSelected(new Set())
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
  // В режиме объектов подсвечиваем то, что выделит клик: объект целиком
  const hoverObj = hoverShape && mode === 'objects' ? objectAt(hoverShape.index) : null
  const hoverObject =
    model && hoverObj && (hoverObj.shapes.length > 1 || hoverObj.name) ? selectionBounds(model, hoverObj.shapes) : null
  /** Подпись объекта над рамкой подсветки (в пикселях сцены) */
  const hoverLabel =
    hoverObject && hoverObj?.name && menuShape === null
      ? {
          text: hoverObj.name,
          left: ((hoverObject.x - vb.x) / vb.width) * display.w,
          top: ((hoverObject.y - vb.y) / vb.height) * display.h,
        }
      : null
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
        {meta.kind === 'user' && <AiStatus ai={ai} onRerun={() => model && runAi(model, true)} />}
        <div className="flex rounded-md border border-line p-0.5 text-xs font-medium" role="group" aria-label="Что выделяет клик">
          {(
            [
              ['objects', 'Объекты', 'Клик выделяет объект целиком: персонажа, животное, предмет'],
              ['elements', 'Элементы', 'Клик выделяет отдельную фигуру (или двойной клик по объекту)'],
            ] as const
          ).map(([value, label, hint]) => (
            <button
              key={value}
              type="button"
              title={hint}
              aria-pressed={mode === value}
              data-testid={`mode-${value}`}
              onClick={() => (value === 'objects' && selected.size ? selectObjectsOfSelection() : setMode(value))}
              className={`rounded px-2 py-1 transition ${mode === value ? 'bg-accent text-white' : 'text-muted hover:text-ink'}`}
            >
              {label}
            </button>
          ))}
        </div>
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
            onDoubleClick={onDoubleClick}
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
                  {hoverObject && (
                    <rect
                      data-testid="hover-object"
                      x={hoverObject.x}
                      y={hoverObject.y}
                      width={hoverObject.width}
                      height={hoverObject.height}
                      fill="#f59e0b"
                      fillOpacity={0.08}
                      stroke="#f59e0b"
                      strokeWidth={1.5}
                      strokeDasharray="5 3"
                      vectorEffect="non-scaling-stroke"
                    />
                  )}
                  {hoverShape && (!hoverObject || menuShape !== null) && (
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
              {hoverLabel && (
                <div
                  data-testid="hover-label"
                  className="pointer-events-none absolute -translate-y-full rounded bg-amber-500 px-1.5 py-0.5 text-[11px] font-semibold whitespace-nowrap text-white shadow-sm"
                  style={{ left: hoverLabel.left, top: Math.max(hoverLabel.top - 2, 18) }}
                >
                  {hoverLabel.text}
                </div>
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
              placeholder={defaultName}
              aria-label="Название компонента"
              className="h-9 w-full rounded-md border border-line px-2.5 text-sm outline-none focus:border-accent"
            />
            <select
              value={saveTarget ?? ''}
              onChange={(e) => useLibrary.getState().setSaveTarget(e.target.value || null)}
              aria-label="Библиотека для сохранения"
              title="В какую библиотеку сохранить"
              className="h-9 w-full rounded-md border border-line bg-white px-2 text-sm outline-none focus:border-accent"
            >
              <option value="">{GENERAL_LIBRARY_NAME}</option>
              {libraries.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.name}
                </option>
              ))}
            </select>
            <Button type="submit" variant="primary" className="h-9 w-full" disabled={!selected.size}>
              <Icon name="save" /> Сохранить в библиотеку
            </Button>
          </form>
        </aside>
      </div>
    </div>
  )
}

type AiState = { state: 'idle' | 'running' | 'done' | 'unavailable' | 'error' | 'too_many'; message?: string; count?: number }

/** Состояние ИИ-разметки объектов загруженного SVG */
function AiStatus({ ai, onRerun }: { ai: AiState; onRerun: () => void }) {
  const base = 'mr-1 inline-flex h-7 items-center gap-1 rounded-md px-2 text-xs font-medium'
  if (ai.state === 'running')
    return (
      <span
        className={`${base} text-accent-strong`}
        data-testid="ai-status"
        data-state="running"
        title="Claude определяет объекты рисунка. Пока можно выделять — работает автоматическое определение"
      >
        <Icon name="loader" size={13} className="animate-spin" /> ИИ размечает…
      </span>
    )
  if (ai.state === 'done')
    return (
      <button
        type="button"
        onClick={onRerun}
        data-testid="ai-status"
        data-state="done"
        title="Объекты определены ИИ (Claude). Нажмите, чтобы разметить заново"
        className={`${base} bg-accent-soft text-accent-strong hover:bg-accent/15`}
      >
        <Icon name="sparkles" size={13} /> ИИ: {ai.count} объектов
      </button>
    )
  if (ai.state === 'error')
    return (
      <button
        type="button"
        onClick={onRerun}
        data-testid="ai-status"
        data-state="error"
        title={`ИИ-разметка не удалась: ${ai.message ?? ''}. Нажмите, чтобы повторить`}
        className={`${base} text-rose-600 hover:bg-rose-50`}
      >
        <Icon name="sparkles" size={13} /> ИИ: повторить
      </button>
    )
  if (ai.state === 'unavailable' || ai.state === 'too_many')
    return (
      <span
        className={`${base} text-muted`}
        data-testid="ai-status"
        data-state={ai.state}
        title={`${ai.message ?? ''} — объекты определены автоматически`}
      >
        Объекты: авто
      </span>
    )
  return null
}

