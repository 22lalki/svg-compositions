import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { create } from 'zustand'
import { Icon, type IconName } from './Icon'

export type MenuItem =
  | {
      label: string
      icon?: IconName
      shortcut?: string
      danger?: boolean
      disabled?: boolean
      onSelect: () => void
    }
  | 'separator'

type MenuState = { x: number; y: number; items: MenuItem[]; onClose?: () => void } | null

const useMenuStore = create<{ menu: MenuState }>()(() => ({ menu: null }))

/** Открыть контекстное меню в точке курсора (координаты окна); onClose — при любом закрытии */
export function openContextMenu(x: number, y: number, items: MenuItem[], opts: { onClose?: () => void } = {}) {
  closeContextMenu()
  useMenuStore.setState({ menu: { x, y, items, onClose: opts.onClose } })
}

export function closeContextMenu() {
  const { menu } = useMenuStore.getState()
  if (!menu) return
  useMenuStore.setState({ menu: null })
  menu.onClose?.()
}
export const isContextMenuOpen = () => useMenuStore.getState().menu !== null

const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform)
/** Подпись сочетания с учетом платформы: mod('D') → Ctrl+D / ⌘D */
export const mod = (key: string) => (isMac ? `⌘${key}` : `Ctrl+${key}`)

const GAP = 4
/** Чуть в стороне от курсора: пункт под ним не подсвечивается сам, пока мышь не сдвинется */
const OFFSET = 2

export function ContextMenuHost() {
  const menu = useMenuStore((s) => s.menu)
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null)

  // Меню не должно уходить за край окна: при нехватке места открываем влево/вверх от курсора.
  // Как у системных меню, сначала ничего не подсвечено: первая ↓ выбирает первый пункт
  useLayoutEffect(() => {
    if (!menu || !ref.current) {
      setPos(null)
      return
    }
    const { width, height } = ref.current.getBoundingClientRect()
    const left =
      menu.x + OFFSET + width + GAP > window.innerWidth ? Math.max(GAP, menu.x - OFFSET - width) : menu.x + OFFSET
    const top =
      menu.y + OFFSET + height + GAP > window.innerHeight ? Math.max(GAP, menu.y - OFFSET - height) : menu.y + OFFSET
    setPos({ left, top })
  }, [menu])

  useEffect(() => {
    if (!menu) return
    const onPointerDown = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) closeContextMenu()
    }
    // Клавиши меню перехватываем раньше горячих клавиш холста
    const onKey = (e: KeyboardEvent) => {
      const items = Array.from(ref.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)') ?? [])
      const i = items.indexOf(document.activeElement as HTMLButtonElement)
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        const step = e.key === 'ArrowDown' ? 1 : -1
        items[(i + step + items.length) % items.length]?.focus()
      } else if (e.key === 'Enter' || e.key === ' ') {
        items[i]?.click()
      } else if (e.key === 'Escape' || e.key === 'Tab') {
        closeContextMenu()
      } else {
        closeContextMenu()
        return
      }
      e.preventDefault()
      e.stopPropagation()
    }
    window.addEventListener('pointerdown', onPointerDown, true)
    window.addEventListener('keydown', onKey, true)
    window.addEventListener('wheel', closeContextMenu, true)
    window.addEventListener('resize', closeContextMenu)
    window.addEventListener('blur', closeContextMenu)
    return () => {
      window.removeEventListener('pointerdown', onPointerDown, true)
      window.removeEventListener('keydown', onKey, true)
      window.removeEventListener('wheel', closeContextMenu, true)
      window.removeEventListener('resize', closeContextMenu)
      window.removeEventListener('blur', closeContextMenu)
    }
  }, [menu])

  if (!menu) return null
  return (
    <div
      ref={ref}
      role="menu"
      data-testid="context-menu"
      className="fixed z-50 min-w-52 rounded-lg border border-line bg-white py-1 text-sm shadow-xl"
      style={{ left: pos?.left ?? menu.x, top: pos?.top ?? menu.y, visibility: pos ? 'visible' : 'hidden' }}
      onContextMenu={(e) => e.preventDefault()}
    >
      {menu.items.map((item, i) =>
        item === 'separator' ? (
          <div key={i} className="my-1 h-px bg-line" />
        ) : (
          <button
            key={i}
            type="button"
            role="menuitem"
            disabled={item.disabled}
            onClick={() => {
              closeContextMenu()
              item.onSelect()
            }}
            onPointerMove={(e) => e.currentTarget !== document.activeElement && e.currentTarget.focus({ preventScroll: true })}
            className={`flex h-8 w-full items-center gap-2.5 px-3 text-left outline-none disabled:opacity-35 ${
              item.danger ? 'text-rose-600 focus:bg-rose-50' : 'text-ink focus:bg-accent-soft focus:text-accent-strong'
            }`}
          >
            <span className="flex w-4 shrink-0 justify-center">{item.icon && <Icon name={item.icon} size={14} />}</span>
            <span className="flex-1">{item.label}</span>
            {item.shortcut && <span className="pl-4 text-xs text-muted">{item.shortcut}</span>}
          </button>
        ),
      )}
    </div>
  )
}
