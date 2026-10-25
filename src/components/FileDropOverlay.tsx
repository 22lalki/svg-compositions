import { useEffect, useState } from 'react'
import { uploadSvgFiles } from '../store/userSources'
import { useUi } from '../store/ui'
import { Icon } from './Icon'

const hasFiles = (e: DragEvent) => !!e.dataTransfer && Array.from(e.dataTransfer.types).includes('Files')

/** Загрузка в «Мои SVG» режима извлечения */
function uploadSources(files: File[]) {
  void uploadSvgFiles(files).then((added) => {
    if (added.length === 1) useUi.getState().openSource(added[0]!.id)
  })
}

/**
 * SVG-файлы можно бросить в любое место окна: в режиме извлечения они попадут в «Мои SVG»,
 * в режиме композиций — в набор объектов (onFiles). Заодно браузер не открывает файл вместо приложения.
 */
export function FileDropOverlay({
  onFiles = uploadSources,
  hint = 'Файлы появятся в разделе «Мои SVG»',
}: { onFiles?: (files: File[]) => void; hint?: string }) {
  const [active, setActive] = useState(false)

  useEffect(() => {
    let depth = 0
    const enter = (e: DragEvent) => {
      if (!hasFiles(e)) return
      depth++
      setActive(true)
    }
    const leave = (e: DragEvent) => {
      if (!hasFiles(e)) return
      depth = Math.max(0, depth - 1)
      if (depth === 0) setActive(false)
    }
    const over = (e: DragEvent) => {
      if (!hasFiles(e)) return
      e.preventDefault()
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'
    }
    const drop = (e: DragEvent) => {
      if (!hasFiles(e)) return
      e.preventDefault()
      depth = 0
      setActive(false)
      const files = Array.from(e.dataTransfer?.files ?? [])
      if (files.length) onFiles(files)
    }
    window.addEventListener('dragenter', enter)
    window.addEventListener('dragleave', leave)
    window.addEventListener('dragover', over)
    window.addEventListener('drop', drop)
    return () => {
      window.removeEventListener('dragenter', enter)
      window.removeEventListener('dragleave', leave)
      window.removeEventListener('dragover', over)
      window.removeEventListener('drop', drop)
    }
  }, [onFiles])

  if (!active) return null
  return (
    <div className="pointer-events-none fixed inset-0 z-40 flex items-center justify-center bg-accent/10 p-6">
      <div className="flex flex-col items-center gap-2 rounded-2xl border-2 border-dashed border-accent bg-white/95 px-10 py-8 text-center shadow-xl">
        <Icon name="upload" size={28} className="text-accent" />
        <div className="text-base font-semibold">Отпустите, чтобы загрузить SVG</div>
        <div className="text-sm text-muted">{hint}</div>
      </div>
    </div>
  )
}
