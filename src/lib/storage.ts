import { createStore, del, get, set } from 'idb-keyval'
import type { Component, Library, Scene, SceneObject, SourceMeta } from '../types'
import type { SourceObject } from './sources'

const store = createStore('svg-constructor', 'kv')

const KEYS = { components: 'components', scene: 'scene', userSources: 'userSources', libraries: 'libraries' } as const
export type StorageKey = (typeof KEYS)[keyof typeof KEYS]
/** Текст загруженного SVG хранится отдельно от списка: список маленький, файлы могут быть большими */
const sourceTextKey = (id: string) => `source:${id}`
/** Объекты исходника, поправленные пользователем («Объединить», «Отделить», «Назвать») */
const objectEditsKey = (id: string) => `objects:${id}`

/* ---------- Защита данных ---------- */

/**
 * Ключи, которые не удалось прочитать. Писать в них нельзя до перезагрузки: состояние в памяти пустое,
 * и первое же сохранение затерло бы данные, которые просто не прочитались
 */
const unreadable = new Set<StorageKey>()
export const unreadableKeys = () => [...unreadable]

async function read<T>(key: StorageKey): Promise<T | undefined> {
  try {
    return await get<T>(key, store)
  } catch (e) {
    unreadable.add(key)
    throw e
  }
}

/** Другие вкладки сервиса: после записи они перечитывают ключ, а не затирают его своей старой копией */
const channel = typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel('svg-constructor') : null

async function write(key: StorageKey, value: unknown) {
  if (unreadable.has(key)) return
  await set(key, value, store)
  channel?.postMessage({ key })
}

/** Подписка на изменения из других вкладок */
export function onExternalChange(listener: (key: StorageKey) => void): () => void {
  if (!channel) return () => {}
  const handler = (e: MessageEvent<{ key?: unknown }>) => {
    const key = e.data?.key
    if (typeof key === 'string' && (Object.values(KEYS) as string[]).includes(key)) listener(key as StorageKey)
  }
  channel.addEventListener('message', handler)
  return () => channel.removeEventListener('message', handler)
}

/* ---------- Проверка записей: битая запись отбрасывается, а не роняет загрузку ---------- */

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null
const str = (v: unknown): v is string => typeof v === 'string'
const finite = (v: unknown, fallback: number) => (typeof v === 'number' && Number.isFinite(v) ? v : fallback)
const listOf = <T>(raw: unknown, valid: (v: Record<string, unknown>) => T | null): T[] =>
  Array.isArray(raw) ? raw.flatMap((v) => (isObject(v) ? (valid(v) ?? []) : [])) : []

const toComponent = (c: Record<string, unknown>): Component | null =>
  str(c.id) && str(c.markup) && str(c.defs) && finite(c.width, 0) > 0 && finite(c.height, 0) > 0
    ? {
        id: c.id,
        name: str(c.name) ? c.name : 'Компонент',
        sourceId: str(c.sourceId) ? c.sourceId : '',
        width: c.width as number,
        height: c.height as number,
        defs: c.defs,
        markup: c.markup,
        createdAt: finite(c.createdAt, 0),
        ...(str(c.libraryId) ? { libraryId: c.libraryId } : {}),
      }
    : null

const toLibrary = (l: Record<string, unknown>): Library | null =>
  str(l.id) && str(l.name) ? { id: l.id, name: l.name, createdAt: finite(l.createdAt, 0) } : null

const toSceneObject = (o: Record<string, unknown>): SceneObject | null => {
  if (!str(o.id) || !str(o.componentId)) return null
  const scale = finite(o.scale, 1)
  return {
    id: o.id,
    componentId: o.componentId,
    x: finite(o.x, 0),
    y: finite(o.y, 0),
    scale,
    scaleY: finite(o.scaleY, scale),
    rotation: finite(o.rotation, 0),
    flipX: o.flipX === true,
  }
}

const toUserSource = (s: Record<string, unknown>): SourceMeta | null =>
  str(s.id) && str(s.title)
    ? { id: s.id, title: s.title, originalName: str(s.originalName) ? s.originalName : s.title, kind: 'user', createdAt: finite(s.createdAt, 0) }
    : null

/* ---------- Ключи ---------- */

export const loadComponents = async () => listOf(await read(KEYS.components), toComponent)
export const saveComponents = (list: Component[]) => write(KEYS.components, list)

export const loadLibraries = async () => listOf(await read(KEYS.libraries), toLibrary)
export const saveLibraries = (list: Library[]) => write(KEYS.libraries, list)

/** Сцена из хранилища; старые записи (без scaleY) и битые объекты приводятся к актуальной форме */
export async function loadScene(): Promise<Scene | null> {
  const raw = await read<unknown>(KEYS.scene)
  if (!isObject(raw) || !Array.isArray(raw.objects)) return null
  const size = (v: unknown, fallback: number) => (finite(v, 0) > 0 ? (v as number) : fallback)
  return { width: size(raw.width, 1200), height: size(raw.height, 800), objects: listOf(raw.objects, toSceneObject) }
}

export const saveScene = (scene: Scene) => write(KEYS.scene, scene)

export const loadUserSources = async () => listOf(await read(KEYS.userSources), toUserSource)
export const saveUserSources = (list: SourceMeta[]) => write(KEYS.userSources, list)
export const loadUserSourceText = (id: string) => get<string>(sourceTextKey(id), store)
export const saveUserSourceText = (id: string, text: string) => set(sourceTextKey(id), text, store)
export const deleteUserSourceText = (id: string) => del(sourceTextKey(id), store)

/** Разбиение исходника на объекты, исправленное пользователем; shapeCount защищает от смены файла */
export type ObjectEdits = { shapeCount: number; objects: SourceObject[] }
export const loadObjectEdits = (id: string) => get<ObjectEdits>(objectEditsKey(id), store)
export const saveObjectEdits = (id: string, edits: ObjectEdits) => set(objectEditsKey(id), edits, store)
export const deleteObjectEdits = (id: string) => del(objectEditsKey(id), store)
