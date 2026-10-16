import type { SourceMeta } from '../types'
import { shortId } from '../lib/ids'
import { importSvgFile, SvgImportError } from '../lib/importSvg'
import { saveUserSourceText } from '../lib/storage'
import { notify, useUi } from './ui'

const isSvgFile = (f: File) => /\.svg$/i.test(f.name) || f.type === 'image/svg+xml'

/**
 * Загрузка SVG пользователя: проверка, очистка, нормализация, сохранение в IndexedDB.
 * Ошибки показываются по каждому файлу, удачные попадают в «Мои SVG».
 */
export async function uploadSvgFiles(files: File[]): Promise<SourceMeta[]> {
  const svgFiles = files.filter(isSvgFile)
  for (const f of files) if (!isSvgFile(f)) notify(`${f.name}: нужен файл .svg`, 'error')
  const added: SourceMeta[] = []
  for (const file of svgFiles) {
    try {
      const { title, svgText } = await importSvgFile(file)
      const meta: SourceMeta = { id: `u${shortId(7)}`, title, originalName: file.name, kind: 'user', createdAt: Date.now() }
      await saveUserSourceText(meta.id, svgText)
      added.push(meta)
    } catch (e) {
      if (!(e instanceof SvgImportError)) console.error(e)
      notify(`${file.name}: ${e instanceof SvgImportError ? e.message : 'не удалось загрузить'}`, 'error')
    }
  }
  if (added.length) {
    useUi.getState().addUserSources(added)
    notify(added.length === 1 ? `«${added[0]!.title}» загружен` : `Загружено SVG: ${added.length}`)
  }
  return added
}
