import { useState } from 'react'
import { useComponentMap } from '../../store/library'
import { useScene } from '../../store/scene'
import { componentPreview } from '../LibraryPanel'
import { Icon } from '../Icon'

const LAYER_MIME = 'application/x-scene-layer'

/** Список объектов сверху вниз (как в Figma); перетаскивание меняет порядок слоев */
export function LayersPanel() {
  const objects = useScene((s) => s.scene.objects)
  const selectedId = useScene((s) => s.selectedId)
  const components = useComponentMap()
  const [drop, setDrop] = useState<{ id: string; position: 'above' | 'below' } | null>(null)

  const rows = [...objects].reverse()

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-1.5 px-3 pt-3 pb-2">
        <Icon name="layers" size={14} className="text-muted" />
        <h2 className="text-xs font-semibold tracking-wide text-muted uppercase">Слои</h2>
        <span className="ml-auto text-xs text-muted">{objects.length}</span>
      </div>
      {rows.length === 0 ? (
        <p className="px-3 text-xs text-muted">Пока пусто</p>
      ) : (
        <ul className="scroll-thin flex-1 overflow-y-auto px-2 pb-2" data-testid="layers" onDragLeave={() => setDrop(null)}>
          {rows.map((o) => {
            const c = components.get(o.componentId)
            const active = o.id === selectedId
            return (
              <li
                key={o.id}
                data-layer-id={o.id}
                draggable
                onDragStart={(e) => {
                  e.dataTransfer.setData(LAYER_MIME, o.id)
                  e.dataTransfer.effectAllowed = 'move'
                }}
                onDragOver={(e) => {
                  if (!e.dataTransfer.types.includes(LAYER_MIME)) return
                  e.preventDefault()
                  const r = e.currentTarget.getBoundingClientRect()
                  const position = e.clientY < r.top + r.height / 2 ? 'above' : 'below'
                  if (drop?.id !== o.id || drop.position !== position) setDrop({ id: o.id, position })
                }}
                onDrop={(e) => {
                  const id = e.dataTransfer.getData(LAYER_MIME)
                  if (id && drop) useScene.getState().moveLayer(id, o.id, drop.position)
                  setDrop(null)
                }}
                onDragEnd={() => setDrop(null)}
                onClick={() => useScene.getState().select(o.id)}
                className={`relative flex cursor-pointer items-center gap-2 rounded-md px-1.5 py-1 text-sm select-none ${
                  active ? 'bg-accent-soft text-accent-strong' : 'hover:bg-workspace'
                }`}
              >
                {drop?.id === o.id && (
                  <span
                    className={`pointer-events-none absolute right-1 left-1 h-0.5 rounded bg-accent ${
                      drop.position === 'above' ? '-top-px' : '-bottom-px'
                    }`}
                  />
                )}
                <Icon name="grip" size={12} className="shrink-0 cursor-grab text-muted/70" />
                <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded border border-line bg-white p-0.5">
                  {c && <img src={componentPreview(c)} alt="" className="max-h-full max-w-full" draggable={false} />}
                </div>
                <span className="min-w-0 flex-1 truncate" title={c?.name}>
                  {c?.name ?? 'компонент удален'}
                </span>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
