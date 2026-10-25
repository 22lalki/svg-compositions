import { useRef } from 'react'
import { Icon } from '../../components/Icon'
import { confirmDialog, promptDialog } from '../../store/confirm'
import { openContextMenu } from '../../store/contextMenu'
import { notify } from '../../store/ui'
import type { Item } from '../catalog'
import { schemeById, useCatalog } from '../catalogStore'
import { useComposition } from '../compositionStore'
import { importObjectFiles } from '../upload'
import { preloadMasks } from '../masks'
import { useComposeUi } from '../uiStore'
import { composeFromNames } from '../generate'
import { ITEM_MIME } from './ComposeCanvas'
import { ItemThumb } from './Markup'

/** Загрузка своих объектов: файлы или папка (с подпапками L/ и S/ размер берется из пути) */
export async function uploadObjects(files: File[]) {
  const svgs = files.filter((f) => /\.svg$/i.test(f.name) || f.type === 'image/svg+xml')
  if (!svgs.length) {
    notify('Нужны SVG-файлы объектов', 'error')
    return
  }
  const { added, notes } = await importObjectFiles(svgs)
  if (added.length) {
    useCatalog.getState().addItems(added)
    await preloadMasks(added.map((s) => s.item), useComposition.getState().comp.size)
  }
  for (const n of notes.slice(0, 3)) console.info(n)
  if (added.length) {
    const variants = added.reduce((n, s) => n + Object.keys(s.assets).length, 0)
    notify(`Добавлено объектов: ${added.length} (вариантов: ${variants})${notes.length ? `. Замечаний: ${notes.length}, подробности в консоли` : ''}`)
    if (notes.length) console.info('Загрузка объектов:\n' + notes.join('\n'))
  } else {
    notify(`Не удалось загрузить: ${notes[0] ?? 'нет SVG'}`, 'error')
  }
}

async function editItem(item: Item) {
  const name = await promptDialog({
    title: 'Название объекта',
    message: 'По названию объект находится в сценарии «По объектам».',
    confirmText: 'Дальше',
    input: { label: 'Название', value: item.name },
  })
  if (name === null || !name.trim()) return
  const keywords = await promptDialog({
    title: 'Ассоциации для метафор',
    message: 'Слова через запятую: по ним объект подберется в сценарии «По метафоре» (например: деньги, экономия, доход).',
    confirmText: 'Сохранить',
    input: { label: 'Ассоциации', value: item.keywords.join(', '), maxLength: 1000 },
  })
  if (keywords === null) return
  useCatalog.getState().updateItem(item.id, {
    name: name.trim(),
    keywords: keywords.split(',').map((k) => k.trim().toLowerCase()).filter(Boolean),
  })
}

async function removeItem(item: Item) {
  const ok = await confirmDialog({
    title: `Удалить «${item.name}»?`,
    message: 'Объект исчезнет из набора и с холста. Это нельзя отменить.',
    confirmText: 'Удалить',
    danger: true,
  })
  if (!ok) return
  useComposition.getState().purgeItem(item.id)
  useComposeUi.getState().setPicked(useComposeUi.getState().picked.filter((x) => x !== item.id))
  useCatalog.getState().removeItem(item.id)
}

export function SetPanel() {
  const items = useCatalog((s) => s.items)
  useCatalog((s) => s.schemes)
  const size = useComposition((s) => s.comp.size)
  const schemeId = useComposition((s) => s.comp.schemeId)
  const scheme = schemeById(schemeId)
  const picked = useComposeUi((s) => s.picked)
  const tab = useComposeUi((s) => s.tab)
  // Отмечать объекты для сборки можно только в сценарии «По объектам»: метафора подбирает объекты сама
  const selectable = tab === 'names'
  const filesRef = useRef<HTMLInputElement>(null)
  const dirRef = useRef<HTMLInputElement>(null)

  const onFiles = (list: FileList | null) => {
    if (list?.length) void uploadObjects(Array.from(list))
  }

  return (
    <section className="flex min-h-0 flex-1 flex-col" aria-label="Набор объектов">
      <div className="flex items-center justify-between px-3 pt-3 pb-1.5">
        <h2 className="text-xs font-semibold tracking-wide text-muted uppercase">Набор · размер {size}</h2>
        <div className="flex gap-0.5">
          <button type="button" className="rounded p-1 text-muted hover:bg-accent-soft hover:text-accent-strong" title="Загрузить SVG объектов" onClick={() => filesRef.current?.click()}>
            <Icon name="upload" size={14} />
          </button>
          <button
            type="button"
            className="rounded p-1 text-muted hover:bg-accent-soft hover:text-accent-strong"
            title="Загрузить папку набора (подпапки L и S, «(1)» — фоновые варианты)"
            onClick={() => dirRef.current?.click()}
          >
            <Icon name="folder" size={14} />
          </button>
        </div>
        <input ref={filesRef} type="file" accept=".svg,image/svg+xml" multiple hidden onChange={(e) => (onFiles(e.target.files), (e.target.value = ''))} data-testid="upload-objects" />
        <input
          ref={dirRef}
          type="file"
          multiple
          hidden
          // @ts-expect-error webkitdirectory — нестандартный, но поддерживается всеми браузерами
          webkitdirectory=""
          onChange={(e) => (onFiles(e.target.files), (e.target.value = ''))}
        />
      </div>
      <p className="px-3 pb-2 text-[11px] leading-snug text-muted">
        {selectable
          ? 'Клик по карточке — отметить для сборки. «+» или перетаскивание — сразу на холст.'
          : 'Для метафоры объекты подбираются сами. «+» или перетаскивание — на холст; выбрать объекты вручную — вкладка «По объектам».'}
      </p>
      {selectable && picked.length > 0 && (
        <div className="mx-3 mb-2 flex items-center gap-1.5 rounded-lg bg-accent-soft px-2 py-1.5 text-xs" data-testid="picked-bar">
          <span className="min-w-0 flex-1 text-accent-strong">
            Отмечено: {picked.length}
            {tab !== 'names' && <span className="text-muted"> · сборка «По объектам»</span>}
          </span>
          <button
            type="button"
            className="rounded-md bg-accent px-2 py-1 font-medium text-white hover:bg-accent-strong"
            onClick={() => void composeFromNames('', picked)}
            data-testid="compose-picked"
          >
            Собрать
          </button>
          <button type="button" className="rounded-md px-1.5 py-1 text-muted hover:text-ink" onClick={() => useComposeUi.getState().setPicked([])} title="Снять отметки">
            Сбросить
          </button>
        </div>
      )}
      <div className="scroll-thin grid min-h-0 grid-cols-2 content-start gap-2 overflow-y-auto px-3 pb-3">
        {items.map((item) => {
          const has = !!(item.variants[`${size}-main`] || item.variants[`${size}-bg`])
          const isPicked = selectable && picked.includes(item.id)
          return (
            <div
              key={item.id}
              className={`group relative flex flex-col rounded-lg border bg-white p-1.5 transition-colors ${isPicked ? 'border-accent ring-1 ring-accent' : selectable ? 'border-line hover:border-accent/60' : 'border-line'} ${has ? '' : 'opacity-40'}`}
              draggable={has}
              onDragStart={(e) => {
                e.dataTransfer.setData(ITEM_MIME, item.id)
                e.dataTransfer.effectAllowed = 'copy'
              }}
              onContextMenu={(e) => {
                if (item.builtin) return
                e.preventDefault()
                openContextMenu(e.clientX, e.clientY, [
                  { label: 'Название и ассоциации', icon: 'pencil', onSelect: () => void editItem(item) },
                  { label: 'Удалить из набора', icon: 'trash', danger: true, onSelect: () => void removeItem(item) },
                ])
              }}
              data-testid="set-item"
              data-item={item.id}
              title={has ? item.name : `${item.name}: нет варианта размера ${size}`}
            >
              <button
                type="button"
                className={`flex h-16 items-center justify-center ${selectable ? '' : 'cursor-grab'}`}
                onClick={() => {
                  if (has && selectable) useComposeUi.getState().togglePicked(item.id)
                }}
                aria-pressed={selectable ? isPicked : undefined}
                aria-label={selectable ? `Отметить «${item.name}»` : item.name}
                tabIndex={selectable ? 0 : -1}
              >
                <ItemThumb item={item} size={has ? size : size === 'L' ? 'S' : 'L'} scheme={scheme} className="h-full w-full" />
              </button>
              <div className="mt-1 flex items-center gap-1">
                <span className="min-w-0 flex-1 truncate text-[11px]">{item.name}</span>
                <button
                  type="button"
                  className="rounded p-0.5 text-muted hover:bg-accent-soft hover:text-accent-strong disabled:opacity-30"
                  title="Добавить на холст"
                  aria-label={`Добавить «${item.name}» на холст`}
                  disabled={!has}
                  onClick={() => useComposition.getState().addItem(item.id)}
                  data-testid="add-item"
                >
                  <Icon name="plus" size={12} />
                </button>
              </div>
              {isPicked && (
                <span className="absolute top-1 left-1 flex h-4 w-4 items-center justify-center rounded-full bg-accent text-white">
                  <Icon name="check" size={10} />
                </span>
              )}
              {!item.builtin && <span className="absolute top-1 right-1 rounded bg-workspace px-1 text-[9px] text-muted">мой</span>}
            </div>
          )
        })}
      </div>
    </section>
  )
}
