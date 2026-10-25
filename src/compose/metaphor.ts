import type { Item } from './catalog'

/**
 * Подбор объектов по тексту без ИИ: словарь названий и ассоциаций (catalog.ts) + сравнение по основам слов.
 * Основа — слово без типичного окончания: «деньгами», «денег», «деньги» → «деньг»/«ден…». Этого хватает,
 * чтобы метафора в любой форме нашла свои слова, и не нужен большой морфологический словарь.
 */

// Окончания и суффиксы словоизменения, от длинных к коротким
const ENDINGS = [
  'остями', 'остью', 'ениями', 'иями', 'ениям', 'ениях', 'ением', 'ости', 'ость', 'ение', 'ения', 'ению', 'ями',
  'ами', 'ией', 'иям', 'ием', 'иях', 'ого', 'его', 'ому', 'ему', 'ыми', 'ими', 'ать', 'ять', 'ить', 'еть', 'уть',
  'ешь', 'ет', 'ут', 'ют', 'ит', 'ат', 'ят', 'ой', 'ей', 'ий', 'ый', 'ая', 'яя', 'ое', 'ее', 'ые', 'ие', 'ую',
  'юю', 'ом', 'ем', 'ам', 'ям', 'ах', 'ях', 'ов', 'ев', 'ья', 'ье', 'ьи', 'ью', 'а', 'я', 'о', 'е', 'ы', 'и',
  'у', 'ю', 'ь', 'й',
]

export function stem(word: string): string {
  const w = word.toLowerCase().replace(/ё/g, 'е')
  if (!/[а-я]/.test(w)) return w.replace(/(?:ing|ed|es|s)$/, '') // английские слова: грубо, но достаточно
  for (const e of ENDINGS) if (w.endsWith(e) && w.length - e.length >= 3) return w.slice(0, -e.length)
  return w
}

const STOP = new Set(['и', 'в', 'во', 'на', 'с', 'со', 'к', 'по', 'для', 'от', 'до', 'из', 'за', 'о', 'об', 'а', 'но', 'или', 'как', 'это', 'the', 'a', 'of', 'and'])

export const words = (text: string): string[] =>
  text
    .toLowerCase()
    .replace(/ё/g, 'е')
    .split(/[^a-zа-я0-9]+/i)
    .filter((w) => w && !STOP.has(w))

/** Основы совпадают; у длинных основ достаточно, чтобы одна начиналась с другой («финанс» и «финансов») */
function sameStem(a: string, b: string): boolean {
  if (a === b) return true
  const [short, long] = a.length <= b.length ? [a, b] : [b, a]
  return short.length >= 5 && long.startsWith(short)
}

/** Фраза словаря встречается в тексте: каждое ее слово есть среди слов текста */
function phraseIn(phrase: string, textStems: string[]): boolean {
  const ps = words(phrase).map(stem)
  return ps.length > 0 && ps.every((p) => textStems.some((t) => sameStem(p, t)))
}

export type ItemMatch = { item: Item; score: number; matched: string[] }

/** Объекты, упомянутые в тексте, с весом: название — 3, многословная ассоциация — 2, слово-ассоциация — 1 */
export function scoreItems(text: string, items: readonly Item[]): ItemMatch[] {
  const textStems = words(text).map(stem)
  const result: ItemMatch[] = []
  for (const item of items) {
    let score = 0
    const matched: string[] = []
    const names = [...new Set([item.name, ...item.names])]
    for (const n of names) {
      if (phraseIn(n, textStems)) {
        score += 3
        matched.push(n)
      }
    }
    for (const k of new Set(item.keywords)) {
      if (phraseIn(k, textStems)) {
        score += k.includes(' ') ? 2 : 1
        matched.push(k)
      }
    }
    if (score > 0) result.push({ item, score, matched })
  }
  return result.sort((a, b) => b.score - a.score)
}

/** Сценарий «по названиям»: объекты в порядке упоминания, только по названиям (без ассоциаций) */
export function itemsByNames(text: string, items: readonly Item[]): Item[] {
  const parts = text.split(/[,;+\n]|\s+и\s+/).map((p) => p.trim()).filter(Boolean)
  const found: Item[] = []
  for (const part of parts) {
    const stems = words(part).map(stem)
    // Если в части несколько названий («телефон наушники»), берем все
    for (const item of items) {
      if (found.includes(item)) continue
      if ([item.name, ...item.names].some((n) => phraseIn(n, stems))) found.push(item)
    }
  }
  return found
}

export type MetaphorPick = { items: Item[]; reasons: Record<string, string[]>; source: 'dictionary' }

/**
 * Сценарий «по метафоре»: 2–3 объекта с наибольшим весом. Объект попадает, если набрал не меньше пятой части веса лучшего:
 * метафора обычно соединяет два смысла («финансовая грамотность» — деньги и знания), второй смысл весит меньше.
 * Если нашелся один — добавляем ему пару из related, чтобы получилась композиция, а не одиночный объект.
 * Пару выбирает fitCost (насколько хорошо объекты раскладываются вместе): к крупной лампе — не огромная книга
 */
export function pickByMetaphor(text: string, items: readonly Item[], max = 3, fitCost?: (ids: string[]) => number): MetaphorPick | null {
  const ranked = scoreItems(text, items)
  if (!ranked.length) return null
  const top = ranked[0]!.score
  const chosen = ranked.filter((m) => m.score * 5 >= top).slice(0, max)
  const reasons: Record<string, string[]> = Object.fromEntries(chosen.map((m) => [m.item.id, m.matched]))
  const picked = chosen.map((m) => m.item)
  if (picked.length === 1) {
    const candidates = picked[0]!.related.flatMap((id) => items.find((i) => i.id === id && !picked.includes(i)) ?? [])
    const cost = (i: Item) => fitCost?.([picked[0]!.id, i.id]) ?? 0
    // Порядок related — смысловой; при равной раскладке выигрывает тот, что стоит в списке раньше
    const partner = [...candidates].sort((a, b) => cost(a) - cost(b) || candidates.indexOf(a) - candidates.indexOf(b))[0]
    if (partner) {
      picked.push(partner)
      reasons[partner.id] = [`пара к «${picked[0]!.name}»`]
    }
  }
  return { items: picked, reasons, source: 'dictionary' }
}

export type MetaphorSet = { items: Item[]; reasons: Record<string, string[]> }
/** Оценка набора раскладкой: стоимость лучшего варианта и заполнение кадра (полупустой набор хуже) */
export type FitInfo = { cost: number; coverage: number }

function combos<T>(list: T[], k: number): T[][] {
  if (k === 0) return [[]]
  if (list.length < k) return []
  const [head, ...rest] = list
  return [...combos(rest, k - 1).map((c) => [head!, ...c]), ...combos(rest, k)]
}

/**
 * Несколько наборов для одной метафоры — чтобы «Другой» менял и объекты, а не только раскладку.
 * Первый — основной (pickByMetaphor). Альтернативы — сочетания 2–3 объектов из найденных по словарю (до пяти)
 * и связанных с главным; в каждом есть хотя бы один из двух самых подходящих объектов, иначе смысл теряется.
 * Сочетания ранжируются по смыслу (вес слов), затем лучшие — по тому, как они раскладываются (fit)
 */
export function metaphorSets(text: string, items: readonly Item[], fit?: (ids: string[]) => FitInfo, limit = 4): MetaphorSet[] | null {
  const first = pickByMetaphor(text, items, 3, fit && ((ids) => fit(ids).cost))
  if (!first) return null
  const ranked = scoreItems(text, items)
  const top = ranked[0]!.score
  const relevance = new Map<Item, number>(ranked.slice(0, 5).map((m) => [m.item, m.score / top]))
  const reasons: Record<string, string[]> = { ...first.reasons, ...Object.fromEntries(ranked.map((m) => [m.item.id, m.matched])) }
  const lead = ranked[0]!.item
  for (const id of lead.related) {
    const item = items.find((i) => i.id === id)
    if (item && !relevance.has(item)) {
      // Связанный объект весит меньше любого найденного по словам: он лишь дополняет смысл
      relevance.set(item, 0.12)
      reasons[item.id] = [`связан с «${lead.name}»`]
    }
  }
  const anchors = ranked.slice(0, 2).map((m) => m.item)
  const pool = [...relevance.keys()]
  const key = (list: Item[]) => list.map((i) => i.id).sort().join()
  const taken = new Set([key(first.items)])
  const candidates = [...combos(pool, 2), ...combos(pool, 3)]
    .filter((c) => c.some((i) => anchors.includes(i)) && !taken.has(key(c)))
    // Первым в наборе — самый подходящий по смыслу объект: он «герой» и в раскладке остается основным
    .map((c) => [...c].sort((a, b) => relevance.get(b)! - relevance.get(a)!))
    .map((c) => ({ items: c, value: c.reduce((sum, i) => sum + relevance.get(i)!, 0) / Math.sqrt(c.length) }))
    .sort((a, b) => b.value - a.value)
    .slice(0, 8)
  // Раскладка: дорогая или полупустая — ниже (без масштаба мелкие объекты в одиночку держат кадр плохо)
  for (const c of candidates) {
    if (!fit) continue
    const f = fit(c.items.map((i) => i.id))
    // Смысл важнее раскладки: раскладка лишь отсеивает плохие наборы, хорошая (≤ 0) не поднимает набор выше смысла
    c.value -= 0.1 * Math.max(0, f.cost) + (f.coverage < 0.22 ? 0.5 : 0)
  }
  // Жадный выбор: доплата за объекты, которых еще не было в наборах, — «Другой» показывает метафору разными объектами
  const sets: MetaphorSet[] = [{ items: first.items, reasons: first.reasons }]
  const shown = new Set(first.items)
  while (sets.length < limit && candidates.length) {
    let bi = 0
    let bv = -Infinity
    candidates.forEach((c, i) => {
      const v = c.value + 0.05 * c.items.filter((x) => !shown.has(x)).length
      if (v > bv) {
        bv = v
        bi = i
      }
    })
    const c = candidates.splice(bi, 1)[0]!
    c.items.forEach((x) => shown.add(x))
    sets.push({ items: c.items, reasons: Object.fromEntries(c.items.map((i) => [i.id, reasons[i.id] ?? []])) })
  }
  return sets
}
