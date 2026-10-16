import { memo, useCallback, useMemo, useState, type DragEvent as ReactDragEvent, type MouseEvent as ReactMouseEvent, type ReactNode } from 'react'
import type { Component, Library } from '../types'
import { COMPONENT_MIME, componentPreview } from '../lib/componentPreview'
import { GENERAL_LIBRARY_NAME, useLibrary } from '../store/library'
import { useScene } from '../store/scene'
import { notify, sourceLabel, useUi } from '../store/ui'
import { Icon } from './Icon'
import { confirmDialog } from '../store/confirm'
import { openContextMenu, type MenuItem } from '../store/contextMenu'

const GENERAL = 'general'
const EXPANDED_KEY = 'svg-constructor:expanded-libraries'

function readExpanded(): Set<string> {
  try {
    const raw = localStorage.getItem(EXPANDED_KEY)
    if (raw) return new Set(JSON.parse(raw) as string[])
  } catch {
    // нет localStorage — просто не запомним
  }
  return new Set([GENERAL])
}

function writeExpanded(ids: Set<string>) {
  try {
    localStorage.setItem(EXPANDED_KEY, JSON.stringify([...ids]))
  } catch {
    // настройка удобства
  }
}

export function LibraryPanel() {
  const components = useLibrary((s) => s.components)
  const libraries = useLibrary((s) => s.libraries)
  const sources = useUi((s) => s.sources)
  const objects = useScene((s) => s.scene.objects)
  const [filter, setFilter] = useState<string>('all')
  const [expanded, setExpanded] = useState(readExpanded)
  /** Библиотека, название которой сейчас редактируется */
  const [renaming, setRenaming] = useState<string | null>(null)
  /** «Очистить»: режим выбора компонентов галочками для удаления */
  const [picking, setPicking] = useState(false)
  const [pickedRaw, setPicked] = useState<ReadonlySet<string>>(() => new Set())

  const usage = useMemo(() => {
    const m = new Map<string, number>()
    for (const o of objects) m.set(o.componentId, (m.get(o.componentId) ?? 0) + 1)
    return m
  }, [objects])

  const sourceIds = useMemo(() => new Set(components.map((c) => c.sourceId)), [components])
  const activeFilter = filter !== 'all' && !sourceIds.has(filter) ? 'all' : filter
  const visible = activeFilter === 'all' ? components : components.filter((c) => c.sourceId === activeFilter)

  const toggle = useCallback((id: string, open?: boolean) => {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (open ?? !next.has(id)) next.add(id)
      else next.delete(id)
      writeExpanded(next)
      return next
    })
  }, [])

  /** Новая библиотека: сразу раскрыта и в режиме переименования */
  const createLibrary = useCallback(
    (moveComponentId?: string) => {
      const lib = useLibrary.getState().createLibrary()
      if (moveComponentId) useLibrary.getState().moveComponent(moveComponentId, lib.id)
      toggle(lib.id, true)
      setRenaming(lib.id)
      return lib
    },
    [toggle],
  )

  // Выбранные — только существующие компоненты (другая вкладка могла что-то удалить)
  const picked = useMemo(() => new Set(components.filter((c) => pickedRaw.has(c.id)).map((c) => c.id)), [components, pickedRaw])
  const togglePick = useCallback((ids: string[], on: boolean) => {
    setPicked((prev) => {
      const next = new Set(prev)
      for (const id of ids) {
        if (on) next.add(id)
        else next.delete(id)
      }
      return next
    })
  }, [])
  const stopPicking = () => {
    setPicking(false)
    setPicked(new Set())
  }
  const allVisiblePicked = visible.length > 0 && visible.every((c) => picked.has(c.id))

  async function removePicked() {
    const ids = [...picked]
    if (!ids.length) return
    const onCanvas = ids.filter((id) => (usage.get(id) ?? 0) > 0).length
    const ok = await confirmDialog({
      title: ids.length === components.length ? 'Очистить библиотеку?' : `Удалить компоненты (${ids.length})?`,
      message:
        `Выбранные компоненты (${ids.length}) будут удалены из библиотеки.` +
        (onCanvas ? ` ${onCanvas} из них стоят на холсте — их объекты тоже уберутся с холста.` : '') +
        ' Сами библиотеки (папки) останутся.',
      confirmText: 'Удалить',
      danger: true,
    })
    if (!ok) return
    for (const id of ids) useScene.getState().purgeComponent(id)
    useLibrary.getState().removeMany(ids)
    stopPicking()
    notify(`Удалено компонентов: ${ids.length}`)
  }

  const sections: Array<{ id: string; library: Library | null; items: Component[] }> = [
    { id: GENERAL, library: null, items: visible.filter((c) => !c.libraryId) },
    ...libraries.map((l) => ({ id: l.id, library: l, items: visible.filter((c) => c.libraryId === l.id) })),
  ]

  return (
    <div className="flex h-full flex-col">
      <div className="space-y-2 px-4 pt-3 pb-3">
        <div className="flex items-center justify-between gap-2">
          <h2 className="text-xs font-semibold tracking-wide text-muted uppercase">Библиотеки</h2>
          <span className="mr-auto text-xs text-muted">{components.length}</span>
          <button
            type="button"
            onClick={() => createLibrary()}
            title="Новая библиотека: например «Собаки», чтобы держать компоненты по темам"
            className="inline-flex h-7 items-center gap-1 rounded-md border border-line px-2 text-xs font-medium hover:border-accent hover:text-accent-strong"
            data-testid="new-library"
          >
            <Icon name="plus" size={13} /> Библиотека
          </button>
        </div>
        <div className="flex gap-2">
          <select
            value={activeFilter}
            onChange={(e) => setFilter(e.target.value)}
            aria-label="Фильтр по исходнику"
            className="h-8 min-w-0 flex-1 rounded-md border border-line bg-white px-2 text-sm outline-none focus:border-accent"
          >
          <option value="all">Все исходники</option>
          {sources
            .filter((s) => sourceIds.has(s.id))
            .map((s) => (
              <option key={s.id} value={s.id}>
                {sourceLabel(s)}
              </option>
            ))}
          </select>
          <button
            type="button"
            onClick={() => (picking ? stopPicking() : setPicking(true))}
            disabled={!components.length && !picking}
            aria-pressed={picking}
            title="Удалить все компоненты или выбранные галочками"
            className={`inline-flex h-8 shrink-0 items-center gap-1 rounded-md border px-2 text-xs font-medium whitespace-nowrap disabled:opacity-40 ${
              picking ? 'border-accent bg-accent-soft text-accent-strong' : 'border-line hover:border-accent hover:text-accent-strong'
            }`}
            data-testid="library-clear"
          >
            <Icon name="eraser" size={13} /> Очистить
          </button>
        </div>
        {picking && (
          <div className="flex items-center gap-2 rounded-md bg-accent-soft/70 px-2 py-1.5 text-xs" data-testid="library-picking">
            <label className="flex cursor-pointer items-center gap-1.5 font-medium whitespace-nowrap">
              <input
                type="checkbox"
                checked={allVisiblePicked}
                onChange={(e) => togglePick(visible.map((c) => c.id), e.target.checked)}
                className="accent-accent"
                aria-label="Выбрать все"
              />
              Все
            </label>
            <span className="flex-1" />
            <button
              type="button"
              onClick={() => void removePicked()}
              disabled={!picked.size}
              className="rounded-md bg-rose-600 px-2 py-1 font-medium whitespace-nowrap text-white hover:bg-rose-700 disabled:opacity-40"
              data-testid="library-remove-picked"
            >
              Удалить ({picked.size})
            </button>
            <button type="button" onClick={stopPicking} className="rounded-md px-1.5 py-1 font-medium whitespace-nowrap text-muted hover:text-ink">
              Отмена
            </button>
          </div>
        )}
      </div>

      <div className="scroll-thin flex-1 space-y-1.5 overflow-y-auto px-3 pb-3">
        {sections.map(({ id, library, items }) => (
          <LibrarySection
            key={id}
            library={library}
            items={items}
            total={library ? components.filter((c) => c.libraryId === library.id).length : components.filter((c) => !c.libraryId).length}
            open={expanded.has(id)}
            onToggle={() => toggle(id)}
            renaming={renaming === id}
            onRename={() => setRenaming(id)}
            onRenameDone={() => setRenaming(null)}
            filtered={activeFilter !== 'all'}
            pick={
              picking
                ? {
                    state: items.length && items.every((c) => picked.has(c.id)) ? 'all' : items.some((c) => picked.has(c.id)) ? 'some' : 'none',
                    toggle: (on) => togglePick(items.map((c) => c.id), on),
                  }
                : null
            }
          >
            {items.map((c) => (
              <ComponentCard
                key={c.id}
                component={c}
                source={sourceLabel(sources.find((s) => s.id === c.sourceId))}
                usage={usage.get(c.id) ?? 0}
                onNewLibrary={createLibrary}
                picking={picking}
                picked={picked.has(c.id)}
                onPick={togglePick}
              />
            ))}
          </LibrarySection>
        ))}
      </div>
    </div>
  )
}

function LibrarySection({
  library,
  items,
  total,
  open,
  onToggle,
  renaming,
  onRename,
  onRenameDone,
  filtered,
  pick,
  children,
}: {
  library: Library | null
  items: Component[]
  total: number
  open: boolean
  onToggle: () => void
  renaming: boolean
  onRename: () => void
  onRenameDone: () => void
  filtered: boolean
  /** Режим «Очистить»: выбраны ли компоненты этой библиотеки и как переключить их все */
  pick: { state: 'none' | 'some' | 'all'; toggle: (on: boolean) => void } | null
  children: ReactNode
}) {
  const [dropping, setDropping] = useState(false)
  const name = library?.name ?? GENERAL_LIBRARY_NAME
  const libId = library?.id ?? null

  async function remove() {
    if (!library) return
    const ok = await confirmDialog({
      title: 'Удалить библиотеку?',
      message:
        `Библиотека «${library.name}» будет удалена.` +
        (total ? ` Компоненты из нее (${total}) переместятся в общую библиотеку — ничего не потеряется.` : ''),
      confirmText: 'Удалить',
      danger: true,
    })
    if (!ok) return
    useLibrary.getState().deleteLibrary(library.id)
    notify(`Библиотека «${library.name}» удалена`)
  }

  function menu(e: ReactMouseEvent) {
    e.preventDefault()
    const items: MenuItem[] = [{ label: open ? 'Свернуть' : 'Раскрыть', icon: 'layers', onSelect: onToggle }]
    if (library) {
      items.push(
        { label: 'Переименовать', icon: 'pencil', onSelect: onRename },
        'separator',
        { label: 'Удалить библиотеку', icon: 'trash', danger: true, onSelect: () => void remove() },
      )
    }
    openContextMenu(e.clientX, e.clientY, items)
  }

  const accepts = (e: ReactDragEvent) => e.dataTransfer.types.includes(COMPONENT_MIME)

  return (
    <section
      data-library={libId ?? 'general'}
      data-library-name={name}
      className={`rounded-lg border transition ${dropping ? 'border-accent bg-accent-soft/60' : 'border-transparent'}`}
      onDragOver={(e) => {
        if (!accepts(e)) return
        e.preventDefault()
        e.dataTransfer.dropEffect = 'move'
        if (!dropping) setDropping(true)
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDropping(false)
      }}
      onDrop={(e) => {
        setDropping(false)
        const id = e.dataTransfer.getData(COMPONENT_MIME)
        const comp = useLibrary.getState().components.find((c) => c.id === id)
        if (!comp || (comp.libraryId ?? null) === libId) return
        e.preventDefault()
        useLibrary.getState().moveComponent(id, libId)
        notify(`«${comp.name}» → «${name}»`)
        if (!open) onToggle()
      }}
    >
      <div className="group flex items-center gap-1 rounded-md px-1 py-1 hover:bg-workspace" onContextMenu={menu}>
        {pick && (
          <input
            type="checkbox"
            checked={pick.state === 'all'}
            ref={(el) => {
              if (el) el.indeterminate = pick.state === 'some'
            }}
            disabled={!items.length}
            onChange={(e) => pick.toggle(e.target.checked)}
            className="ml-0.5 accent-accent"
            aria-label={`Выбрать все в «${name}»`}
          />
        )}
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={open}
          className="flex min-w-0 flex-1 items-center gap-1.5 text-left text-sm"
          title={open ? 'Свернуть' : 'Раскрыть'}
        >
          <Icon name="parent" size={13} className={`shrink-0 text-muted transition ${open ? 'rotate-180' : 'rotate-90'}`} />
          <Icon name="folder" size={14} className={`shrink-0 ${library ? 'text-accent' : 'text-ink'}`} />
          {renaming && library ? (
            <RenameInput
              value={library.name}
              onDone={(value) => {
                if (value && value !== library.name) useLibrary.getState().renameLibrary(library.id, value)
                onRenameDone()
              }}
            />
          ) : (
            <span className={`truncate ${library ? '' : 'font-semibold'}`}>{name}</span>
          )}
          <span className="shrink-0 text-xs text-muted">{filtered ? `${items.length}/${total}` : total}</span>
        </button>
        {library && !renaming && (
          <span className="flex shrink-0 opacity-0 transition group-hover:opacity-100">
            <button
              type="button"
              title="Переименовать библиотеку"
              aria-label="Переименовать библиотеку"
              onClick={onRename}
              className="rounded p-1 text-muted hover:bg-accent-soft hover:text-accent-strong"
            >
              <Icon name="pencil" size={12} />
            </button>
            <button
              type="button"
              title="Удалить библиотеку"
              aria-label="Удалить библиотеку"
              onClick={() => void remove()}
              className="rounded p-1 text-muted hover:bg-rose-50 hover:text-rose-600"
            >
              <Icon name="trash" size={12} />
            </button>
          </span>
        )}
      </div>
      {open && (
        <ul className="space-y-2 px-0.5 pt-1 pb-1.5">
          {items.length ? (
            children
          ) : (
            <li className="rounded-lg border border-dashed border-line px-3 py-3 text-center text-xs leading-relaxed text-muted">
              {filtered
                ? 'Нет компонентов из этого исходника'
                : library
                  ? 'Пусто. Перетащите сюда компоненты из другой библиотеки'
                  : 'Откройте исходник слева, выделите компонент и сохраните'}
            </li>
          )}
        </ul>
      )}
    </section>
  )
}

function RenameInput({ value, onDone }: { value: string; onDone: (value: string) => void }) {
  const [draft, setDraft] = useState(value)
  return (
    <input
      autoFocus
      value={draft}
      aria-label="Название библиотеки"
      onFocus={(e) => e.currentTarget.select()}
      onClick={(e) => e.stopPropagation()}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => onDone(draft.trim())}
      onKeyDown={(e) => {
        if (e.key === 'Enter') e.currentTarget.blur()
        if (e.key === 'Escape') onDone(value)
      }}
      className="h-6 min-w-0 flex-1 rounded border border-accent bg-white px-1.5 text-sm outline-none"
    />
  )
}

const ComponentCard = memo(function ComponentCard({
  component: c,
  source,
  usage,
  onNewLibrary,
  picking,
  picked,
  onPick,
}: {
  component: Component
  source: string
  usage: number
  onNewLibrary: (moveComponentId?: string) => Library
  /** Режим «Очистить»: клик ставит галочку, а не добавляет на холст */
  picking: boolean
  picked: boolean
  onPick: (ids: string[], on: boolean) => void
}) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(c.name)

  function addToCanvas() {
    useUi.getState().closeSource()
    useScene.getState().addObject(c)
  }

  function commitRename() {
    const name = draft.trim()
    if (name && name !== c.name) useLibrary.getState().rename(c.id, name)
    setDraft(name || c.name)
    setEditing(false)
  }

  async function remove() {
    const ok = await confirmDialog(
      usage > 0
        ? {
            title: 'Компонент используется на холсте',
            message: `«${c.name}» стоит на холсте (${usage} шт.). Удалить компонент вместе с этими объектами? Сцена останется рабочей, остальные объекты не изменятся.`,
            confirmText: 'Удалить вместе с объектами',
            danger: true,
          }
        : {
            title: 'Удалить компонент?',
            message: `«${c.name}» будет удален из библиотеки.`,
            confirmText: 'Удалить',
            danger: true,
          },
    )
    if (!ok) return
    useScene.getState().purgeComponent(c.id)
    useLibrary.getState().remove(c.id)
    notify(`«${c.name}» удален`)
  }

  /** Второе меню на том же месте: куда переместить */
  function moveMenu(x: number, y: number) {
    const { libraries, moveComponent } = useLibrary.getState()
    const move = (id: string | null, name: string) => () => {
      moveComponent(c.id, id)
      notify(`«${c.name}» → «${name}»`)
    }
    openContextMenu(x, y, [
      { label: GENERAL_LIBRARY_NAME, icon: 'folder', disabled: !c.libraryId, onSelect: move(null, GENERAL_LIBRARY_NAME) },
      ...libraries.map(
        (l): MenuItem => ({ label: l.name, icon: 'folder', disabled: c.libraryId === l.id, onSelect: move(l.id, l.name) }),
      ),
      'separator',
      { label: 'Новая библиотека…', icon: 'plus', onSelect: () => onNewLibrary(c.id) },
    ])
  }

  return (
    <li
      data-component-id={c.id}
      data-name={c.name}
      draggable={!editing && !picking}
      onDragStart={(e) => {
        e.dataTransfer.setData(COMPONENT_MIME, c.id)
        e.dataTransfer.effectAllowed = 'copyMove'
      }}
      className={`group flex gap-2.5 rounded-lg border bg-white p-2 transition outline-accent hover:shadow-sm focus-visible:outline-2 ${
        picking
          ? `cursor-pointer ${picked ? 'border-rose-400 bg-rose-50/60' : 'border-line hover:border-rose-300'}`
          : 'cursor-grab border-line hover:border-accent/60 active:cursor-grabbing'
      }`}
      onClick={() => {
        if (picking) onPick([c.id], !picked)
        else if (!editing) addToCanvas()
      }}
      // С клавиатуры: Tab до карточки, Enter или пробел — на холст (в режиме «Очистить» — галочка), Shift+F10 — меню
      role={picking ? 'checkbox' : 'button'}
      aria-checked={picking ? picked : undefined}
      tabIndex={0}
      aria-label={picking ? c.name : `${c.name}: добавить на холст`}
      onKeyDown={(e) => {
        if (editing || e.target !== e.currentTarget || (e.key !== 'Enter' && e.key !== ' ')) return
        e.preventDefault()
        if (picking) onPick([c.id], !picked)
        else addToCanvas()
      }}
      onContextMenu={(e) => {
        e.preventDefault()
        if (editing || picking) return
        const { clientX: x, clientY: y } = e
        openContextMenu(x, y, [
          { label: 'Добавить на холст', icon: 'plus', onSelect: addToCanvas },
          { label: 'Переместить в…', icon: 'folder', onSelect: () => setTimeout(() => moveMenu(x, y)) },
          {
            label: 'Переименовать',
            icon: 'pencil',
            onSelect: () => {
              setDraft(c.name)
              setEditing(true)
            },
          },
          'separator',
          { label: 'Удалить', icon: 'trash', danger: true, onSelect: () => void remove() },
        ])
      }}
      title={picking ? 'Отметить для удаления' : 'Добавить на холст'}
    >
      {picking && (
        <span
          className={`mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center self-center rounded border ${
            picked ? 'border-rose-500 bg-rose-500 text-white' : 'border-line bg-white'
          }`}
          aria-hidden
        >
          {picked && <Icon name="check" size={12} />}
        </span>
      )}
      <div className="checker flex h-16 w-16 shrink-0 items-center justify-center overflow-hidden rounded-md border border-line p-1">
        <img src={componentPreview(c)} alt="" className="max-h-full max-w-full" draggable={false} />
      </div>
      <div className="flex min-w-0 flex-1 flex-col justify-center">
        {editing ? (
          <input
            autoFocus
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onClick={(e) => e.stopPropagation()}
            onBlur={commitRename}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commitRename()
              if (e.key === 'Escape') {
                setDraft(c.name)
                setEditing(false)
              }
            }}
            className="h-7 w-full rounded border border-accent px-1.5 text-sm outline-none"
            aria-label="Название компонента"
          />
        ) : (
          <div className="truncate text-sm font-medium" title={c.name}>
            {c.name}
          </div>
        )}
        <div className="truncate text-xs text-muted">из {source}</div>
        <div className="mt-0.5 text-[11px] text-muted">
          {Math.round(c.width)}×{Math.round(c.height)}
          {usage > 0 && <span className="ml-1.5 rounded bg-accent-soft px-1 text-accent-strong">на холсте: {usage}</span>}
        </div>
      </div>
      <div className={`flex shrink-0 flex-col gap-1 opacity-0 transition group-hover:opacity-100 focus-within:opacity-100 ${picking ? 'hidden' : ''}`}>
        <button
          type="button"
          title="Переименовать"
          aria-label="Переименовать"
          onClick={(e) => {
            e.stopPropagation()
            setDraft(c.name)
            setEditing(true)
          }}
          className="rounded p-1 text-muted hover:bg-accent-soft hover:text-accent-strong"
        >
          <Icon name="pencil" size={14} />
        </button>
        <button
          type="button"
          title="Удалить"
          aria-label="Удалить"
          onClick={(e) => {
            e.stopPropagation()
            void remove()
          }}
          className="rounded p-1 text-muted hover:bg-rose-50 hover:text-rose-600"
        >
          <Icon name="trash" size={14} />
        </button>
      </div>
    </li>
  )
})
