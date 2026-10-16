import { useEffect, useState } from 'react'
import type { Scene, SourceMeta } from './types'
import {
  loadComponents,
  loadLibraries,
  loadScene,
  loadUserSources,
  onExternalChange,
  saveScene,
  unreadableKeys,
} from './lib/storage'
import { useLibrary } from './store/library'
import { DEFAULT_SCENE, useScene } from './store/scene'
import { notify, useUi } from './store/ui'
import { SourcesPanel } from './components/SourcesPanel'
import { LibraryPanel } from './components/LibraryPanel'
import { CanvasView } from './components/canvas/CanvasView'
import { ExtractView } from './components/extract/ExtractView'
import { ConfirmHost, Toasts } from './components/ui'
import { ContextMenuHost } from './components/ContextMenu'
import { FileDropOverlay } from './components/FileDropOverlay'

const failed =
  <T,>(fallback: T) =>
  (e: unknown): T => {
    console.error(e)
    return fallback
  }

async function bootstrap() {
  const [manifest, userSources, components, libraries, scene] = await Promise.all([
    fetch('/sources/manifest.json').then((r) => {
      if (!r.ok) throw new Error(`manifest.json: ${r.status}`)
      return r.json() as Promise<Omit<SourceMeta, 'kind'>[]>
    }),
    loadUserSources().catch(failed([])),
    loadComponents().catch(failed([])),
    loadLibraries().catch(failed([])),
    loadScene().catch(failed(null)),
  ])
  // Что не прочиталось, то и не сохраняется (lib/storage.ts): иначе пустое состояние затерло бы данные
  if (unreadableKeys().length) {
    notify('Не удалось прочитать сохраненные данные браузера. Изменения пока не сохраняются, чтобы их не затереть: перезагрузите страницу', 'error')
  }
  useUi.getState().initSources(
    manifest.map((m) => ({ ...m, kind: 'builtin' as const })),
    userSources,
  )
  useLibrary.getState().init(components, libraries)
  // Объекты, чьих компонентов уже нет, на сцену не попадают
  const ids = new Set(components.map((c) => c.id))
  const base = scene ?? DEFAULT_SCENE
  useScene.getState().init({ ...base, objects: base.objects.filter((o) => ids.has(o.componentId)) })
}

/**
 * Автосохранение сцены: после каждого шага истории, но не на каждом кадре жеста.
 * Сцена из другой вкладки применяется без обратной записи — иначе вкладки пересылали бы ее друг другу бесконечно
 */
function startAutosave() {
  let saved = useScene.getState().scene
  const unsubscribe = useScene.subscribe((s) => {
    if (s.gestureBase || s.scene === saved) return
    saved = s.scene
    saveScene(s.scene).catch((e: unknown) => console.error('Не удалось сохранить сцену', e))
  })
  const applyExternal = (scene: Scene) => {
    // Здесь идет жест (перетаскивание, ручки): не обрываем его. Его итог сохранится и уйдет в ту вкладку
    if (useScene.getState().gestureBase) return
    saved = scene
    useScene.getState().init(scene)
  }
  return { unsubscribe, applyExternal }
}

/** Изменения из другой вкладки: перечитать ключ и показать здесь, ничего не записывая обратно */
function startSync(applyScene: (scene: Scene) => void) {
  return onExternalChange((key) => {
    const reload = async () => {
      if (key === 'components' || key === 'libraries') {
        const [components, libraries] = await Promise.all([loadComponents(), loadLibraries()])
        // Компоненты, удаленные в другой вкладке, убираем и из здешней истории: иначе Ctrl+Z вернул бы «битый» объект
        const kept = new Set(components.map((c) => c.id))
        for (const c of useLibrary.getState().components) if (!kept.has(c.id)) useScene.getState().purgeComponent(c.id)
        useLibrary.getState().init(components, libraries)
      } else if (key === 'userSources') {
        const user = await loadUserSources()
        const ui = useUi.getState() // состояние после ожидания, а не до него
        ui.initSources(ui.builtinSources, user)
        const open = ui.extractSourceId
        // Открытый здесь загруженный файл удалили в другой вкладке
        if (open && ![...ui.builtinSources, ...user].some((x) => x.id === open)) ui.closeSource()
      } else {
        const scene = await loadScene()
        if (scene) applyScene(scene)
      }
    }
    reload().catch((e: unknown) => {
      console.error(e)
      notify('Не удалось принять изменения из другой вкладки. Чтобы ничего не затереть, сохранение приостановлено: перезагрузите страницу', 'error')
    })
  })
}

export function App() {
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading')
  const extractSourceId = useUi((s) => s.extractSourceId)

  useEffect(() => {
    let unsubscribe: (() => void) | undefined
    let cancelled = false
    bootstrap()
      .then(() => {
        if (cancelled) return
        const autosave = startAutosave()
        const stopSync = startSync(autosave.applyExternal)
        unsubscribe = () => {
          autosave.unsubscribe()
          stopSync()
        }
        setStatus('ready')
      })
      .catch((e: unknown) => {
        console.error(e)
        setStatus('error')
      })
    return () => {
      cancelled = true
      unsubscribe?.()
    }
  }, [])

  if (status !== 'ready') {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted">
        {status === 'loading' ? 'Загрузка…' : 'Не удалось загрузить исходники. Проверьте public/sources/manifest.json.'}
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col">
      <header className="flex h-12 shrink-0 items-center gap-3 border-b border-line bg-panel px-4">
        <img src="/favicon.svg" alt="" className="h-6 w-6" />
        <h1 className="text-sm font-semibold">Конструктор векторных композиций</h1>
        <span className="hidden text-xs text-muted lg:inline">
          исходник → выделение → библиотека → холст → SVG
        </span>
      </header>
      <div className="flex min-h-0 flex-1">
        <aside className="w-56 shrink-0 border-r border-line bg-panel">
          <SourcesPanel />
        </aside>
        <main className="min-w-0 flex-1">
          {extractSourceId ? <ExtractView key={extractSourceId} sourceId={extractSourceId} /> : <CanvasView />}
        </main>
        <aside className="w-72 shrink-0 border-l border-line bg-panel">
          <LibraryPanel />
        </aside>
      </div>
      <Toasts />
      <FileDropOverlay />
      <ContextMenuHost />
      <ConfirmHost />
    </div>
  )
}
