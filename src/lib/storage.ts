import { createStore, get, set } from 'idb-keyval'
import type { Component, Scene, SceneObject } from '../types'

const store = createStore('svg-constructor', 'kv')

const KEYS = { components: 'components', scene: 'scene' } as const

export async function loadComponents(): Promise<Component[]> {
  const list = await get<Component[]>(KEYS.components, store)
  return Array.isArray(list) ? list : []
}

export const saveComponents = (list: Component[]) => set(KEYS.components, list, store)

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
