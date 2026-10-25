import type { Item } from './catalog'

/**
 * Подбор объектов по метафоре через Claude — по желанию, с ключом самого пользователя.
 * Ключ хранится только в его браузере, запрос идет напрямую в API Anthropic (у сервиса нет сервера).
 * Модель выбирает объекты только из переданного списка и ничего не рисует: объекты набора не генерируются.
 * Без ключа или при ошибке работает словарь (metaphor.ts).
 */

export const AI_MODEL = 'claude-opus-5-5'

/** Несколько наборов: «Другой» чередует их, чтобы метафора показывалась разными объектами */
export type AiPick = { sets: Array<{ itemIds: string[]; reason: string }> }

export class AiError extends Error {}

const SCHEMA = {
  type: 'object',
  properties: {
    sets: {
      type: 'array',
      description: 'От 2 до 3 разных наборов, от лучшего к запасному',
      items: {
        type: 'object',
        properties: {
          items: { type: 'array', description: 'id объектов из списка, от главного к второстепенному', items: { type: 'string' } },
          reason: { type: 'string', description: 'Одно короткое предложение по-русски: почему эти объекты передают смысл' },
        },
        required: ['items', 'reason'],
        additionalProperties: false,
      },
    },
  },
  required: ['sets'],
  additionalProperties: false,
}

export async function pickWithClaude(text: string, items: readonly Item[], apiKey: string): Promise<AiPick> {
  // SDK грузится только при первом запросе: без ИИ он не утяжеляет страницу
  const { default: Anthropic } = await import('@anthropic-ai/sdk')
  // Ключ пользователя в его же браузере — осознанный выбор (сервиса без сервера); ключ никуда больше не уходит
  const client = new Anthropic({ apiKey, dangerouslyAllowBrowser: true })
  const catalog = items.map((i) => `- ${i.id}: ${i.name}${i.keywords.length ? ` (ассоциации: ${i.keywords.slice(0, 12).join(', ')})` : ''}`).join('\n')
  try {
    const response = await client.beta.messages.create({
      model: AI_MODEL,
      max_tokens: 2000,
      // Отказ модели по политике безопасности: сервер сам повторит запрос на подходящей модели
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      output_config: { effort: 'low', format: { type: 'json_schema', schema: SCHEMA } },
      system:
        'Ты помогаешь дизайнеру собрать иллюстрацию-метафору из готовых объектов. ' +
        'Предложи 2–3 разных набора по 2–3 объекта (иногда 1, если больше ничего не подходит): каждый набор вместе передает смысл фразы, ' +
        'наборы отличаются составом — так дизайнер сможет выбрать. Первый — лучший. ' +
        'Используй только id из списка. Объекты нельзя придумывать или изменять.\n\nОбъекты:\n' +
        catalog,
      messages: [{ role: 'user', content: text }],
    })
    if (response.stop_reason === 'refusal') throw new AiError('модель отказалась отвечать на этот запрос')
    const block = response.content.find((b) => b.type === 'text')
    if (!block || block.type !== 'text') throw new AiError('пустой ответ модели')
    const parsed = JSON.parse(block.text) as { sets?: unknown }
    const known = new Set(items.map((i) => i.id))
    const sets = (Array.isArray(parsed.sets) ? parsed.sets : []).flatMap((x: unknown) => {
      const set = x as { items?: unknown; reason?: unknown }
      const ids = Array.isArray(set.items) ? [...new Set(set.items.filter((v): v is string => typeof v === 'string' && known.has(v)))].slice(0, 4) : []
      return ids.length ? [{ itemIds: ids, reason: typeof set.reason === 'string' ? set.reason : '' }] : []
    })
    if (!sets.length) throw new AiError('модель не выбрала ни одного объекта из набора')
    return { sets: sets.slice(0, 4) }
  } catch (e) {
    if (e instanceof AiError) throw e
    if (e instanceof Anthropic.AuthenticationError) throw new AiError('ключ не подошел: проверьте его в настройках ИИ')
    if (e instanceof Anthropic.RateLimitError) throw new AiError('превышен лимит запросов, попробуйте через минуту')
    if (e instanceof Anthropic.APIConnectionError) throw new AiError('нет связи с API Anthropic')
    if (e instanceof Anthropic.APIError) throw new AiError(`ошибка API ${e.status ?? ''}: ${e.message}`)
    if (e instanceof SyntaxError) throw new AiError('модель вернула ответ не по схеме')
    throw e
  }
}
