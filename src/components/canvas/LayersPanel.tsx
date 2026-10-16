import { useState } from 'react'
import { useComponentMap } from '../../store/library'
import { useScene } from '../../store/scene'
import { componentPreview } from '../../lib/componentPreview'
import { Icon } from '../Icon'
import { openContextMenu } from '../../store/contextMenu'
import { objectMenuItems } from './objectMenu'

const LAYER_MIME = 'application/x-scene-layer'

const positionIn = (el: Element, clientY: number): 'above' | 'below' => {
  const r = el.getBoundingClientRect()
  return clientY < r.top + r.height / 2 ? 'above' : 'below'
}

/** Список объектов сверху вниз (как в Figma); перетаскивание меняет порядок слоев. С клавиатуры: Tab, Enter */
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
        <ul
          className="scroll-thin flex-1 overflow-y-auto px-2 pb-2"
          data-testid="layers"
          // dragleave всплывает и с дочерних элементов строки — сбрасываем, только когда курсор ушел из списка
          onDragLeave={(e) => !e.currentTarget.contains(e.relatedTarget as Node | null) && setDrop(null)}
        >
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
                  const position = positionIn(e.currentTarget, e.clientY)
                  if (drop?.id !== o.id || drop.position !== position) setDrop({ id: o.id, position })
                }}
                onDrop={(e) => {
                  // Позиция — по точке отпускания, а не по индикатору: он мог не успеть обновиться
                  const id = e.dataTransfer.getData(LAYER_MIME)
                  if (id) useScene.getState().moveLayer(id, o.id, positionIn(e.currentTarget, e.clientY))
                  setDrop(null)
                }}
                onDragEnd={() => setDrop(null)}
                onClick={() => useScene.getState().select(o.id)}
                role="button"
                tabIndex={0}
                aria-pressed={active}
                aria-label={`Слой «${c?.name ?? 'компонент удален'}»`}
                onKeyDown={(e) => {
                  if (e.key !== 'Enter' && e.key !== ' ') return
                  e.preventDefault()
                  useScene.getState().select(o.id)
                }}
                onContextMenu={(e) => {
                  e.preventDefault()
                  useScene.getState().select(o.id)
                  openContextMenu(e.clientX, e.clientY, objectMenuItems(o.id))
                }}
                className={`relative flex cursor-pointer items-center gap-2 rounded-md px-1.5 py-1 text-sm outline-accent select-none focus-visible:outline-2 ${
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
