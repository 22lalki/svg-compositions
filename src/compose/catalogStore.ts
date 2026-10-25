import { create } from 'zustand'
import { dropAssets, putAsset } from './assets'
import { BUILTIN_ITEMS, type Item, type VariantKey } from './catalog'
import { BUILTIN_SCHEMES, type Scheme } from './model'
import { saveItems, saveSchemes, type StoredItem } from './storage'

/** Объекты и цветовые схемы: встроенные + загруженные пользователем */
type CatalogState = {
  items: Item[]
  userItems: StoredItem[]
  schemes: Scheme[]
  init: (userItems: StoredItem[], userSchemes: Scheme[]) => void
  addItems: (list: StoredItem[]) => void
  updateItem: (id: string, patch: Pick<Item, 'name' | 'keywords'>) => void
  removeItem: (id: string) => void
  addScheme: (scheme: Scheme) => void
  removeScheme: (id: string) => void
}

const persistItems = (list: StoredItem[]) => saveItems(list).catch((e: unknown) => console.error('Не удалось сохранить объекты', e))
const persistSchemes = (list: Scheme[]) =>
  saveSchemes(list.filter((s) => !s.builtin)).catch((e: unknown) => console.error('Не удалось сохранить схемы', e))

function register(list: StoredItem[]) {
  for (const s of list) for (const [k, a] of Object.entries(s.assets)) if (a) putAsset(s.item.id, k as VariantKey, a)
}

export const useCatalog = create<CatalogState>()((set, get) => ({
  items: BUILTIN_ITEMS,
  userItems: [],
  schemes: BUILTIN_SCHEMES,

  init: (userItems, userSchemes) => {
    register(userItems)
    set({ userItems, items: [...BUILTIN_ITEMS, ...userItems.map((s) => s.item)], schemes: [...BUILTIN_SCHEMES, ...userSchemes] })
  },

  addItems: (list) => {
    register(list)
    const userItems = [...get().userItems, ...list]
    set({ userItems, items: [...BUILTIN_ITEMS, ...userItems.map((s) => s.item)] })
    void persistItems(userItems)
  },

  updateItem: (id, patch) => {
    const userItems = get().userItems.map((s) => (s.item.id === id ? { ...s, item: { ...s.item, ...patch } } : s))
    set({ userItems, items: [...BUILTIN_ITEMS, ...userItems.map((s) => s.item)] })
    void persistItems(userItems)
  },

  removeItem: (id) => {
    const userItems = get().userItems.filter((s) => s.item.id !== id)
    dropAssets(id)
    set({ userItems, items: [...BUILTIN_ITEMS, ...userItems.map((s) => s.item)] })
    void persistItems(userItems)
  },

  addScheme: (scheme) => {
    const schemes = [...get().schemes.filter((s) => s.id !== scheme.id), scheme]
    set({ schemes })
    void persistSchemes(schemes)
  },

  removeScheme: (id) => {
    const schemes = get().schemes.filter((s) => s.id !== id || s.builtin)
    set({ schemes })
    void persistSchemes(schemes)
  },
}))

export const lookupItem = (id: string): Item | undefined => useCatalog.getState().items.find((i) => i.id === id)

export function schemeById(id: string): Scheme {
  const { schemes } = useCatalog.getState()
  return schemes.find((s) => s.id === id) ?? schemes[0]!
}
