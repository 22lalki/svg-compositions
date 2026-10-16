import { createStore, del, get, set } from 'idb-keyval'
import type { Component, Library, Scene, SceneObject, SourceMeta } from '../types'
import type { SourceObject } from './sources'

const store = createStore('svg-constructor', 'kv')

const KEYS = { components: 'components', scene: 'scene', userSources: 'userSources', libraries: 'libraries' } as const
/** Текст загруженного SVG хранится отдельно от списка: список маленький, файлы могут быть большими */
const sourceTextKey = (id: string) => `source:${id}`
/** Объекты исходника, поправленные пользователем («Объединить», «Отделить», «Назвать») */
const objectEditsKey = (id: string) => `objects:${id}`

export async function loadComponents(): Promise<Component[]> {
  const list = await get<Component[]>(KEYS.components, store)
  return Array.isArray(list) ? list : []
}

export const saveComponents = (list: Component[]) => set(KEYS.components, list, store)

export async function loadLibraries(): Promise<Library[]> {
  const list = await get<Library[]>(KEYS.libraries, store)
  return Array.isArray(list) ? list : []
}

export const saveLibraries = (list: Library[]) => set(KEYS.libraries, list, store)

/** Сцена из хранилища; старые/битые записи приводятся к актуальной форме */
export async function loadScene(): Promise<Scene | null> {
  const raw = await get<Partial<Scene>>(KEYS.scene, store)
  if (!raw || !Array.isArray(raw.objects)) return null
  return {
    width: typeof raw.width === 'number' ? raw.width : 1200,
    height: typeof raw.height === 'number' ? raw.height : 800,
    objects: raw.objects.map((o: Partial<SceneObject>) => ({
      id: String(o.id),
      componentId: String(o.componentId),
      x: o.x ?? 0,
      y: o.y ?? 0,
      scale: o.scale ?? 1,
      scaleY: o.scaleY ?? o.scale ?? 1,
      rotation: o.rotation ?? 0,
      flipX: !!o.flipX,
    })),
  }
}

export const saveScene = (scene: Scene) => set(KEYS.scene, scene, store)

export async function loadUserSources(): Promise<SourceMeta[]> {
  const list = await get<SourceMeta[]>(KEYS.userSources, store)
  return Array.isArray(list) ? list.map((s) => ({ ...s, kind: 'user' as const })) : []
}

export const saveUserSources = (list: SourceMeta[]) => set(KEYS.userSources, list, store)
export const loadUserSourceText = (id: string) => get<string>(sourceTextKey(id), store)
export const saveUserSourceText = (id: string, text: string) => set(sourceTextKey(id), text, store)
export const deleteUserSourceText = (id: string) => del(sourceTextKey(id), store)

/** Разбиение исходника на объекты, исправленное пользователем; shapeCount защищает от смены файла */
export type ObjectEdits = { shapeCount: number; objects: SourceObject[] }
export const loadObjectEdits = (id: string) => get<ObjectEdits>(objectEditsKey(id), store)
export const saveObjectEdits = (id: string, edits: ObjectEdits) => set(objectEditsKey(id), edits, store)
export const deleteObjectEdits = (id: string) => del(objectEditsKey(id), store)
