import { useEffect, useState } from 'react'
import { Icon } from '../../components/Icon'
import { Button, Divider, IconButton } from '../../components/ui'
import { FileDropOverlay } from '../../components/FileDropOverlay'
import { downloadText } from '../../lib/exportSvg'
import { isTypingTarget } from '../../lib/dom'
import { confirmDialog, isDialogOpen } from '../../store/confirm'
import { isContextMenuOpen } from '../../store/contextMenu'
import { notify } from '../../store/ui'
import { preloadSize, useAssets } from '../assets'
import { preloadMasks } from '../masks'
import { lookupItem, schemeById, useCatalog } from '../catalogStore'
import { useComposition } from '../compositionStore'
import { FORMAT_LABELS, formatSize } from '../model'
import { buildCompositionSvg, validateComposition } from '../render'
import { composeUnreadable, loadComposition, loadItems, loadSchemes, saveComposition } from '../storage'
import { composeFromMetaphor } from '../generate'
import { useComposeUi } from '../uiStore'
import { ComposeCanvas } from './ComposeCanvas'
import { GeneratorPanel } from './GeneratorPanel'
import { SetPanel, uploadObjects } from './SetPanel'
import { SettingsPanel } from './SettingsPanel'

function currentSvg() {
  const { comp } = useComposition.getState()
  return buildCompositionSvg(comp, schemeById(comp.schemeId), lookupItem)
}

function fileName() {
  const { comp } = useComposition.getState()
  const { width, height } = formatSize(comp.format, comp.size)
  return `composition-${comp.size}-${width}x${height}.svg`
}

function exportSvg() {
  if (!useComposition.getState().comp.objects.length) {
    notify('Холст пуст — соберите композицию')
    return
  }
  downloadText(currentSvg(), fileName())
  notify('SVG скачан: фон и каждый объект — отдельные группы')
}

async function copyForFigma() {
  if (!useComposition.getState().comp.objects.length) {
    notify('Холст пуст — соберите композицию')
    return
  }
  try {
    await navigator.clipboard.writeText(currentSvg())
    notify('Скопировано: вставьте в Figma (Ctrl+V) — получатся редактируемые слои')
  } catch {
    notify('Браузер не дал доступ к буферу обмена — скачайте SVG и перетащите его в Figma', 'error')
  }
}

const ARROWS: Record<string, [number, number]> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }

function useShortcuts() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isTypingTarget(e.target) || isDialogOpen() || isContextMenuOpen()) return
      const s = useComposition.getState()
      const mod = e.ctrlKey || e.metaKey
      const has = s.selected.length > 0
      // e.code, а не e.key: сочетания работают в любой раскладке
      if (mod && e.code === 'KeyZ') {
        e.preventDefault()
        if (e.shiftKey) s.redo()
        else s.undo()
      } else if (mod && e.code === 'KeyY') {
        e.preventDefault()
        s.redo()
      } else if (mod && e.code === 'KeyA') {
        e.preventDefault()
        s.selectAll()
      } else if (mod && e.code === 'KeyD' && has) {
        e.preventDefault()
        s.duplicateSelected()
      } else if (mod && e.code === 'KeyG' && has) {
        e.preventDefault()
        if (e.shiftKey) s.ungroupSelected()
        else s.groupSelected()
      } else if (mod && (e.code === 'BracketRight' || e.code === 'BracketLeft') && has) {
        e.preventDefault()
        const up = e.code === 'BracketRight'
        s.reorderSelected(e.shiftKey ? (up ? 'front' : 'back') : up ? 'forward' : 'backward')
      } else if ((e.key === 'Delete' || e.key === 'Backspace') && has) {
        e.preventDefault()
        s.removeSelected()
      } else if (e.key in ARROWS && has && !mod) {
        e.preventDefault()
        const [dx, dy] = ARROWS[e.key]!
        const step = e.shiftKey ? 10 : 1
        s.nudgeSelected(dx * step, dy * step)
      } else if (e.code === 'KeyR' && has && !mod) {
        e.preventDefault()
        s.rotateSelected(e.shiftKey ? -15 : 15)
      } else if (e.key === 'Escape') {
        s.select(null)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
}

/** Значок соблюдения правил схемы; при нарушениях — список по наведению */
function RulesBadge() {
  const comp = useComposition((s) => s.comp)
  useAssets((s) => s.version)
  useCatalog((s) => s.schemes)
  const issues = validateComposition(comp, schemeById(comp.schemeId), lookupItem)
  if (!comp.objects.length) return null
  return issues.length ? (
    <span className="rounded-md bg-rose-50 px-2 py-1 text-xs text-rose-700" title={issues.map((i) => i.text).join('\n')} data-testid="rules">
      ⚠ Нарушений: {issues.length}
    </span>
  ) : (
    <span
      className="hidden items-center gap-1 rounded-md bg-emerald-50 px-2 py-1 text-xs text-emerald-700 xl:inline-flex"
      title="Все цвета из схемы, фоновые объекты — только цветами фона, объекты в натуральную величину"
      data-testid="rules"
    >
      <Icon name="check" size={12} /> Схема соблюдена
    </span>
  )
}

function Toolbar() {
  const canUndo = useComposition((s) => s.past.length > 0)
  const canRedo = useComposition((s) => s.future.length > 0)
  const selected = useComposition((s) => s.selected)
  const count = useComposition((s) => s.comp.objects.length)
  const format = useComposition((s) => s.comp.format)
  const size = useComposition((s) => s.comp.size)
  const st = useComposition.getState()
  const has = selected.length > 0
  const { width, height } = formatSize(format, size)
  return (
    <div className="flex h-12 shrink-0 items-center gap-0.5 border-b border-line bg-panel px-2">
      <IconButton icon="undo" label="Отменить" shortcut="Ctrl+Z" onClick={st.undo} disabled={!canUndo} />
      <IconButton icon="redo" label="Повторить" shortcut="Ctrl+Shift+Z" onClick={st.redo} disabled={!canRedo} />
      <Divider />
      <IconButton icon="copy" label="Дублировать" shortcut="Ctrl+D" onClick={st.duplicateSelected} disabled={!has} />
      <IconButton icon="rotateCcw" label="Повернуть на −15°" shortcut="Shift+R" onClick={() => st.rotateSelected(-15)} disabled={!has} />
      <IconButton icon="rotateCw" label="Повернуть на 15°" shortcut="R" onClick={() => st.rotateSelected(15)} disabled={!has} />
      <IconButton icon="group" label="Объединить" shortcut="Ctrl+G" onClick={st.groupSelected} disabled={selected.length < 2} />
      <IconButton icon="ungroup" label="Разъединить" shortcut="Ctrl+Shift+G" onClick={st.ungroupSelected} disabled={!has} />
      <Divider />
      <IconButton icon="front" label="На передний план" shortcut="Ctrl+Shift+]" onClick={() => st.reorderSelected('front')} disabled={!has} />
      <IconButton icon="forward" label="Вперед" shortcut="Ctrl+]" onClick={() => st.reorderSelected('forward')} disabled={!has} />
      <IconButton icon="backward" label="Назад" shortcut="Ctrl+[" onClick={() => st.reorderSelected('backward')} disabled={!has} />
      <IconButton icon="back" label="На задний план" shortcut="Ctrl+Shift+[" onClick={() => st.reorderSelected('back')} disabled={!has} />
      <Divider />
      <IconButton icon="trash" label="Удалить" shortcut="Delete" onClick={st.removeSelected} disabled={!has} />
      <span className="hidden px-2 text-xs whitespace-nowrap text-muted tabular-nums 2xl:inline">
        {FORMAT_LABELS[format]} {width}×{height} · {size}
      </span>
      <div className="flex-1" />
      <RulesBadge />
      <Button
        variant="ghost"
        disabled={!count}
        onClick={() =>
          void confirmDialog({ title: 'Очистить холст?', message: 'Все объекты уберутся с холста. Вернуть можно через Ctrl+Z.', confirmText: 'Очистить', danger: true }).then(
            (ok) => ok && useComposition.getState().clear(),
          )
        }
        title="Убрать все объекты"
      >
        <Icon name="eraser" />
      </Button>
      <Button onClick={() => void copyForFigma()} className="whitespace-nowrap" title="Скопировать SVG: в Figma вставляется как редактируемые слои" data-testid="copy-figma">
        <Icon name="clipboard" /> Для Figma
      </Button>
      <Button variant="primary" onClick={exportSvg} className="whitespace-nowrap" data-testid="export">
        <Icon name="download" /> SVG
      </Button>
    </div>
  )
}

/** Загрузка сохраненного: сцена, свои схемы и объекты; файлы объектов нужного размера — до показа */
async function bootstrap() {
  const fail =
    <T,>(fallback: T) =>
    (e: unknown): T => {
      console.error(e)
      return fallback
    }
  const [comp, schemes, items] = await Promise.all([loadComposition().catch(fail(null)), loadSchemes().catch(fail([])), loadItems().catch(fail([]))])
  if (composeUnreadable().length) notify('Не удалось прочитать сохраненную композицию. Чтобы не затереть ее, сохранение приостановлено: перезагрузите страницу', 'error')
  useCatalog.getState().init(items, schemes)
  if (comp) {
    const known = new Set(useCatalog.getState().items.map((i) => i.id))
    useComposition.getState().init({ ...comp, objects: comp.objects.filter((o) => known.has(o.itemId)) })
  }
  await preloadSize(useCatalog.getState().items, useComposition.getState().comp.size)
  // Формы объектов — для оценки раскладки (aesthetics.ts); до их готовности автосборка считала бы по рамкам
  await preloadMasks(useCatalog.getState().items, useComposition.getState().comp.size)
  // Первый визит: сразу показываем, как работает сборка по метафоре, а не пустой холст
  if (!comp && !composeUnreadable().length) {
    const demo = 'Финансовая грамотность'
    useComposeUi.getState().setMetaphor(demo)
    await composeFromMetaphor(demo)
    useComposition.setState({ past: [] })
    // Демо сохраняем сразу: автосохранение подписывается позже и иначе собирало бы его заново при каждой
    // перезагрузке (а с ключом ИИ — платным запросом)
    await saveComposition(useComposition.getState().comp).catch((e: unknown) => console.error('Не удалось сохранить композицию', e))
  }
}

/**
 * Загрузка и автосохранение — один раз за жизнь страницы: при возврате на вкладку композиция, история отмен
 * и «Другой» остаются (повторный init сбросил бы их)
 */
let composeReady: Promise<void> | null = null
function startCompose(): Promise<void> {
  composeReady ??= bootstrap()
    .catch((e: unknown) => console.error(e))
    .then(() => {
      startAutosave()
    })
  return composeReady
}

/** Автосохранение после каждого шага истории (не на каждом кадре жеста); файлы другого размера — догрузить */
function startAutosave() {
  let saved = useComposition.getState().comp
  return useComposition.subscribe((s) => {
    if (s.gestureBase || s.comp === saved) return
    if (s.comp.size !== saved.size) {
      const items = useCatalog.getState().items
      void preloadSize(items, s.comp.size).then(() => preloadMasks(items, s.comp.size))
    }
    saved = s.comp
    saveComposition(s.comp).catch((e: unknown) => console.error('Не удалось сохранить композицию', e))
  })
}

export function ComposeView() {
  const [ready, setReady] = useState(false)
  useShortcuts()
  useEffect(() => {
    let cancelled = false
    void startCompose().then(() => !cancelled && setReady(true))
    return () => {
      cancelled = true
    }
  }, [])

  if (!ready) return <div className="flex h-full items-center justify-center text-sm text-muted">Загрузка набора…</div>

  return (
    <div className="flex h-full min-h-0">
      <aside className="flex w-72 shrink-0 flex-col border-r border-line bg-panel">
        <GeneratorPanel />
        <SetPanel />
      </aside>
      <main className="flex min-w-0 flex-1 flex-col">
        <Toolbar />
        <div className="min-h-0 flex-1">
          <ComposeCanvas />
        </div>
      </main>
      <aside className="w-72 shrink-0 border-l border-line bg-panel">
        <SettingsPanel />
      </aside>
      <FileDropOverlay onFiles={(files) => void uploadObjects(files)} hint="Файлы станут объектами набора: «Имя (1).svg» — вариант того же объекта" />
    </div>
  )
}
