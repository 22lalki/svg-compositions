/** Запись из public/sources/manifest.json */
export type SourceMeta = {
  id: string
  title: string
  file: string
  originalName: string
}

/** Компонент библиотеки: фрагмент исходника, сдвинутый в (0,0) */
export type Component = {
  id: string
  name: string
  sourceId: string // id исходника из manifest
  width: number
  height: number
  defs: string // зависимости с префиксованными id
  markup: string // разметка без <svg>, сдвинутая в (0,0)
  createdAt: number
}

/** Экземпляр компонента на холсте */
export type SceneObject = {
  id: string
  componentId: string
  x: number // левый верхний угол до трансформаций
  y: number
  scale: number // масштаб по X (при пропорциональном масштабе — общий)
  scaleY: number // масштаб по Y; отличается от scale только после масштаба с Shift
  rotation: number // градусы, вокруг центра объекта
  flipX: boolean
}

export type Scene = {
  width: number
  height: number
  objects: SceneObject[] // порядок массива = порядок слоев (последний — сверху)
}

export type Point = { x: number; y: number }
export type Rect = { x: number; y: number; width: number; height: number }
