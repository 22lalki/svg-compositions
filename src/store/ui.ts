import { create } from 'zustand'
import type { SourceMeta } from '../types'
import { deleteObjectEdits, deleteUserSourceText, saveUserSources } from '../lib/storage'
import { releaseSourceThumb } from '../lib/sources'

export type Toast = { id: number; text: string; kind: 'info' | 'error' }

type UiState = {
  /** Встроенная библиотека (public/sources) — общая для всех пользователей */
  builtinSources: SourceMeta[]
  /** Загруженные пользователем SVG — только в этом браузере */
  userSources: SourceMeta[]
  /** Все исходники для поиска по id: сначала встроенные, затем загруженные */
  sources: SourceMeta[]
  /** Открытый в режиме выделения исходник; null — показан холст */
  extractSourceId: string | null
  toasts: Toast[]
  initSources: (builtin: SourceMeta[], user: SourceMeta[]) => void
  addUserSources: (list: SourceMeta[]) => void
  renameUserSource: (id: string, title: string) => void
  removeUserSource: (id: string) => void
  openSource: (id: string) => void
  closeSource: () => void
}

function persistUserSources(list: SourceMeta[]) {
  saveUserSources(list).catch((e: unknown) => {
    console.error(e)
    notify('Не удалось сохранить список загруженных SVG', 'error')
  })
}

export const useUi = create<UiState>()((set, get) => ({
  builtinSources: [],
  userSources: [],
  sources: [],
  extractSourceId: null,
  toasts: [],
  initSources: (builtinSources, userSources) =>
    set({ builtinSources, userSources, sources: [...builtinSources, ...userSources] }),
  addUserSources: (list) => {
    const userSources = [...list, ...get().userSources]
    set({ userSources, sources: [...get().builtinSources, ...userSources] })
    persistUserSources(userSources)
  },
  renameUserSource: (id, title) => {
    const userSources = get().userSources.map((s) => (s.id === id ? { ...s, title } : s))
    set({ userSources, sources: [...get().builtinSources, ...userSources] })
    persistUserSources(userSources)
  },
  removeUserSource: (id) => {
    const userSources = get().userSources.filter((s) => s.id !== id)
    set((s) => ({
      userSources,
      sources: [...s.builtinSources, ...userSources],
      extractSourceId: s.extractSourceId === id ? null : s.extractSourceId,
    }))
    persistUserSources(userSources)
    deleteUserSourceText(id).catch((e: unknown) => console.error(e))
    deleteObjectEdits(id).catch((e: unknown) => console.error(e))
    releaseSourceThumb(id)
  },
  openSource: (id) => set({ extractSourceId: id }),
  closeSource: () => set({ extractSourceId: null }),
}))

let toastSeq = 0
export function notify(text: string, kind: Toast['kind'] = 'info') {
  const id = ++toastSeq
  useUi.setState((s) => ({ toasts: [...s.toasts, { id, text, kind }].slice(-3) }))
  setTimeout(() => useUi.setState((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })), 3200)
}

/** «07 Звездное окно» для встроенных, название файла — для загруженных */
export const sourceLabel = (s: SourceMeta | undefined) =>
  s ? (s.kind === 'builtin' ? `${s.id} ${s.title}` : s.title) : 'удаленный исходник'

// Хранилище с логикой нельзя подменить «на лету»: при его правке в dev перезагружаем страницу
// (сцена и библиотека в IndexedDB, ничего не теряется), иначе модули разъедутся по разным экземплярам
if (import.meta.hot) import.meta.hot.accept(() => location.reload())
