import { create } from 'zustand'
import { shortId } from '../lib/ids'
import { itemSize, type Item } from './catalog'
import { lookupItem, schemeById } from './catalogStore'
import { arrangements, relayout, visibleShare, type Arrangement } from './layout'
import {
  DEFAULT_COMPOSITION,
  isBgKey,
  schemeBgColors,
  resolveKey,
  formatSize,
  type CObject,
  type Composition,
  type DecorKind,
  type FormatKey,
  type ObjState,
  type ColorKey,
  type Role,
  type SizeKey,
} from './model'

export const HISTORY_LIMIT = 100

export type LayerOp = 'front' | 'forward' | 'backward' | 'back'
type Recipe = (c: Composition) => Composition

/** Последняя автосборка: какие объекты и какой вариант раскладки показан («Другой вариант» листает дальше) */
/** Набор объектов для сборки и пояснение, почему он такой (показывается под кнопкой, когда набор на холсте) */
export type ObjectSet = { itemIds: string[]; note?: string; hero?: string }

/**
 * Последняя автосборка. Наборов может быть несколько (метафору можно передать разными объектами):
 * «Другой» листает entries — наборы и их раскладки вперемешку, чтобы менялись и объекты, и расположение
 */
export type Generation = {
  label: string
  sets: ObjectSet[]
  entries: Array<{ set: number; arr: number }>
  index: number
  total: number
}

type State = {
  comp: Composition
  past: Composition[]
  future: Composition[]
  selected: string[]
  gestureBase: Composition | null
  lastCommit: { key: string; at: number } | null
  generation: Generation | null

  init: (c: Composition) => void
  commit: (recipe: Recipe, coalesceKey?: string) => void
  beginGesture: () => void
  updateGesture: (recipe: Recipe) => void
  endGesture: () => void
  undo: () => void
  redo: () => void

  /** Выделить объект; объединенные выделяются всей группой. additive — добавить к выделению (Shift) */
  select: (id: string | null, additive?: boolean) => void
  selectAll: () => void

  /** Собрать композицию из объектов: вариант раскладки index (по умолчанию лучший) */
  generate: (itemIds: string[], label: string, index?: number) => boolean
  /** Собрать из нескольких наборов: «Другой» чередует наборы и их раскладки */
  generateSets: (sets: ObjectSet[], label: string, index?: number) => boolean
  nextVariant: (step?: number) => void

  setFormat: (format: FormatKey) => void
  setSize: (size: SizeKey) => void
  setScheme: (schemeId: string) => void
  setDecor: (decor: DecorKind) => void
  toggleMirror: () => void

  addItem: (itemId: string, at?: { x: number; y: number }) => void
  nudgeSelected: (dx: number, dy: number) => void
  rotateSelected: (delta: number) => void
  setRotation: (id: string, rotation: number) => void
  duplicateSelected: () => void
  removeSelected: () => void
  reorderSelected: (op: LayerOp) => void
  moveLayer: (id: string, targetId: string, position: 'above' | 'below') => void
  groupSelected: () => void
  ungroupSelected: () => void
  setState: (id: string, state: ObjState) => void
  setColor: (id: string, role: Role, target: ColorKey | null) => void
  resetColors: (id: string) => void
  clear: () => void
  /** Объект удален из каталога: убрать его экземпляры из сцены и истории */
  purgeItem: (itemId: string) => void
}

const pushPast = (past: Composition[], c: Composition) => [...past, c].slice(-HISTORY_LIMIT)
const round2 = (v: number) => Math.round(v * 100) / 100

/** Группа целиком: выделение объекта из группы — это выделение всех ее объектов */
export function expandGroups(c: Composition, ids: Iterable<string>): string[] {
  const set = new Set(ids)
  const groups = new Set(c.objects.filter((o) => set.has(o.id) && o.groupId).map((o) => o.groupId))
  return c.objects.filter((o) => set.has(o.id) || (o.groupId && groups.has(o.groupId))).map((o) => o.id)
}

/** Центр выделения — точка поворота нескольких объектов */
function selectionCenter(c: Composition, ids: Set<string>) {
  let x0 = Infinity
  let y0 = Infinity
  let x1 = -Infinity
  let y1 = -Infinity
  for (const o of c.objects) {
    if (!ids.has(o.id)) continue
    const s = sizeOf(c, o)
    x0 = Math.min(x0, o.x)
    y0 = Math.min(y0, o.y)
    x1 = Math.max(x1, o.x + s.width)
    y1 = Math.max(y1, o.y + s.height)
  }
  return { x: (x0 + x1) / 2, y: (y0 + y1) / 2 }
}

export function sizeOf(c: Pick<Composition, 'size'>, o: Pick<CObject, 'itemId' | 'state'>) {
  const item = lookupItem(o.itemId)
  return (item && itemSize(item, c.size, o.state)) ?? { width: 100, height: 100 }
}

function applyArrangement(c: Composition, a: Arrangement): Composition {
  const objects: CObject[] = []
  const slots: Record<string, number> = {}
  for (const p of a.placements) {
    const id = shortId()
    objects.push({ id, itemId: p.itemId, state: p.state, x: p.x, y: p.y, rotation: 0, colors: { ...p.colors } })
    if (p.slot !== null) slots[id] = p.slot
  }
  return {
    ...c,
    decor: a.decor,
    mirror: a.mirror,
    layout: a.templateId ? { templateId: a.templateId, mirror: a.mirror, slots } : null,
    objects,
  }
}

/** Ручная правка объекта: он больше не следует за ячейкой шаблона при смене формата */
const detach = (c: Composition, ids: Set<string>): Composition['layout'] => {
  if (!c.layout || ![...ids].some((id) => id in c.layout!.slots)) return c.layout
  return { ...c.layout, slots: Object.fromEntries(Object.entries(c.layout.slots).filter(([id]) => !ids.has(id))) }
}

const itemsOf = (ids: string[]) => ids.flatMap((id) => lookupItem(id) ?? [])

/**
 * Варианты последней сборки: «Другой» листает их без пересчета (пересчет — до сотен миллисекунд).
 * Ключ — объекты, формат, размер и видимость фона в схеме
 */
const arrangementCache = new Map<string, Arrangement[]>()
function cachedArrangements(itemIds: string[], comp: Composition, hero?: string, budget?: number): Arrangement[] {
  const noBg = !bgVisible(comp.schemeId)
  const key = JSON.stringify([itemIds, comp.format, comp.size, noBg, hero])
  let list = arrangementCache.get(key)
  if (!list) {
    list = arrangements(itemsOf(itemIds), comp.format, comp.size, undefined, { noBg, hero, budget })
    if (arrangementCache.size >= 16) arrangementCache.delete(arrangementCache.keys().next().value!)
    arrangementCache.set(key, list)
  }
  return list
}

/** Не больше стольких вариантов в «Другом» при нескольких наборах */
const MAX_ENTRIES = 16

/**
 * Наборы и раскладки вперемешку: по одной раскладке каждого набора за круг (первым — лучший вариант первого набора).
 * Внутри круга соседние варианты берут разные шаблоны: иначе у разных наборов лучшая раскладка часто одна и та же,
 * и «Другой» меняет объекты, но не расположение
 */
function buildEntries(sets: ObjectSet[], comp: Composition): Generation['entries'] {
  // Расчет синхронный: первому (показываемому) набору — полный бюджет доводки, остальным — меньше,
  // чтобы сборка из нескольких наборов не подвешивала вкладку
  const lists = sets.map((x, i) => cachedArrangements(x.itemIds, comp, x.hero, i === 0 ? undefined : 120))
  const used = lists.map(() => new Set<number>())
  const entries: Generation['entries'] = []
  const layoutKey = (a: Arrangement) => `${a.templateId}:${a.mirror}`
  while (entries.length < MAX_ENTRIES && lists.some((l, s) => used[s]!.size < l.length)) {
    const round = new Set<string>()
    lists.forEach((l, set) => {
      if (entries.length >= MAX_ENTRIES) return
      const free = l.map((_, i) => i).filter((i) => !used[set]!.has(i))
      if (!free.length) return
      // Первый вариант первого набора — всегда лучший; дальше — первый не повторяющий шаблон круга (из трех ближайших)
      const arr = entries.length === 0 ? free[0]! : (free.slice(0, 3).find((i) => !round.has(layoutKey(l[i]!))) ?? free[0]!)
      used[set]!.add(arr)
      round.add(layoutKey(l[arr]!))
      entries.push({ set, arr })
    })
  }
  return entries
}

/** Фоновый объект виден, только если в схеме хотя бы два разных цвета фона (вместе с белым) */
const bgVisible = (schemeId: string) => schemeBgColors(schemeById(schemeId)).length >= 2

export const useComposition = create<State>()((set, get) => ({
  comp: DEFAULT_COMPOSITION,
  past: [],
  future: [],
  selected: [],
  gestureBase: null,
  lastCommit: null,
  generation: null,

  init: (comp) => set({ comp, past: [], future: [], selected: [], gestureBase: null, lastCommit: null, generation: null }),

  commit: (recipe, coalesceKey) => {
    const { comp, past, lastCommit, gestureBase } = get()
    if (gestureBase) return
    const next = recipe(comp)
    if (next === comp) return
    const now = Date.now()
    // Серия одинаковых мелких действий (сдвиг стрелками) — один шаг истории
    const coalesce = !!coalesceKey && lastCommit?.key === coalesceKey && now - lastCommit.at < 800
    const alive = new Set(next.objects.map((o) => o.id))
    set({
      comp: next,
      past: coalesce ? past : pushPast(past, comp),
      future: [],
      lastCommit: coalesceKey ? { key: coalesceKey, at: now } : null,
      selected: get().selected.filter((id) => alive.has(id)),
    })
  },

  beginGesture: () => set((s) => ({ gestureBase: s.comp })),
  updateGesture: (recipe) => {
    if (get().gestureBase) set((s) => ({ comp: recipe(s.comp) }))
  },
  endGesture: () => {
    const { gestureBase, comp, past } = get()
    if (!gestureBase) return
    if (gestureBase === comp) set({ gestureBase: null })
    else set({ gestureBase: null, past: pushPast(past, gestureBase), future: [], lastCommit: null })
  },

  undo: () => {
    const { past, future, comp, gestureBase, selected } = get()
    const prev = past[past.length - 1]
    if (gestureBase || !prev) return
    const alive = new Set(prev.objects.map((o) => o.id))
    set({ comp: prev, past: past.slice(0, -1), future: [comp, ...future], lastCommit: null, selected: selected.filter((id) => alive.has(id)) })
  },
  redo: () => {
    const { past, future, comp, gestureBase, selected } = get()
    const next = future[0]
    if (gestureBase || !next) return
    const alive = new Set(next.objects.map((o) => o.id))
    set({ comp: next, past: pushPast(past, comp), future: future.slice(1), lastCommit: null, selected: selected.filter((id) => alive.has(id)) })
  },

  select: (id, additive = false) => {
    const { comp, selected } = get()
    if (!id) {
      set({ selected: [] })
      return
    }
    const group = expandGroups(comp, [id])
    if (!additive) set({ selected: group })
    else if (selected.includes(id)) set({ selected: selected.filter((x) => !group.includes(x)) })
    else set({ selected: expandGroups(comp, [...selected, ...group]) })
  },
  selectAll: () => set((s) => ({ selected: s.comp.objects.map((o) => o.id) })),

  generate: (itemIds, label, index = 0) => get().generateSets([{ itemIds }], label, index),

  generateSets: (sets, label, index = 0) => {
    const { comp, gestureBase } = get()
    if (gestureBase) return false
    const entries = buildEntries(sets, comp)
    if (!entries.length) return false
    const i = ((index % entries.length) + entries.length) % entries.length
    const e = entries[i]!
    const a = cachedArrangements(sets[e.set]!.itemIds, comp, sets[e.set]!.hero)[e.arr]!
    get().commit((c) => applyArrangement(c, a))
    set({ selected: [], generation: { label, sets, entries, index: i, total: entries.length } })
    return true
  },

  nextVariant: (step = 1) => {
    const g = get().generation
    if (g) get().generateSets(g.sets, g.label, g.index + step)
  },

  setFormat: (format) => {
    const { comp } = get()
    if (comp.format === format) return
    get().commit((c) => ({ ...c, format, ...relayout(c, { format, size: c.size }, lookupItem) }))
    // Число вариантов зависит от формата: листаем заново с текущего
    const g = get().generation
    if (g) {
      const entries = buildEntries(g.sets, get().comp)
      set({ generation: entries.length ? { ...g, entries, index: 0, total: entries.length } : null })
    }
  },

  setSize: (size) => {
    if (get().comp.size === size) return
    get().commit((c) => ({ ...c, size, ...relayout(c, { format: c.format, size }, lookupItem) }))
  },

  setScheme: (schemeId) => get().commit((c) => (c.schemeId === schemeId ? c : { ...c, schemeId })),
  setDecor: (decor) => get().commit((c) => (c.decor === decor ? c : { ...c, decor })),
  toggleMirror: () => get().commit((c) => ({ ...c, mirror: !c.mirror })),

  addItem: (itemId, at) => {
    const item = lookupItem(itemId)
    const { comp, gestureBase } = get()
    if (!item || gestureBase) return
    const s = itemSize(item, comp.size, 'main')
    if (!s) return
    const frame = formatSize(comp.format, comp.size)
    // Без точки сброса — в центр, а каждый следующий со сдвигом, чтобы не лег ровно поверх
    const n = comp.objects.filter((o) => o.itemId === itemId).length
    const c = at ?? { x: frame.width / 2 + n * 24, y: frame.height / 2 + n * 24 }
    const id = shortId()
    const obj: CObject = { id, itemId, state: 'main', x: round2(c.x - s.width / 2), y: round2(c.y - s.height / 2), rotation: 0, colors: {} }
    get().commit((x) => ({ ...x, objects: [...x.objects, obj] }))
    set({ selected: [id] })
  },

  nudgeSelected: (dx, dy) => {
    const ids = new Set(get().selected)
    if (!ids.size) return
    get().commit(
      (c) => ({
        ...c,
        layout: detach(c, ids),
        objects: c.objects.map((o) => (ids.has(o.id) ? { ...o, x: round2(o.x + dx), y: round2(o.y + dy) } : o)),
      }),
      `nudge:${[...ids].join()}`,
    )
  },

  rotateSelected: (delta) => {
    const ids = new Set(get().selected)
    if (!ids.size) return
    get().commit((c) => rotateObjects(c, ids, delta))
  },

  setRotation: (id, rotation) =>
    get().commit((c) => ({ ...c, objects: c.objects.map((o) => (o.id === id ? { ...o, rotation: normalizeAngle(rotation) } : o)) })),

  duplicateSelected: () => {
    const { selected, comp, gestureBase } = get()
    if (!selected.length || gestureBase) return
    const ids = new Set(selected)
    // Копия группы — новая группа
    const groupMap = new Map<string, string>()
    const copies: CObject[] = comp.objects
      .filter((o) => ids.has(o.id))
      .map((o) => {
        let groupId = o.groupId
        if (groupId) {
          if (!groupMap.has(groupId)) groupMap.set(groupId, shortId())
          groupId = groupMap.get(groupId)
        }
        return { ...o, id: shortId(), x: round2(o.x + 24), y: round2(o.y + 24), ...(groupId ? { groupId } : {}) }
      })
    const top = Math.max(...comp.objects.map((o, i) => (ids.has(o.id) ? i : -1)))
    get().commit((c) => {
      const objects = [...c.objects]
      objects.splice(top + 1, 0, ...copies)
      return { ...c, objects }
    })
    set({ selected: copies.map((o) => o.id) })
  },

  removeSelected: () => {
    const { selected, gestureBase } = get()
    if (!selected.length || gestureBase) return
    const ids = new Set(selected)
    get().commit((c) => (c.objects.some((o) => ids.has(o.id)) ? { ...c, layout: detach(c, ids), objects: c.objects.filter((o) => !ids.has(o.id)) } : c))
    set({ selected: [] })
  },

  reorderSelected: (op) => {
    const ids = new Set(get().selected)
    if (!ids.size) return
    get().commit((c) => reorder(c, ids, op))
  },

  moveLayer: (id, targetId, position) => {
    const { comp } = get()
    const moving = new Set(expandGroups(comp, [id]))
    if (moving.has(targetId)) return
    get().commit((c) => {
      const block = c.objects.filter((o) => moving.has(o.id))
      const rest = c.objects.filter((o) => !moving.has(o.id))
      // Цель внутри группы — вставляем за пределами группы, чтобы не разорвать ее
      const target = rest.find((o) => o.id === targetId)
      if (!target) return c
      const members = target.groupId ? rest.filter((o) => o.groupId === target.groupId) : [target]
      const at = position === 'above' ? rest.indexOf(members[members.length - 1]!) + 1 : rest.indexOf(members[0]!)
      rest.splice(at, 0, ...block)
      return rest.every((o, i) => o === c.objects[i]) ? c : { ...c, objects: rest }
    })
  },

  groupSelected: () => {
    const { selected } = get()
    if (selected.length < 2) return
    const ids = new Set(selected)
    const groupId = shortId()
    get().commit((c) => {
      // Объекты группы — подряд, на месте верхнего из них
      const members = c.objects.filter((o) => ids.has(o.id)).map((o) => ({ ...o, groupId }))
      const top = c.objects.findLastIndex((o) => ids.has(o.id))
      const before = c.objects.slice(0, top + 1).filter((o) => !ids.has(o.id))
      const after = c.objects.slice(top + 1)
      return { ...c, objects: [...before, ...members, ...after] }
    })
  },

  ungroupSelected: () => {
    const ids = new Set(get().selected)
    get().commit((c) =>
      c.objects.some((o) => ids.has(o.id) && o.groupId)
        ? { ...c, objects: c.objects.map((o) => (ids.has(o.id) && o.groupId ? { ...o, groupId: undefined } : o)) }
        : c,
    )
  },

  setState: (id, state) =>
    get().commit((c) => {
      const o = c.objects.find((x) => x.id === id)
      if (!o || o.state === state) return c
      // Без фонового варианта фоновым не сделать: показался бы цветной файл в роли фонового
      if (state === 'bg' && !lookupItem(o.itemId)?.variants[`${c.size}-bg`]) return c
      // Варианты одного размера совпадают по рамке; перекраска сбрасывается: у вариантов разные цвета
      return { ...c, objects: c.objects.map((x) => (x.id === id ? { ...x, state, colors: {} } : x)) }
    }),

  setColor: (id, role, target) =>
    get().commit((c) => {
      const o = c.objects.find((x) => x.id === id)
      if (!o) return c
      const scheme = schemeById(c.schemeId)
      if (target && o.state === 'bg' && !isBgKey(target, scheme)) return c // правило схемы: фоновому — только цвета фона
      const colors = { ...o.colors }
      // Выбран цвет, на который роль ложится и так, — это не перекраска
      if (!target || resolveKey(target, scheme) === resolveKey(role, scheme)) delete colors[role]
      else colors[role] = resolveKey(target, scheme)
      return { ...c, objects: c.objects.map((x) => (x.id === id ? { ...x, colors } : x)) }
    }),

  resetColors: (id) =>
    get().commit((c) => ({ ...c, objects: c.objects.map((x) => (x.id === id && Object.keys(x.colors).length ? { ...x, colors: {} } : x)) })),

  clear: () => {
    if (get().gestureBase) return
    get().commit((c) => (c.objects.length ? { ...c, objects: [], layout: null } : c))
    set({ selected: [], generation: null })
  },

  purgeItem: (itemId) => {
    const strip = (c: Composition): Composition =>
      c.objects.some((o) => o.itemId === itemId) ? { ...c, objects: c.objects.filter((o) => o.itemId !== itemId) } : c
    const { comp, past, future } = get()
    const next = strip(comp)
    const alive = new Set(next.objects.map((o) => o.id))
    set({
      comp: next,
      past: past.map(strip),
      future: future.map(strip),
      gestureBase: null,
      lastCommit: null,
      selected: get().selected.filter((id) => alive.has(id)),
      generation: get().generation?.sets.some((x) => x.itemIds.includes(itemId)) ? null : get().generation,
    })
  },
}))

export function normalizeAngle(deg: number): number {
  let a = deg % 360
  if (a <= -180) a += 360
  if (a > 180) a -= 360
  return Object.is(a, -0) ? 0 : Math.round(a * 100) / 100
}

/** Поворот нескольких объектов вокруг общего центра: центры поворачиваются, углы прибавляются */
export function rotateObjects(c: Composition, ids: Set<string>, delta: number, center = selectionCenter(c, ids)): Composition {
  const r = (delta * Math.PI) / 180
  const cos = Math.cos(r)
  const sin = Math.sin(r)
  return {
    ...c,
    layout: ids.size > 1 ? detach(c, ids) : c.layout,
    objects: c.objects.map((o) => {
      if (!ids.has(o.id)) return o
      const s = sizeOf(c, o)
      const cx = o.x + s.width / 2 - center.x
      const cy = o.y + s.height / 2 - center.y
      const nx = center.x + cx * cos - cy * sin
      const ny = center.y + cx * sin + cy * cos
      return { ...o, x: round2(nx - s.width / 2), y: round2(ny - s.height / 2), rotation: normalizeAngle(o.rotation + delta) }
    }),
  }
}

/** Порядок слоев для выделения (группы двигаются целиком, соседняя группа перешагивается целиком) */
function reorder(c: Composition, ids: Set<string>, op: LayerOp): Composition {
  const sel = c.objects.filter((o) => ids.has(o.id))
  const rest = c.objects.filter((o) => !ids.has(o.id))
  if (!sel.length || !rest.length) return c
  let at: number
  if (op === 'front') at = rest.length
  else if (op === 'back') at = 0
  else {
    // Позиция блока среди остальных; шаг — до следующего (предыдущего) объекта или целой группы
    const firstSel = c.objects.findIndex((o) => ids.has(o.id))
    let pos = c.objects.slice(0, firstSel).filter((o) => !ids.has(o.id)).length
    if (op === 'forward') {
      const next = rest[pos]
      if (!next) return c
      pos += next.groupId ? rest.filter((o) => o.groupId === next.groupId).length : 1
    } else {
      const prev = rest[pos - 1]
      if (!prev) return c
      pos -= prev.groupId ? rest.filter((o) => o.groupId === prev.groupId).length : 1
    }
    at = pos
  }
  const objects = [...rest.slice(0, at), ...sel, ...rest.slice(at)]
  return objects.every((o, i) => o === c.objects[i]) ? c : { ...c, objects }
}

/** Видимая доля объекта в кадре — для предупреждения «объект почти за кадром» */
export function objectVisibility(c: Composition, o: CObject): number {
  const item: Item | undefined = lookupItem(o.itemId)
  const s = item && itemSize(item, c.size, o.state)
  return s ? visibleShare(o.x, o.y, s, formatSize(c.format, c.size)) : 1
}
