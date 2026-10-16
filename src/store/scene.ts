import { create } from 'zustand'
import type { Component, Scene, SceneObject } from '../types'
import { shortId } from '../lib/ids'

export const HISTORY_LIMIT = 100
export const DEFAULT_SCENE: Scene = { width: 1200, height: 800, objects: [] }

export type LayerOp = 'front' | 'forward' | 'backward' | 'back'

type Recipe = (scene: Scene) => Scene

type SceneState = {
  scene: Scene
  past: Scene[]
  future: Scene[]
  selectedId: string | null
  /** Сцена на момент начала жеста (перетаскивание/масштаб/поворот): весь жест — один шаг истории */
  gestureBase: Scene | null
  lastCommit: { key: string; at: number } | null

  init: (scene: Scene) => void
  commit: (recipe: Recipe, coalesceKey?: string) => void
  beginGesture: () => void
  updateGesture: (recipe: Recipe) => void
  endGesture: () => void
  undo: () => void
  redo: () => void
  select: (id: string | null) => void

  addObject: (component: Component, center?: { x: number; y: number }) => string
  updateObject: (id: string, patch: Partial<SceneObject>, coalesceKey?: string) => void
  removeSelected: () => void
  duplicateSelected: () => void
  flipSelected: () => void
  reorderSelected: (op: LayerOp) => void
  moveLayer: (id: string, targetId: string, position: 'above' | 'below') => void
  setArtboard: (width: number, height: number) => void
  /** Удаление компонента из библиотеки: убрать его экземпляры из сцены и из всей истории */
  purgeComponent: (componentId: string) => void
}

const mapObject = (scene: Scene, id: string, fn: (o: SceneObject) => SceneObject): Scene => ({
  ...scene,
  objects: scene.objects.map((o) => (o.id === id ? fn(o) : o)),
})

const pushPast = (past: Scene[], scene: Scene) => [...past, scene].slice(-HISTORY_LIMIT)

export const useScene = create<SceneState>()((set, get) => ({
  scene: DEFAULT_SCENE,
  past: [],
  future: [],
  selectedId: null,
  gestureBase: null,
  lastCommit: null,

  init: (scene) => set({ scene, past: [], future: [], selectedId: null, gestureBase: null, lastCommit: null }),

  commit: (recipe, coalesceKey) => {
    const { scene, past, lastCommit, gestureBase } = get()
    if (gestureBase) return
    const next = recipe(scene)
    if (next === scene) return
    const now = Date.now()
    // Серия одинаковых мелких действий (сдвиг стрелками) склеивается в один шаг
    const coalesce = !!coalesceKey && lastCommit?.key === coalesceKey && now - lastCommit.at < 800
    set({
      scene: next,
      past: coalesce ? past : pushPast(past, scene),
      future: [],
      lastCommit: coalesceKey ? { key: coalesceKey, at: now } : null,
    })
  },

  beginGesture: () => set((s) => ({ gestureBase: s.scene })),
  updateGesture: (recipe) => {
    if (!get().gestureBase) return
    set((s) => ({ scene: recipe(s.scene) }))
  },
  endGesture: () => {
    const { gestureBase, scene, past } = get()
    if (!gestureBase) return
    if (gestureBase === scene) set({ gestureBase: null })
    else set({ gestureBase: null, past: pushPast(past, gestureBase), future: [], lastCommit: null })
  },

  undo: () => {
    const { past, future, scene, gestureBase, selectedId } = get()
    const prev = past[past.length - 1]
    if (gestureBase || !prev) return
    set({
      scene: prev,
      past: past.slice(0, -1),
      future: [scene, ...future],
      lastCommit: null,
      selectedId: prev.objects.some((o) => o.id === selectedId) ? selectedId : null,
    })
  },
  redo: () => {
    const { past, future, scene, gestureBase, selectedId } = get()
    const next = future[0]
    if (gestureBase || !next) return
    set({
      scene: next,
      past: pushPast(past, scene),
      future: future.slice(1),
      lastCommit: null,
      selectedId: next.objects.some((o) => o.id === selectedId) ? selectedId : null,
    })
  },

  select: (id) => set({ selectedId: id }),

  addObject: (component, center) => {
    const { scene } = get()
    const id = shortId()
    // Крупный компонент вписываем в артборд, мелкий оставляем в натуральную величину
    const fit = Math.min(1, (scene.width * 0.6) / component.width, (scene.height * 0.6) / component.height)
    const scale = Number(fit.toFixed(4))
    const c = center ?? { x: scene.width / 2, y: scene.height / 2 }
    const obj: SceneObject = {
      id,
      componentId: component.id,
      x: c.x - component.width / 2,
      y: c.y - component.height / 2,
      scale,
      scaleY: scale,
      rotation: 0,
      flipX: false,
    }
    get().commit((s) => ({ ...s, objects: [...s.objects, obj] }))
    set({ selectedId: id })
    return id
  },

  updateObject: (id, patch, coalesceKey) => get().commit((s) => mapObject(s, id, (o) => ({ ...o, ...patch })), coalesceKey),

  // Во время жеста (перетаскивание, ручки) правки не применяются — и выделение тоже не меняем
  removeSelected: () => {
    const { selectedId, gestureBase } = get()
    if (!selectedId || gestureBase) return
    get().commit((s) => ({ ...s, objects: s.objects.filter((o) => o.id !== selectedId) }))
    set({ selectedId: null })
  },

  duplicateSelected: () => {
    const { selectedId, scene, gestureBase } = get()
    const src = scene.objects.find((o) => o.id === selectedId)
    if (!src || gestureBase) return
    const copy: SceneObject = { ...src, id: shortId(), x: src.x + 20, y: src.y + 20 }
    get().commit((s) => {
      const objects = [...s.objects]
      objects.splice(objects.indexOf(src) + 1, 0, copy)
      return { ...s, objects }
    })
    set({ selectedId: copy.id })
  },

  flipSelected: () => {
    const { selectedId } = get()
    if (selectedId) get().commit((s) => mapObject(s, selectedId, (o) => ({ ...o, flipX: !o.flipX })))
  },

  reorderSelected: (op) => {
    const { selectedId } = get()
    if (!selectedId) return
    get().commit((s) => {
      const i = s.objects.findIndex((o) => o.id === selectedId)
      if (i < 0) return s
      const target = { front: s.objects.length - 1, back: 0, forward: Math.min(i + 1, s.objects.length - 1), backward: Math.max(i - 1, 0) }[op]
      if (target === i) return s
      const objects = [...s.objects]
      const [obj] = objects.splice(i, 1)
      objects.splice(target, 0, obj!)
      return { ...s, objects }
    })
  },

  moveLayer: (id, targetId, position) => {
    if (id === targetId) return
    get().commit((s) => {
      const obj = s.objects.find((o) => o.id === id)
      if (!obj) return s
      const rest = s.objects.filter((o) => o.id !== id)
      const t = rest.findIndex((o) => o.id === targetId)
      if (t < 0) return s
      rest.splice(position === 'above' ? t + 1 : t, 0, obj)
      return rest.every((o, i) => o === s.objects[i]) ? s : { ...s, objects: rest }
    })
  },

  setArtboard: (width, height) =>
    get().commit((s) => (s.width === width && s.height === height ? s : { ...s, width, height })),

  purgeComponent: (componentId) => {
    const strip = (s: Scene): Scene =>
      s.objects.some((o) => o.componentId === componentId)
        ? { ...s, objects: s.objects.filter((o) => o.componentId !== componentId) }
        : s
    const { scene, past, future, selectedId } = get()
    const next = strip(scene)
    // Шаги, которые касались только удаленного компонента, после чистки совпадают с соседними — убираем их,
    // иначе Ctrl+Z «ничего не делает»
    const same = (a: Scene, b: Scene) =>
      a.width === b.width && a.height === b.height && a.objects.length === b.objects.length && a.objects.every((o, i) => o === b.objects[i])
    const distinct = (list: Scene[], edge: Scene) =>
      list.filter((x, i) => !same(x, list[i + 1] ?? edge))
    const stripped = future.map(strip)
    set({
      scene: next,
      past: distinct(past.map(strip), next),
      future: distinct(stripped.reverse(), next).reverse(),
      gestureBase: null,
      lastCommit: null,
      selectedId: next.objects.some((o) => o.id === selectedId) ? selectedId : null,
    })
  },
}))

// Хранилище с логикой нельзя подменить «на лету»: при его правке в dev перезагружаем страницу
// (сцена и библиотека в IndexedDB, ничего не теряется), иначе модули разъедутся по разным экземплярам
if (import.meta.hot) import.meta.hot.accept(() => location.reload())
