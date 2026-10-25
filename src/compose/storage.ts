import { createStore, get, set } from 'idb-keyval'
import type { Item } from './catalog'
import type { Asset } from './assets'
import { DEFAULT_COMPOSITION, FORMAT_KEYS, ROLES, normalizeColor, schemeFromRoles, type CObject, type Composition, type Role, type Scheme } from './model'

/**
 * Хранение режима «Композиции» в IndexedDB браузера: сцена, свои цветовые схемы, загруженные объекты.
 * Записи проверяются при чтении: битая запись отбрасывается, а не роняет загрузку.
 * Если ключ не прочитался, писать в него нельзя до перезагрузки — иначе пустое состояние затерло бы данные.
 */
const store = createStore('svg-constructor-compose', 'kv')
const unreadable = new Set<string>()
export const composeUnreadable = () => [...unreadable]

async function read<T>(key: string): Promise<T | undefined> {
  try {
    return await get<T>(key, store)
  } catch (e) {
    unreadable.add(key)
    throw e
  }
}
async function write(key: string, value: unknown) {
  if (!unreadable.has(key)) await set(key, value, store)
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null
const str = (v: unknown): v is string => typeof v === 'string'
const num = (v: unknown, fallback: number) => (typeof v === 'number' && Number.isFinite(v) ? v : fallback)
const isRole = (v: unknown): v is Role => (ROLES as readonly unknown[]).includes(v)
/** Цвет схемы: ключ bgN/accentN или имя роли (так записаны ранние сохранения) */
const isColorKey = (v: unknown): v is string => isRole(v) || (typeof v === 'string' && /^(bg|obj)\.\d+$/.test(v))

function toObject(o: unknown): CObject | null {
  if (!isObj(o) || !str(o.id) || !str(o.itemId)) return null
  const colors: Partial<Record<Role, string>> = {}
  if (isObj(o.colors)) for (const [k, v] of Object.entries(o.colors)) if (isRole(k) && isColorKey(v)) colors[k] = v
  return {
    id: o.id,
    itemId: o.itemId,
    state: o.state === 'bg' ? 'bg' : 'main',
    x: num(o.x, 0),
    y: num(o.y, 0),
    rotation: num(o.rotation, 0),
    colors,
    ...(str(o.groupId) ? { groupId: o.groupId } : {}),
  }
}

function toComposition(raw: unknown): Composition | null {
  if (!isObj(raw) || !Array.isArray(raw.objects)) return null
  const layout = isObj(raw.layout) && str(raw.layout.templateId) && isObj(raw.layout.slots)
    ? {
        templateId: raw.layout.templateId,
        mirror: raw.layout.mirror === true,
        slots: Object.fromEntries(Object.entries(raw.layout.slots).filter(([, v]) => typeof v === 'number')) as Record<string, number>,
      }
    : null
  return {
    size: raw.size === 'S' ? 'S' : 'L',
    format: (FORMAT_KEYS as readonly unknown[]).includes(raw.format) ? (raw.format as Composition['format']) : DEFAULT_COMPOSITION.format,
    schemeId: str(raw.schemeId) ? raw.schemeId : DEFAULT_COMPOSITION.schemeId,
    decor: raw.decor === 'wedge' || raw.decor === 'none' ? raw.decor : 'circles',
    mirror: raw.mirror === true,
    layout,
    objects: raw.objects.flatMap((o) => toObject(o) ?? []),
  }
}

function toScheme(raw: unknown): Scheme | null {
  if (!isObj(raw) || !str(raw.id) || !str(raw.name)) return null
  const color = (c: unknown) => (str(c) ? normalizeColor(c) : null)
  const list = (v: unknown) => (Array.isArray(v) ? v.map(color) : [])
  // Ранний формат — восемь ролей
  if (isObj(raw.colors)) {
    const colors = {} as Record<Role, string>
    for (const r of ROLES) {
      const n = color(raw.colors[r])
      if (!n) return null
      colors[r] = n
    }
    return schemeFromRoles(raw.id, raw.name, colors)
  }
  const bg = list(raw.bg)
  const accents = list(raw.accents)
  const black = color(raw.black)
  const white = color(raw.white)
  if (!bg.length || bg.includes(null) || accents.includes(null) || !black || !white) return null
  return { id: raw.id, name: raw.name, bg: bg as string[], accents: accents as string[], black, white }
}

/** Загруженный объект: описание + файлы вариантов */
export type StoredItem = { item: Item; assets: Partial<Record<string, Asset>> }

function toStoredItem(raw: unknown): StoredItem | null {
  if (!isObj(raw) || !isObj(raw.item) || !isObj(raw.assets)) return null
  const i = raw.item
  if (!str(i.id) || !str(i.name)) return null
  const assets: Partial<Record<string, Asset>> = {}
  const variants: Item['variants'] = {}
  for (const [k, a] of Object.entries(raw.assets)) {
    if (!/^[LS]-(main|bg)$/.test(k) || !isObj(a) || !str(a.markup) || num(a.width, 0) <= 0 || num(a.height, 0) <= 0) continue
    const asset = { width: a.width as number, height: a.height as number, markup: a.markup }
    assets[k] = asset
    variants[k as keyof Item['variants']] = { width: asset.width, height: asset.height }
  }
  if (!Object.keys(assets).length) return null
  const list = (v: unknown) => (Array.isArray(v) ? v.filter(str) : [])
  return {
    item: { id: i.id, name: i.name, names: list(i.names), keywords: list(i.keywords), related: [], builtin: false, variants, createdAt: num(i.createdAt, 0) },
    assets,
  }
}

export async function loadComposition() {
  return toComposition(await read('composition'))
}
export const saveComposition = (c: Composition) => write('composition', c)

export async function loadSchemes() {
  const raw = await read<unknown>('schemes')
  return Array.isArray(raw) ? raw.flatMap((s) => toScheme(s) ?? []) : []
}
export const saveSchemes = (list: Scheme[]) => write('schemes', list.map(({ builtin: _b, ...s }) => s))

export async function loadItems() {
  const raw = await read<unknown>('items')
  return Array.isArray(raw) ? raw.flatMap((s) => toStoredItem(s) ?? []) : []
}
export const saveItems = (list: StoredItem[]) => write('items', list)

/** Ключ Claude API — только в этом браузере (localStorage), на сервер сервиса не уходит: сервера нет */
const KEY_NAME = 'svg-constructor:anthropic-key'
export function loadApiKey(): string {
  try {
    return localStorage.getItem(KEY_NAME) ?? ''
  } catch {
    return ''
  }
}
export function saveApiKey(key: string) {
  try {
    if (key) localStorage.setItem(KEY_NAME, key)
    else localStorage.removeItem(KEY_NAME)
  } catch {
    /* приватный режим: ключ живет до перезагрузки */
  }
}
