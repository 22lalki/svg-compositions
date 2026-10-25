import { notify } from '../store/ui'
import { AiError, pickWithClaude } from './ai'
import { useCatalog } from './catalogStore'
import { useComposition } from './compositionStore'
import { SPARSE, arrangements, isLarge } from './layout'
import { itemsByNames, metaphorSets, type FitInfo } from './metaphor'
import { useComposeUi } from './uiStore'
import type { Item } from './catalog'

/** Доступные в текущем размере объекты (у загруженного может не быть варианта S) */
function available(): Item[] {
  const size = useComposition.getState().comp.size
  return useCatalog.getState().items.filter((i) => i.variants[`${size}-main`] || i.variants[`${size}-bg`])
}

const list = (items: Item[]) => items.map((i) => i.name).join(', ')

/** Оценки наборов раскладкой (подбор наборов для метафоры): одни и те же сочетания не пересчитываются */
const fitCache = new Map<string, FitInfo>()

/**
 * Мелкие объекты дают полупустой кадр (дизайнер всегда держит композицию крупным объектом). Подбираем крупный
 * объект в фон: из связанных с выбранными, а если таких нет — из всего набора; берем тот, с которым раскладка лучше
 */
function backdropFor(chosen: Item[], items: Item[]): Item | null {
  const { format, size } = useComposition.getState().comp
  const base = arrangements(chosen, format, size, undefined, { bestOnly: true })[0]
  if (!base || base.coverage >= SPARSE || chosen.some((i) => isLarge(i, format, size))) return null
  const related = new Set(chosen.flatMap((i) => i.related))
  const large = items.filter((i) => !chosen.includes(i) && isLarge(i, format, size))
  const pool = large.some((i) => related.has(i.id)) ? large.filter((i) => related.has(i.id)) : large
  let best: { item: Item; cost: number } | null = null
  for (const item of pool) {
    const a = arrangements([...chosen, item], format, size, undefined, { bestOnly: true })[0]
    if (a && (!best || a.quality < best.cost)) best = { item, cost: a.quality }
  }
  return best?.item ?? null
}

/** Пояснение к набору: какие слова к каким объектам привели */
const why = (set: Item[], reasons: Record<string, string[]>) =>
  set.map((i) => (reasons[i.id]?.length ? `${i.name} (${reasons[i.id]!.slice(0, 3).join(', ')})` : i.name)).join('; ')

/** Номер набора в пояснении, когда наборов несколько: «Другой» чередует их */
const numbered = (k: number, n: number, text: string) => (n > 1 ? `Набор ${k + 1} из ${n}: ${text}` : text)

/**
 * Сценарий 1: метафора или название → несколько наборов объектов (ИИ с ключом пользователя или словарь) →
 * раскладка. «Другой» чередует наборы и их раскладки: метафора показывается разными объектами
 */
export async function composeFromMetaphor(text: string): Promise<void> {
  const ui = useComposeUi.getState()
  if (ui.busy) return // сборка уже идет: второй запрос (и второй платный вызов ИИ) не нужен
  const phrase = text.trim()
  if (!phrase) {
    notify('Введите метафору или название, например «финансовая грамотность»')
    return
  }
  const items = available()
  ui.setBusy(true)
  await nextFrame()
  try {
    if (ui.apiKey) {
      try {
        const pick = await pickWithClaude(phrase, items, ui.apiKey)
        const sets = pick.sets.map((s, k) => {
          const chosen = s.itemIds.flatMap((id) => items.find((i) => i.id === id) ?? [])
          return { itemIds: chosen.map((i) => i.id), note: numbered(k, pick.sets.length, `${list(chosen)}. ${s.reason}`.trim()), hero: chosen[0]?.id }
        })
        if (useComposition.getState().generateSets(sets, phrase)) ui.setExplanation({ source: 'ai', text: sets[0]!.note })
        return
      } catch (e) {
        // ИИ недоступен — не оставляем пользователя ни с чем: дальше работает словарь
        notify(`ИИ: ${e instanceof AiError ? e.message : 'не удалось получить ответ'}. Подобрано по словарю`, 'error')
        if (!(e instanceof AiError)) console.error(e)
      }
    }
    const { format, size } = useComposition.getState().comp
    const fit = (ids: string[]): FitInfo => {
      const key = JSON.stringify([ids, format, size])
      let f = fitCache.get(key)
      if (!f) {
        const a = arrangements(ids.flatMap((id) => items.find((i) => i.id === id) ?? []), format, size, undefined, { bestOnly: true, hero: ids[0] })[0]
        f = a ? { cost: a.quality, coverage: a.coverage } : { cost: Infinity, coverage: 0 }
        if (fitCache.size > 300) fitCache.clear()
        fitCache.set(key, f)
      }
      return f
    }
    const sets = metaphorSets(phrase, items, fit)
    if (!sets) {
      ui.setExplanation(null)
      notify('В словаре нет подходящих слов. Попробуйте синоним или выберите объекты на вкладке «По объектам»', 'error')
      return
    }
    // Метафору собираем мы сами, поэтому полупустой основной набор дополняем крупным связанным объектом-подложкой
    const first = sets[0]!
    const backdrop = first.items.length < 3 ? backdropFor(first.items, items) : null
    const objectSets = sets.map((s, k) => {
      const chosen = k === 0 && backdrop ? [...s.items, backdrop] : s.items
      const reasons = k === 0 && backdrop ? { ...s.reasons, [backdrop.id]: ['подложка композиции'] } : s.reasons
      return { itemIds: chosen.map((i) => i.id), note: numbered(k, sets.length, why(chosen, reasons)), hero: s.items[0]!.id }
    })
    if (useComposition.getState().generateSets(objectSets, phrase)) ui.setExplanation({ source: 'dictionary', text: objectSets[0]!.note })
  } finally {
    useComposeUi.getState().setBusy(false)
  }
}

/** Объектов больше этого — в одном кадре они неизбежно перекрываются: предупреждаем */
const CROWDED = 5

/** Дать браузеру отрисовать «Собираю…» до тяжелого расчета */
const nextFrame = () => new Promise<void>((r) => requestAnimationFrame(() => setTimeout(r, 0)))

/** Сценарий 2: названия объектов, введенные текстом, и/или отмеченные в наборе → раскладка */
export async function composeFromNames(text: string, picked: string[]): Promise<void> {
  const ui = useComposeUi.getState()
  if (ui.busy) return
  const items = available()
  const typed = itemsByNames(text, items)
  const ids = [...new Set([...typed.map((i) => i.id), ...picked.filter((id) => items.some((i) => i.id === id))])]
  if (!ids.length) {
    notify(text.trim() ? 'Не узнал ни одного объекта: проверьте названия или отметьте объекты в наборе' : 'Перечислите объекты или отметьте их в наборе')
    return
  }
  const chosen = ids.flatMap((id) => items.find((i) => i.id === id) ?? [])
  ui.setBusy(true)
  await nextFrame()
  try {
    if (!useComposition.getState().generate(ids, list(chosen))) return
    if (chosen.length > CROWDED) {
      ui.setExplanation({
        source: 'names',
        text: `${list(chosen)}. Объектов много для одного кадра (${chosen.length}): без изменения размера они перекрываются. Свободнее всего композиция из 2–4 объектов`,
      })
      return
    }
    // Объекты выбрал пользователь — сами не добавляем, но подсказываем, чем заполнить пустой кадр
    // (расчет подсказки — тоже под «Собираю…», а не после него)
    const backdrop = chosen.length < 4 ? backdropFor(chosen, items) : null
    ui.setExplanation({
      source: 'names',
      text: backdrop ? `${list(chosen)}. Объекты небольшие, кадр полупустой — добавьте крупный, например «${backdrop.name}»: он станет подложкой` : list(chosen),
    })
  } finally {
    useComposeUi.getState().setBusy(false)
  }
}
