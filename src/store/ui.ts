import { create } from 'zustand'
import type { SourceMeta } from '../types'

export type Toast = { id: number; text: string; kind: 'info' | 'error' }

type UiState = {
  sources: SourceMeta[]
  /** Открытый в режиме выделения исходник; null — показан холст */
  extractSourceId: string | null
  toasts: Toast[]
  setSources: (s: SourceMeta[]) => void
  openSource: (id: string) => void
  closeSource: () => void
}

export const useUi = create<UiState>()((set) => ({
  sources: [],
  extractSourceId: null,
  toasts: [],
  setSources: (sources) => set({ sources }),
  openSource: (id) => set({ extractSourceId: id }),
  closeSource: () => set({ extractSourceId: null }),
}))

let toastSeq = 0
export function notify(text: string, kind: Toast['kind'] = 'info') {
  const id = ++toastSeq
  useUi.setState((s) => ({ toasts: [...s.toasts, { id, text, kind }].slice(-3) }))
  setTimeout(() => useUi.setState((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })), 3200)
}

export const sourceLabel = (s: SourceMeta | undefined) => (s ? `${s.id} ${s.title}` : 'неизвестный исходник')

// Хранилище с логикой нельзя подменить «на лету»: при его правке в dev перезагружаем страницу
// (сцена и библиотека в IndexedDB, ничего не теряется), иначе модули разъедутся по разным экземплярам
if (import.meta.hot) import.meta.hot.accept(() => location.reload())
