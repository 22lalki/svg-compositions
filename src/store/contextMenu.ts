import { create } from 'zustand'
import type { IconName } from '../components/Icon'
import { keepAcrossHmr } from '../lib/hmr'

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

export type MenuState = { x: number; y: number; items: MenuItem[]; onClose?: () => void } | null

export const useContextMenu = keepAcrossHmr(import.meta.hot, 'store', () =>
  create<{ menu: MenuState }>()(() => ({ menu: null })),
)

/** Открыть контекстное меню в точке курсора (координаты окна); onClose — при любом закрытии */
export function openContextMenu(x: number, y: number, items: MenuItem[], opts: { onClose?: () => void } = {}) {
  closeContextMenu()
  useContextMenu.setState({ menu: { x, y, items, onClose: opts.onClose } })
}

export function closeContextMenu() {
  const { menu } = useContextMenu.getState()
  if (!menu) return
  useContextMenu.setState({ menu: null })
  menu.onClose?.()
}

export const isContextMenuOpen = () => useContextMenu.getState().menu !== null

const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform)
/** Подпись сочетания с учетом платформы: mod('D') → Ctrl+D / ⌘D */
export const mod = (key: string) => (isMac ? `⌘${key}` : `Ctrl+${key}`)
