import { memo, useMemo, useState } from 'react'
import type { Component } from '../types'
import { standaloneSvg, svgDataUrl } from '../lib/svg'
import { useLibrary } from '../store/library'
import { useScene } from '../store/scene'
import { notify, sourceLabel, useUi } from '../store/ui'
import { Icon } from './Icon'
import { confirmDialog } from './ui'

export const COMPONENT_MIME = 'application/x-svg-component'

const previewCache = new WeakMap<Component, string>()
/** data:-URL превью компонента (изолированный <img>, id не пересекаются с холстом) */
export function componentPreview(c: Component): string {
  let url = previewCache.get(c)
  if (!url) {
    url = svgDataUrl(standaloneSvg(c))
    previewCache.set(c, url)
  }
  return url
}

export function LibraryPanel() {
  const components = useLibrary((s) => s.components)
  const sources = useUi((s) => s.sources)
  const objects = useScene((s) => s.scene.objects)
  const [filter, setFilter] = useState<string>('all')

  const usage = useMemo(() => {
    const m = new Map<string, number>()
    for (const o of objects) m.set(o.componentId, (m.get(o.componentId) ?? 0) + 1)
    return m
  }, [objects])

  const sourceIds = useMemo(() => new Set(components.map((c) => c.sourceId)), [components])
  const activeFilter = filter !== 'all' && !sourceIds.has(filter) ? 'all' : filter
  const visible = activeFilter === 'all' ? components : components.filter((c) => c.sourceId === activeFilter)

  return (
    <div className="flex h-full flex-col">
      <div className="space-y-2 px-4 pt-3 pb-3">
        <div className="flex items-baseline justify-between">
          <h2 className="text-xs font-semibold tracking-wide text-muted uppercase">Библиотека компонентов</h2>
          <span className="text-xs text-muted">{components.length}</span>
        </div>
        <select
          value={activeFilter}
          onChange={(e) => setFilter(e.target.value)}
          aria-label="Фильтр по исходнику"
          className="h-8 w-full rounded-md border border-line bg-white px-2 text-sm outline-none focus:border-accent"
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
      </div>

      {components.length === 0 ? (
        <div className="mx-4 rounded-lg border border-dashed border-line p-4 text-sm leading-relaxed text-muted">
          Библиотека пуста. Откройте исходник слева, обведите рамкой персонажа или предмет и нажмите «Сохранить в
          библиотеку».
        </div>
      ) : (
        <ul className="scroll-thin flex-1 space-y-2 overflow-y-auto px-3 pb-3">
          {visible.map((c) => (
            <ComponentCard
              key={c.id}
              component={c}
              source={sourceLabel(sources.find((s) => s.id === c.sourceId))}
              usage={usage.get(c.id) ?? 0}
            />
          ))}
        </ul>
      )}
      <p className="border-t border-line px-4 py-2 text-[11px] leading-snug text-muted">
        Клик — добавить в центр холста, перетаскивание — в нужное место.
      </p>
    </div>
  )
}

const ComponentCard = memo(function ComponentCard({
  component: c,
  source,
  usage,
}: {
  component: Component
  source: string
  usage: number
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

  return (
    <li
      data-component-id={c.id}
      data-name={c.name}
      draggable={!editing}
      onDragStart={(e) => {
        e.dataTransfer.setData(COMPONENT_MIME, c.id)
        e.dataTransfer.effectAllowed = 'copy'
      }}
      className="group flex cursor-grab gap-2.5 rounded-lg border border-line bg-white p-2 transition hover:border-accent/60 hover:shadow-sm active:cursor-grabbing"
      onClick={() => !editing && addToCanvas()}
      title="Добавить на холст"
    >
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
      <div className="flex shrink-0 flex-col gap-1 opacity-0 transition group-hover:opacity-100 focus-within:opacity-100">
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
