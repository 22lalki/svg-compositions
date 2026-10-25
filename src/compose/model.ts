import data from './data/set.json'

/**
 * Режим «Композиции»: сборка композиций из готовых объектов набора.
 * Объекты не меняются: только позиция, поворот, порядок слоев, состояние (основной/фоновый вариант файла)
 * и цвета — строго из выбранной цветовой схемы.
 */

/** Роли цветов в файлах объектов набора (файлы нарисованы фиолетовой схемой набора) */
export const ROLES = ['bgLight', 'bgMid', 'bgDark', 'black', 'accent1', 'accent2', 'accent3', 'white'] as const
export type Role = (typeof ROLES)[number]

/** Роли цветов фона в файлах набора */
export const BG_ROLES: readonly Role[] = ['bgLight', 'bgMid', 'bgDark', 'white']

/**
 * Цветовая схема — палитра с любым числом цветов в двух группах:
 *  - bg — цвета фона (левая колонка палитры, сверху вниз от светлого к темному);
 *  - accents — цвета объектов (правая колонка);
 *  - black и white — контуры и блики. Ищутся по значению в любой колонке; если их нет в палитре,
 *    это самый темный и самый светлый цвет палитры (цвет все равно берется из нее).
 * В палитрах набора 3 цвета фона и 3 цвета объектов, но число может быть любым.
 */
export type Scheme = { id: string; name: string; bg: string[]; accents: string[]; black: string; white: string; builtin?: boolean }

/**
 * Цвет схемы, на который перекрашена роль объекта: 'bg.0'…'bg.N' (фон), 'obj.0'…'obj.N' (объекты), 'black', 'white'.
 * Имя роли (например 'accent1') тоже годится: оно означает цвет, на который эта роль ложится по умолчанию, —
 * так записаны перекраски дизайнера в шаблонах, и они работают в палитре любой длины
 */
export type ColorKey = string

/** На какой цвет схемы ложится роль файла по умолчанию: светлый фон — первый цвет фона, темный — последний… */
export function defaultKey(role: Role, s: Scheme): ColorKey {
  const n = s.bg.length
  switch (role) {
    case 'bgLight':
      return 'bg.0'
    case 'bgMid':
      return `bg.${Math.ceil((n - 1) / 2)}`
    case 'bgDark':
      return `bg.${n - 1}`
    case 'black':
    case 'white':
      return role
    default: {
      // Акценты по кругу; палитра без цветов объектов — тогда акценты берут цвета фона (это разрешено)
      const k = Number(role.slice(-1)) - 1
      return s.accents.length ? `obj.${k % s.accents.length}` : `bg.${k % n}`
    }
  }
}

/** Ключ в каноническом виде (имя роли → ключ цвета); индекс за пределами палитры — по кругу */
export function resolveKey(key: ColorKey, s: Scheme): ColorKey {
  if ((ROLES as readonly string[]).includes(key) && key !== 'black' && key !== 'white') return defaultKey(key as Role, s)
  const m = /^(bg|obj)\.(\d+)$/.exec(key)
  if (!m) return key === 'black' || key === 'white' ? key : 'bg.0'
  const list = m[1] === 'bg' ? s.bg : s.accents
  if (!list.length) return 'bg.0'
  return `${m[1]}.${Number(m[2]) % list.length}`
}

export function schemeColor(s: Scheme, key: ColorKey): string {
  const k = resolveKey(key, s)
  if (k === 'black') return s.black
  if (k === 'white') return s.white
  const m = /^(bg|obj)\.(\d+)$/.exec(k)!
  return (m[1] === 'bg' ? s.bg : s.accents)[Number(m[2])] ?? s.bg[0]!
}

/** Все цвета схемы ключами: фон, объекты, черный, белый */
export const schemeKeys = (s: Scheme): ColorKey[] => [...s.bg.map((_, i) => `bg.${i}`), ...s.accents.map((_, i) => `obj.${i}`), 'black', 'white']

/** Цвет фона (фоновым объектам и декору можно только их) */
export const isBgKey = (key: ColorKey, s: Scheme) => {
  const k = resolveKey(key, s)
  return k.startsWith('bg.') || k === 'white'
}

/** Какие цвета разрешены объекту в этом состоянии: фоновому — только цвета фона и белый */
export const allowedKeys = (state: ObjState, s: Scheme): ColorKey[] => schemeKeys(s).filter((k) => state === 'main' || isBgKey(k, s))

/** Все цвета схемы (без повторов) — для проверки, что композиция ее не нарушает */
export const schemeColors = (s: Scheme) => [...new Set([...s.bg, ...s.accents, s.black, s.white])]
export const schemeBgColors = (s: Scheme) => [...new Set([...s.bg, s.white])]

export function keyLabel(key: ColorKey, s: Scheme): string {
  const k = resolveKey(key, s)
  if (k === 'black') return 'Черный'
  // Белого в палитре нет — на его месте самый светлый цвет фона
  if (k === 'white') return s.bg.includes(s.white) ? 'Светлый (вместо белого)' : 'Белый'
  const m = /^(bg|obj)\.(\d+)$/.exec(k)!
  return `${m[1] === 'bg' ? 'Фон' : 'Объект'} ${Number(m[2]) + 1}`
}

/** Схема из восьми ролей (формат палитр набора) */
export const schemeFromRoles = (id: string, name: string, c: Record<Role, string>): Scheme => ({
  id,
  name,
  bg: [c.bgLight, c.bgMid, c.bgDark],
  accents: [c.accent1, c.accent2, c.accent3],
  black: c.black,
  white: c.white,
})

export type SizeKey = 'L' | 'S'
export type FormatKey = 'square' | 'wide' | 'tall'
export type DecorKind = 'circles' | 'wedge' | 'none'
export type ObjState = 'main' | 'bg'

export const FORMAT_KEYS: readonly FormatKey[] = ['square', 'wide', 'tall']
export const FORMAT_LABELS: Record<FormatKey, string> = { square: 'Квадрат', wide: 'Горизонталь', tall: 'Вертикаль' }

/** Объект на холсте. x, y — левый верхний угол рамки до поворота, в координатах текущего размера (L или S) */
export type CObject = {
  id: string
  itemId: string
  state: ObjState
  x: number
  y: number
  rotation: number
  /** Перекраска: роль цвета в файле объекта → цвет схемы (ColorKey). Пусто — цвета по умолчанию */
  colors: Partial<Record<Role, ColorKey>>
  /** Объединение: объекты одной группы выделяются и двигаются вместе */
  groupId?: string
}

/** Откуда раскладка: шаблон из примеров и какой объект в какой ячейке — чтобы пересобрать ее в другом формате */
export type LayoutRef = { templateId: string; mirror: boolean; slots: Record<string, number> }

export type Composition = {
  size: SizeKey
  format: FormatKey
  schemeId: string
  decor: DecorKind
  /** Декор отражен по горизонтали (вместе с зеркальной раскладкой шаблона) */
  mirror: boolean
  layout: LayoutRef | null
  objects: CObject[]
}

export type DecorElement = { d: string; fill?: Role; stroke?: Role; strokeWidth?: number }
/** Ячейка шаблона: объект дизайнера, его состояние, позиция и перекраска (если дизайнер менял цвета) */
export type TemplateSlot = { item: string; state: ObjState; x: number; y: number; colors?: Partial<Record<Role, Role>> }
export type Template = {
  id: string
  formats: Record<FormatKey, { decor: Exclude<DecorKind, 'none'>; slots: TemplateSlot[]; source: string }>
}

type SetData = {
  schemes: Array<{ id: string; name: string; colors: Record<Role, string> }>
  items: Record<string, Record<SizeKey, [number, number]>>
  formats: Record<FormatKey, [number, number]>
  decor: Record<SizeKey, Record<FormatKey, Record<'circles' | 'wedge', DecorElement[]>>>
  templates: Template[]
}

export const SET = data as unknown as SetData

export const BUILTIN_SCHEMES: Scheme[] = SET.schemes.map((s) => ({ ...schemeFromRoles(s.id, s.name, s.colors), builtin: true }))

/** Цвета, которыми нарисованы файлы набора (фиолетовая схема) — по ним узнаем роль каждого цвета */
export const BASE_COLORS: Record<Role, string> = SET.schemes.find((s) => s.id === 'violet')!.colors

/** Множитель координат размера относительно L: объекты и фоны S ровно вдвое меньше */
export const SIZE_FACTOR: Record<SizeKey, number> = { L: 1, S: 0.5 }

export function formatSize(format: FormatKey, size: SizeKey): { width: number; height: number } {
  const [w, h] = SET.formats[format]
  return { width: w * SIZE_FACTOR[size], height: h * SIZE_FACTOR[size] }
}

export const DEFAULT_COMPOSITION: Composition = {
  size: 'L',
  format: 'square',
  schemeId: 'violet',
  decor: 'circles',
  mirror: false,
  layout: null,
  objects: [],
}

/** Цвет в канонический вид #RRGGBB (для сравнения цветов файла с цветами схемы) */
export function normalizeColor(value: string): string | null {
  const v = value.trim().toLowerCase()
  if (v === 'white') return '#FFFFFF'
  if (v === 'black') return '#000000'
  const short = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/.exec(v)
  if (short) return `#${short[1]}${short[1]}${short[2]}${short[2]}${short[3]}${short[3]}`.toUpperCase()
  if (/^#[0-9a-f]{6}$/.test(v)) return v.toUpperCase()
  const rgb = /^rgba?\(\s*(\d+)[\s,]+(\d+)[\s,]+(\d+)/.exec(v)
  if (rgb) return `#${rgb.slice(1, 4).map((n) => Number(n).toString(16).padStart(2, '0')).join('')}`.toUpperCase()
  return null
}

