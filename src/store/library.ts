import { create } from 'zustand'
import type { Component } from '../types'
import { saveComponents } from '../lib/storage'
import { notify } from './ui'

type LibraryState = {
  components: Component[]
  init: (list: Component[]) => void
  add: (c: Component) => void
  rename: (id: string, name: string) => void
  remove: (id: string) => void
}

function persist(list: Component[]) {
  saveComponents(list).catch((e: unknown) => {
    console.error(e)
    notify('Не удалось сохранить библиотеку в IndexedDB', 'error')
  })
}

export const useLibrary = create<LibraryState>()((set, get) => ({
  components: [],
  init: (components) => set({ components }),
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
}))

/** Стабильная карта id → компонент (пересчитывается только при изменении списка) */
let cache: { list: Component[]; map: Map<string, Component> } | null = null
export function componentMap(list: Component[]): Map<string, Component> {
  if (cache?.list !== list) cache = { list, map: new Map(list.map((c) => [c.id, c])) }
  return cache.map
}

export const useComponentMap = () => useLibrary((s) => componentMap(s.components))

// Хранилище с логикой нельзя подменить «на лету»: при его правке в dev перезагружаем страницу
// (сцена и библиотека в IndexedDB, ничего не теряется), иначе модули разъедутся по разным экземплярам
if (import.meta.hot) import.meta.hot.accept(() => location.reload())
