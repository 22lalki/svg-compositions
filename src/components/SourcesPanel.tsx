import { memo, useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react'
import type { SourceMeta } from '../types'
import { sourceThumbUrl } from '../lib/sources'
import { confirmDialog } from '../store/confirm'
import { openContextMenu, type MenuItem } from '../store/contextMenu'
import { useLibrary } from '../store/library'
import { notify, useUi } from '../store/ui'
import { uploadSvgFiles } from '../store/userSources'
import { Icon } from './Icon'

export function SourcesPanel() {
  const builtin = useUi((s) => s.builtinSources)
  const user = useUi((s) => s.userSources)
  const activeId = useUi((s) => s.extractSourceId)
  const components = useLibrary((s) => s.components)
  const inputRef = useRef<HTMLInputElement>(null)
  const [busy, setBusy] = useState(false)

  const counts = useMemo(() => {
    const m = new Map<string, number>()
    for (const c of components) m.set(c.sourceId, (m.get(c.sourceId) ?? 0) + 1)
    return m
  }, [components])

  async function upload(files: File[]) {
    if (!files.length) return
    setBusy(true)
    try {
      const added = await uploadSvgFiles(files)
      if (added.length === 1) useUi.getState().openSource(added[0]!.id)
    } finally {
      setBusy(false)
    }
  }

  const pickFiles = () => inputRef.current?.click()

  return (
    <div className="flex h-full flex-col">
      <div className="px-4 pt-3 pb-1">
        <h2 className="text-xs font-semibold tracking-wide text-muted uppercase">Исходники</h2>
        <input
          ref={inputRef}
          type="file"
          accept=".svg,image/svg+xml"
          multiple
          hidden
          data-testid="upload-input"
          onChange={(e) => {
            const files = Array.from(e.target.files ?? [])
            e.target.value = ''
            void upload(files)
          }}
        />
      </div>

      <div className="scroll-thin flex-1 overflow-y-auto px-3 pb-3">
        <SectionTitle title="Мои SVG" count={user.length} hint="в этом браузере" />
        <ul className="grid grid-cols-2 gap-2" data-testid="user-sources">
          {/* Загрузка — всегда первой строкой, на ширину двух карточек */}
          <li className="col-span-2">
            <button
              type="button"
              onClick={pickFiles}
              disabled={busy}
              data-testid="upload-tile"
              className="flex h-14 w-full items-center justify-center gap-2 rounded-lg border border-dashed border-line px-3 text-[11px] leading-tight text-muted transition hover:border-accent hover:text-accent-strong disabled:opacity-50"
            >
              <Icon name="upload" size={16} className="shrink-0" />
              <span>{busy ? 'Загрузка…' : 'Загрузите SVG или перетащите файл в окно'}</span>
            </button>
          </li>
          {user.map((s) => (
            <SourceCard key={s.id} meta={s} active={s.id === activeId} count={counts.get(s.id) ?? 0} />
          ))}
        </ul>

        <SectionTitle title="Встроенные" count={builtin.length} hint="общие для всех" />
        <ul className="grid grid-cols-2 gap-2" data-testid="builtin-sources">
          {builtin.map((s) => (
            <SourceCard key={s.id} meta={s} active={s.id === activeId} count={counts.get(s.id) ?? 0} />
          ))}
        </ul>
      </div>
    </div>
  )
}

function SectionTitle({ title, count, hint }: { title: string; count: number; hint: string }) {
  return (
    <div className="mt-3 mb-1.5 flex items-baseline gap-1.5 px-1 first:mt-1">
      <span className="text-[11px] font-semibold text-ink">{title}</span>
      <span className="text-[11px] text-muted">{count}</span>
      <span className="ml-auto truncate text-[10px] text-muted">{hint}</span>
    </div>
  )
}

/** Превью исходника: для загруженных — blob: из IndexedDB */
function useThumb(meta: SourceMeta): string | null {
  const [url, setUrl] = useState<string | null>(meta.kind === 'builtin' ? `/sources/${meta.file}` : null)
  useEffect(() => {
    let alive = true
    sourceThumbUrl(meta)
      .then((u) => alive && setUrl(u))
      .catch(() => alive && setUrl(null))
    return () => {
      alive = false
    }
  }, [meta])
  return url
}

const SourceCard = memo(function SourceCard({ meta, active, count }: { meta: SourceMeta; active: boolean; count: number }) {
  const thumb = useThumb(meta)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(meta.title)
  const isUser = meta.kind === 'user'
  const open = () => useUi.getState().openSource(meta.id)

  function commitRename() {
    const title = draft.trim()
    if (title && title !== meta.title) useUi.getState().renameUserSource(meta.id, title)
    setDraft(title || meta.title)
    setEditing(false)
  }

  async function remove() {
    const ok = await confirmDialog({
      title: 'Удалить загруженный SVG?',
      message:
        `«${meta.title}» будет удален из «Моих SVG».` +
        (count ? ` Компоненты, извлеченные из него (${count}), останутся в библиотеке и на холсте.` : ''),
      confirmText: 'Удалить',
      danger: true,
    })
    if (!ok) return
    useUi.getState().removeUserSource(meta.id)
    notify(`«${meta.title}» удален`)
  }

  function menu(e: ReactMouseEvent) {
    e.preventDefault()
    const items: MenuItem[] = [{ label: 'Открыть для выделения', icon: 'marquee', onSelect: open }]
    if (isUser) {
      items.push(
        {
          label: 'Переименовать',
          icon: 'pencil',
          onSelect: () => {
            setDraft(meta.title)
            setEditing(true)
          },
        },
        'separator',
        { label: 'Удалить', icon: 'trash', danger: true, onSelect: () => void remove() },
      )
    }
    openContextMenu(e.clientX, e.clientY, items)
  }

  return (
    <li className="group relative">
      <button
        type="button"
        data-source-id={meta.id}
        onClick={() => !editing && open()}
        onContextMenu={menu}
        title={isUser ? `${meta.title} (${meta.originalName})` : `${meta.id} ${meta.title}`}
        className={`relative flex w-full flex-col overflow-hidden rounded-lg border text-left transition ${
          active ? 'border-accent ring-2 ring-accent/30' : 'border-line hover:border-accent/60'
        }`}
      >
        <div className={`relative aspect-[4/3] w-full ${isUser ? 'checker' : 'bg-white'}`}>
          {thumb && (
            <img
              src={thumb}
              alt=""
              loading="lazy"
              className="absolute inset-0 h-full w-full object-contain p-1.5"
              draggable={false}
            />
          )}
        </div>
        <div className="flex min-h-[22px] items-center gap-1 border-t border-line bg-white px-1.5 py-1">
          {isUser ? (
            <Icon name="folder" size={10} className="shrink-0 text-accent" />
          ) : (
            <span className="text-[10px] font-semibold text-accent">{meta.id}</span>
          )}
          {!editing && <span className="truncate text-[11px] leading-tight">{meta.title}</span>}
        </div>
        {count > 0 && (
          <span
            className="absolute top-1 right-1 rounded-full bg-accent px-1.5 text-[10px] leading-4 font-semibold text-white"
            title={`Компонентов в библиотеке: ${count}`}
          >
            {count}
          </span>
        )}
      </button>
      {editing && (
        <input
          autoFocus
          value={draft}
          aria-label="Название исходника"
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commitRename}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commitRename()
            if (e.key === 'Escape') {
              setDraft(meta.title)
              setEditing(false)
            }
          }}
          className="absolute right-1 bottom-1 left-5 h-5 rounded border border-accent bg-white px-1 text-[11px] outline-none"
        />
      )}
      {isUser && !editing && (
        <button
          type="button"
          title="Удалить загруженный SVG"
          aria-label="Удалить загруженный SVG"
          onClick={() => void remove()}
          className="absolute top-1 left-1 hidden rounded bg-white/90 p-0.5 text-muted shadow-sm group-hover:block hover:text-rose-600"
        >
          <Icon name="trash" size={12} />
        </button>
      )}
    </li>
  )
})
