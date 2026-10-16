import { useScene } from '../../store/scene'
import { mod, type MenuItem } from '../../store/contextMenu'

/** Контекстное меню объекта на холсте (и в панели слоев) */
export function objectMenuItems(id: string): MenuItem[] {
  const { objects } = useScene.getState().scene
  const index = objects.findIndex((o) => o.id === id)
  const isTop = index === objects.length - 1
  const isBottom = index === 0
  // Действие всегда применяется к объекту, по которому кликнули
  const run = (action: (s: ReturnType<typeof useScene.getState>) => void) => () => {
    const s = useScene.getState()
    if (!s.scene.objects.some((o) => o.id === id)) return // объект удалили, пока меню было открыто
    s.select(id)
    action(useScene.getState())
  }
  return [
    { label: 'Дублировать', icon: 'copy', shortcut: mod('D'), onSelect: run((s) => s.duplicateSelected()) },
    { label: 'Отразить по горизонтали', icon: 'flip', onSelect: run((s) => s.flipSelected()) },
    'separator',
    { label: 'На передний план', icon: 'front', disabled: isTop, onSelect: run((s) => s.reorderSelected('front')) },
    { label: 'Вперед', icon: 'forward', disabled: isTop, onSelect: run((s) => s.reorderSelected('forward')) },
    { label: 'Назад', icon: 'backward', disabled: isBottom, onSelect: run((s) => s.reorderSelected('backward')) },
    { label: 'На задний план', icon: 'back', disabled: isBottom, onSelect: run((s) => s.reorderSelected('back')) },
    'separator',
    { label: 'Удалить', icon: 'trash', shortcut: 'Delete', danger: true, onSelect: run((s) => s.removeSelected()) },
  ]
}
