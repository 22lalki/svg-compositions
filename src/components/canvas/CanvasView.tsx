import { useEffect, useState } from 'react'
import { buildExportSvg, downloadText, exportFileName } from '../../lib/exportSvg'
import { componentMap, useLibrary } from '../../store/library'
import { useScene, type LayerOp } from '../../store/scene'
import { notify } from '../../store/ui'
import { Icon } from '../Icon'
import { Button, Divider, IconButton } from '../ui'
import { isTypingTarget } from '../../lib/dom'
import { confirmDialog, isDialogOpen } from '../../store/confirm'
import { LayersPanel } from './LayersPanel'
import { Viewport } from './Viewport'

function exportScene() {
  const { scene } = useScene.getState()
  if (scene.objects.length === 0) {
    notify('Холст пуст — нечего экспортировать')
    return
  }
  const svg = buildExportSvg(scene, componentMap(useLibrary.getState().components))
  downloadText(svg, exportFileName())
  notify('SVG скачан')
}

const ARROWS: Record<string, [number, number]> = {
  ArrowLeft: [-1, 0],
  ArrowRight: [1, 0],
  ArrowUp: [0, -1],
  ArrowDown: [0, 1],
}

function useCanvasShortcuts() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isTypingTarget(e.target) || isDialogOpen()) return
      const s = useScene.getState()
      const mod = e.ctrlKey || e.metaKey
      // e.code, а не e.key: сочетания работают в любой раскладке
      if (mod && e.code === 'KeyZ') {
        e.preventDefault()
        if (e.shiftKey) s.redo()
        else s.undo()
      } else if (mod && e.code === 'KeyY') {
        e.preventDefault()
        s.redo()
      } else if (mod && e.code === 'KeyD') {
        e.preventDefault()
        s.duplicateSelected()
      } else if ((e.key === 'Delete' || e.key === 'Backspace') && s.selectedId) {
        e.preventDefault()
        s.removeSelected()
      } else if (e.key in ARROWS && s.selectedId && !mod) {
        e.preventDefault()
        const o = s.scene.objects.find((x) => x.id === s.selectedId)
        if (!o) return
        const [dx, dy] = ARROWS[e.key]!
        const step = e.shiftKey ? 10 : 1
        s.updateObject(o.id, { x: o.x + dx * step, y: o.y + dy * step }, `nudge:${o.id}`)
      } else if (e.key === 'Escape') {
        s.select(null)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
}

function ArtboardSize() {
  const width = useScene((s) => s.scene.width)
  const height = useScene((s) => s.scene.height)
  const [draft, setDraft] = useState({ w: String(width), h: String(height) })
  useEffect(() => setDraft({ w: String(width), h: String(height) }), [width, height])

  function commit() {
    const parse = (v: string, fallback: number) => {
      const n = Math.round(Number(v))
      return Number.isFinite(n) && n > 0 ? Math.min(10000, Math.max(50, n)) : fallback
    }
    const w = parse(draft.w, width)
    const h = parse(draft.h, height)
    setDraft({ w: String(w), h: String(h) })
    useScene.getState().setArtboard(w, h)
  }

  const input = 'h-7 w-14 rounded border border-line bg-white px-1.5 text-xs tabular-nums outline-none focus:border-accent'
  return (
    <label className="flex items-center gap-1 text-xs text-muted" title="Размер артборда">
      Артборд
      <input
        className={input}
        value={draft.w}
        inputMode="numeric"
        aria-label="Ширина артборда"
        onChange={(e) => setDraft((d) => ({ ...d, w: e.target.value }))}
        onBlur={commit}
        onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
      />
      ×
      <input
        className={input}
        value={draft.h}
        inputMode="numeric"
        aria-label="Высота артборда"
        onChange={(e) => setDraft((d) => ({ ...d, h: e.target.value }))}
        onBlur={commit}
        onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
      />
    </label>
  )
}

function SelectionInfo() {
  const obj = useScene((s) => s.scene.objects.find((o) => o.id === s.selectedId))
  if (!obj) return null
  const scale =
    Math.abs(obj.scale - obj.scaleY) < 1e-4
      ? `${Math.round(obj.scale * 100)}%`
      : `${Math.round(obj.scale * 100)}×${Math.round(obj.scaleY * 100)}%`
  return (
    <span className="hidden items-center gap-2 px-2 text-xs whitespace-nowrap text-muted tabular-nums xl:flex" data-testid="selection-info">
      <span>X {Math.round(obj.x)}</span>
      <span>Y {Math.round(obj.y)}</span>
      <span>{scale}</span>
      <span>{Math.round(obj.rotation * 10) / 10}°</span>
      {obj.flipX && <span>⇋</span>}
    </span>
  )
}

/** Очистка холста: с подтверждением, но обратимо — это один шаг истории */
async function clearCanvas(count: number) {
  const ok = await confirmDialog({
    title: 'Очистить холст?',
    message: `С холста уберутся все объекты (${count}). Компоненты в библиотеке останутся. Вернуть можно через Ctrl+Z.`,
    confirmText: 'Очистить',
    danger: true,
  })
  if (!ok) return
  useScene.getState().clearScene()
  notify('Холст очищен. Вернуть — Ctrl+Z')
}

export function CanvasView() {
  useCanvasShortcuts()
  const canUndo = useScene((st) => st.past.length > 0)
  const canRedo = useScene((st) => st.future.length > 0)
  const hasSelection = useScene((st) => st.selectedId !== null)
  const objectCount = useScene((st) => st.scene.objects.length)
  const s = useScene.getState()
  const order = (op: LayerOp) => () => s.reorderSelected(op)

  return (
    <div className="flex h-full flex-col">
      <div className="flex h-12 shrink-0 items-center gap-0.5 border-b border-line bg-panel px-2">
        <IconButton icon="undo" label="Отменить" shortcut="Ctrl+Z" onClick={s.undo} disabled={!canUndo} />
        <IconButton icon="redo" label="Повторить" shortcut="Ctrl+Shift+Z" onClick={s.redo} disabled={!canRedo} />
        <Divider />
        <ArtboardSize />
        <Divider />
        <IconButton icon="copy" label="Дублировать" shortcut="Ctrl+D" onClick={s.duplicateSelected} disabled={!hasSelection} />
        <IconButton icon="flip" label="Отразить по горизонтали" onClick={s.flipSelected} disabled={!hasSelection} />
        <Divider />
        <IconButton icon="front" label="На передний план" onClick={order('front')} disabled={!hasSelection} />
        <IconButton icon="forward" label="Вперед" onClick={order('forward')} disabled={!hasSelection} />
        <IconButton icon="backward" label="Назад" onClick={order('backward')} disabled={!hasSelection} />
        <IconButton icon="back" label="На задний план" onClick={order('back')} disabled={!hasSelection} />
        <Divider />
        <IconButton icon="trash" label="Удалить" shortcut="Delete" onClick={s.removeSelected} disabled={!hasSelection} />
        <SelectionInfo />
        <div className="flex-1" />
        <Button
          variant="ghost"
          onClick={() => void clearCanvas(objectCount)}
          disabled={objectCount === 0}
          title="Убрать с холста все объекты (компоненты в библиотеке останутся)"
          className="whitespace-nowrap"
          data-testid="clear-canvas"
        >
          <Icon name="eraser" /> Очистить холст
        </Button>
        <Button variant="primary" onClick={exportScene} className="whitespace-nowrap" data-testid="export">
          <Icon name="download" /> Скачать SVG
        </Button>
      </div>
      <div className="flex min-h-0 flex-1">
        <div className="min-w-0 flex-1">
          <Viewport />
        </div>
        <aside className="w-52 shrink-0 border-l border-line bg-panel">
          <LayersPanel />
        </aside>
      </div>
    </div>
  )
}
