import { useEffect, useState } from 'react'
import type { SourceMeta } from './types'
import { loadComponents, loadLibraries, loadScene, loadUserSources, saveScene } from './lib/storage'
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

async function bootstrap() {
  const [manifest, userSources, components, libraries, scene] = await Promise.all([
    fetch('/sources/manifest.json').then((r) => {
      if (!r.ok) throw new Error(`manifest.json: ${r.status}`)
      return r.json() as Promise<Omit<SourceMeta, 'kind'>[]>
    }),
    loadUserSources().catch((e: unknown) => {
      console.error(e)
      return []
    }),
    loadComponents().catch((e: unknown) => {
      console.error(e)
      notify('IndexedDB недоступна: библиотека не будет сохраняться', 'error')
      return []
    }),
    loadLibraries().catch(() => []),
    loadScene().catch(() => null),
  ])
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

/** Автосохранение сцены: после каждого шага истории, но не на каждом кадре жеста */
function startAutosave() {
  let saved = useScene.getState().scene
  return useScene.subscribe((s) => {
    if (s.gestureBase || s.scene === saved) return
    saved = s.scene
    saveScene(s.scene).catch((e: unknown) => console.error('Не удалось сохранить сцену', e))
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
        unsubscribe = startAutosave()
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
