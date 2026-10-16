import { useMemo } from 'react'
import { useLibrary } from '../store/library'
import { useUi } from '../store/ui'

export function SourcesPanel() {
  const sources = useUi((s) => s.sources)
  const activeId = useUi((s) => s.extractSourceId)
  const openSource = useUi((s) => s.openSource)
  const components = useLibrary((s) => s.components)

  const counts = useMemo(() => {
    const m = new Map<string, number>()
    for (const c of components) m.set(c.sourceId, (m.get(c.sourceId) ?? 0) + 1)
    return m
  }, [components])

  return (
    <div className="flex h-full flex-col">
      <div className="px-4 pt-3 pb-2">
        <h2 className="text-xs font-semibold tracking-wide text-muted uppercase">Исходники</h2>
        <p className="mt-0.5 text-xs text-muted">Клик открывает режим выделения</p>
      </div>
      <ul className="scroll-thin grid flex-1 grid-cols-2 content-start gap-2 overflow-y-auto px-3 pb-3">
        {sources.map((s) => {
          const active = s.id === activeId
          const count = counts.get(s.id) ?? 0
          return (
            <li key={s.id}>
              <button
                type="button"
                data-source-id={s.id}
                onClick={() => openSource(s.id)}
                title={`${s.id} ${s.title}`}
                className={`group relative flex w-full flex-col overflow-hidden rounded-lg border text-left transition ${
                  active ? 'border-accent ring-2 ring-accent/30' : 'border-line hover:border-accent/60'
                }`}
              >
                <div className="relative aspect-[4/3] w-full bg-white">
                  <img
                    src={`/sources/${s.file}`}
                    alt=""
                    loading="lazy"
                    className="absolute inset-0 h-full w-full object-contain p-1.5"
                    draggable={false}
                  />
                </div>
                <div className="flex items-center gap-1 border-t border-line bg-white px-1.5 py-1">
                  <span className="text-[10px] font-semibold text-accent">{s.id}</span>
                  <span className="truncate text-[11px] leading-tight">{s.title}</span>
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
            </li>
          )
        })}
      </ul>
    </div>
  )
}
