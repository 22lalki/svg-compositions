import { create } from 'zustand'
import type { Component, Library } from '../types'
import { shortId } from '../lib/ids'
import { saveComponents, saveLibraries } from '../lib/storage'
import { notify } from './ui'

export const GENERAL_LIBRARY_NAME = 'Общая библиотека'

const SAVE_TARGET_KEY = 'svg-constructor:save-target'

type LibraryState = {
  components: Component[]
  /** Пользовательские библиотеки; общая — это компоненты без libraryId */
  libraries: Library[]
  /** Куда сохранять новые компоненты из режима выделения: id библиотеки или null — общая */
  saveTarget: string | null
  init: (components: Component[], libraries: Library[]) => void
  add: (c: Component) => void
  rename: (id: string, name: string) => void
  remove: (id: string) => void
  /** Удаление нескольких компонентов разом (одна запись в IndexedDB) */
  removeMany: (ids: string[]) => void
  moveComponent: (id: string, libraryId: string | null) => void
  createLibrary: (name?: string) => Library
  renameLibrary: (id: string, name: string) => void
  /** Удаление библиотеки: ее компоненты переезжают в общую */
  deleteLibrary: (id: string) => void
  setSaveTarget: (libraryId: string | null) => void
}

function persist(list: Component[]) {
  saveComponents(list).catch((e: unknown) => {
    console.error(e)
    notify('Не удалось сохранить библиотеку в IndexedDB', 'error')
  })
}

function persistLibraries(list: Library[]) {
  saveLibraries(list).catch((e: unknown) => {
    console.error(e)
    notify('Не удалось сохранить список библиотек', 'error')
  })
}

function readSaveTarget(): string | null {
  try {
    return localStorage.getItem(SAVE_TARGET_KEY)
  } catch {
    return null
  }
}

function uniqueName(base: string, taken: string[]): string {
  if (!taken.includes(base)) return base
  for (let n = 2; ; n++) if (!taken.includes(`${base} ${n}`)) return `${base} ${n}`
}

export const useLibrary = create<LibraryState>()((set, get) => ({
  components: [],
  libraries: [],
  saveTarget: null,
  init: (components, libraries) => {
    const ids = new Set(libraries.map((l) => l.id))
    const target = readSaveTarget()
    set({
      // Ссылка на исчезнувшую библиотеку (сбой записи) — компонент считается в общей
      components: components.map((c) => (c.libraryId && !ids.has(c.libraryId) ? { ...c, libraryId: undefined } : c)),
      libraries,
      saveTarget: target && ids.has(target) ? target : null,
    })
  },
  add: (c) => {
    const components = [c, ...get().components]
    set({ components })
    persist(components)
  },
  rename: (id, name) => {
    const components = get().components.map((c) => (c.id === id ? { ...c, name } : c))
    set({ components })
    persist(components)
  },
  remove: (id) => {
    const components = get().components.filter((c) => c.id !== id)
    set({ components })
    persist(components)
  },
  removeMany: (ids) => {
    const gone = new Set(ids)
    const components = get().components.filter((c) => !gone.has(c.id))
    set({ components })
    persist(components)
  },
  moveComponent: (id, libraryId) => {
    const components = get().components.map((c) => (c.id === id ? { ...c, libraryId: libraryId ?? undefined } : c))
    set({ components })
    persist(components)
  },
  createLibrary: (name) => {
    const lib: Library = {
      id: shortId(),
      name: uniqueName(name?.trim() || 'Новая библиотека', get().libraries.map((l) => l.name)),
      createdAt: Date.now(),
    }
    const libraries = [...get().libraries, lib]
    set({ libraries })
    persistLibraries(libraries)
    return lib
  },
  renameLibrary: (id, name) => {
    const libraries = get().libraries.map((l) => (l.id === id ? { ...l, name } : l))
    set({ libraries })
    persistLibraries(libraries)
  },
  deleteLibrary: (id) => {
    const { components: current, saveTarget } = get()
    const libraries = get().libraries.filter((l) => l.id !== id)
    const moved = current.some((c) => c.libraryId === id)
    const components = moved ? current.map((c) => (c.libraryId === id ? { ...c, libraryId: undefined } : c)) : current
    set({ libraries, components, saveTarget: saveTarget === id ? null : saveTarget })
    persistLibraries(libraries)
    if (moved) persist(components)
  },
  setSaveTarget: (saveTarget) => {
    set({ saveTarget })
    try {
      if (saveTarget) localStorage.setItem(SAVE_TARGET_KEY, saveTarget)
      else localStorage.removeItem(SAVE_TARGET_KEY)
    } catch {
      // настройка удобства: без localStorage просто не запомнится
    }
  },
}))

/** Стабильная карта id → компонент (пересчитывается только при изменении списка) */
let cache: { list: Component[]; map: Map<string, Component> } | null = null
export function componentMap(list: Component[]): Map<string, Component> {
  if (cache?.list !== list) cache = { list, map: new Map(list.map((c) => [c.id, c])) }
  return cache.map
}

export const useComponentMap = () => useLibrary((s) => componentMap(s.components))

export const libraryName = (libraries: Library[], id: string | null | undefined) =>
  (id && libraries.find((l) => l.id === id)?.name) || GENERAL_LIBRARY_NAME

// Хранилище с логикой нельзя подменить «на лету»: при его правке в dev перезагружаем страницу
// (сцена и библиотека в IndexedDB, ничего не теряется), иначе модули разъедутся по разным экземплярам
if (import.meta.hot) import.meta.hot.accept(() => location.reload())
