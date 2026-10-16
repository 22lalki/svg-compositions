/**
 * Vercel-функция: ИИ-разметка логических объектов загруженного пользователем SVG.
 *
 * Браузер присылает картинку исходника с номерами фигур и таблицу фигур, Claude разбивает фигуры
 * на объекты («Девушка», «Собака», «Ель слева»). Ключ ANTHROPIC_API_KEY живет только здесь, на сервере.
 * Без ключа функция отвечает 503, и приложение остается на автоматической эвристике.
 */
import Anthropic from '@anthropic-ai/sdk'

const MODEL = 'claude-opus-5-5'
/** Больше фигур на одной картинке уже не разобрать — тогда работает эвристика */
export const MAX_SHAPES = 400
const MAX_IMAGE_BASE64 = 4_000_000
const MAX_TABLE_CHARS = 60_000

export type AnnotatedObject = { name: string; shapes: number[] }

type RequestBody = {
  image: string // PNG в base64: исходник с номерами фигур
  table: string // таблица фигур: номер, тег, цвет, рамка, группа
  shapeCount: number
  title?: string
  hint?: number[][] // разбиение эвристикой — как отправная точка
}

const OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    objects: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          shapes: { type: 'array', items: { type: 'integer' } },
        },
        required: ['name', 'shapes'],
        additionalProperties: false,
      },
    },
  },
  required: ['objects'],
  additionalProperties: false,
}

const SYSTEM_PROMPT = `Ты размечаешь векторную иллюстрацию для конструктора композиций: пользователь кликает по рисунку и получает целый логический объект — персонажа, животное, предмет, — чтобы переиспользовать его в новой сцене.

На картинке у каждой фигуры (path, rect, circle…) подписан номер в центре ее рамки. В таблице для каждой фигуры: номер, тег, цвет заливки, рамка x0,y0,x1,y1 в координатах рисунка и группа в исходном файле. Фигуры одной группы обычно художник рисовал как один объект — это сильная подсказка.

Разбей ВСЕ фигуры на объекты так, чтобы каждая фигура попала ровно в один объект:
- человек — один объект вместе с волосами, лицом, одеждой, обувью и мелочами в руке (телефон, чашка); самостоятельные предметы (зонт, лупа, косточка, график) — отдельные объекты;
- животное — один объект (глаза, уши, ошейник, хвост);
- предмет — один объект со всеми деталями: фургон с колесами и окнами, окно с рамами и тем, что нарисовано в стекле, гаджет с кнопками и элементами экрана;
- человек или животное внутри предмета — все равно отдельный объект;
- каждое дерево с ветками и стволом, каждое облако, солнце, луна с кратерами, каждая гора — отдельно;
- земля, линия пола, тень, большой фон — свои объекты;
- рассыпанный мелкий декор одного вида (снег, звезды, искры, конфетти) — один объект на вид.

Названия — короткие, по-русски, с заглавной буквы, уникальные в пределах рисунка («Девушка», «Собака», «Косточка», «Ель слева», «Снег»). Если смысл фигуры неясен, отнеси ее к ближайшему по смыслу объекту.`

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8' } })

function validate(body: unknown): RequestBody | string {
  if (!body || typeof body !== 'object') return 'ожидается JSON'
  const b = body as Partial<RequestBody>
  if (typeof b.image !== 'string' || !/^[A-Za-z0-9+/]+=*$/.test(b.image) || b.image.length > MAX_IMAGE_BASE64)
    return 'image: нужен PNG в base64 до 3 МБ'
  if (typeof b.table !== 'string' || b.table.length > MAX_TABLE_CHARS) return 'table: строка до 60 000 символов'
  if (!Number.isInteger(b.shapeCount) || b.shapeCount! < 1 || b.shapeCount! > MAX_SHAPES)
    return `shapeCount: от 1 до ${MAX_SHAPES}`
  if (b.title !== undefined && typeof b.title !== 'string') return 'title: строка'
  if (b.hint !== undefined && !(Array.isArray(b.hint) && b.hint.every((g) => Array.isArray(g) && g.every(Number.isInteger))))
    return 'hint: массив массивов номеров'
  return b as RequestBody
}

/** Ответ модели → разбиение: номера в диапазоне, каждая фигура только в одном объекте */
export function cleanObjects(raw: unknown, shapeCount: number): AnnotatedObject[] {
  const list = (raw as { objects?: unknown })?.objects
  if (!Array.isArray(list)) return []
  const seen = new Set<number>()
  const out: AnnotatedObject[] = []
  for (const item of list) {
    const name = typeof item?.name === 'string' ? item.name.trim().slice(0, 60) : ''
    const shapes = Array.isArray(item?.shapes)
      ? (item.shapes as unknown[]).filter(
          (i): i is number => Number.isInteger(i) && (i as number) >= 0 && (i as number) < shapeCount && !seen.has(i as number),
        )
      : []
    shapes.forEach((i) => seen.add(i))
    if (shapes.length) out.push({ name: name || 'Объект', shapes: [...new Set(shapes)].sort((a, b) => a - b) })
  }
  return out
}

function userText(b: RequestBody): string {
  const hint = b.hint?.length
    ? `\n\nАвтоматическая эвристика предлагает такое разбиение (часто близко, но ошибается):\n${b.hint.map((g, k) => `${k}: ${g.join(',')}`).join('\n')}`
    : ''
  return `Рисунок${b.title ? ` «${b.title}»` : ''}, фигур: ${b.shapeCount} (номера 0–${b.shapeCount - 1}).

Таблица фигур (номер, тег, заливка, рамка x0,y0,x1,y1, группа):
${b.table}${hint}

Верни объекты рисунка.`
}

/** Фабрика обработчика: в тестах подставляется клиент с поддельным fetch */
export function createAnnotateHandler(getClient: () => Anthropic | null = defaultClient) {
  return async function handle(request: Request): Promise<Response> {
    if (request.method !== 'POST') return json(405, { error: 'method_not_allowed' })
    const client = getClient()
    if (!client) return json(503, { error: 'not_configured', message: 'ИИ-разметка не настроена: нет ANTHROPIC_API_KEY' })

    let parsed: unknown
    try {
      parsed = await request.json()
    } catch {
      return json(400, { error: 'bad_request', message: 'ожидается JSON' })
    }
    const body = validate(parsed)
    if (typeof body === 'string') return json(400, { error: 'bad_request', message: body })

    try {
      const response = await client.beta.messages.create({
        model: MODEL,
        max_tokens: 16000,
        // При отказе по политике запрос повторяется на рекомендованной запасной модели
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default',
        output_config: { effort: 'medium', format: { type: 'json_schema', schema: OUTPUT_SCHEMA } },
        system: SYSTEM_PROMPT,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'image', source: { type: 'base64', media_type: 'image/png', data: body.image } },
              { type: 'text', text: userText(body) },
            ],
          },
        ],
      })
      if (response.stop_reason === 'refusal') return json(422, { error: 'refusal', message: 'модель отказалась размечать рисунок' })
      if (response.stop_reason === 'max_tokens') return json(502, { error: 'truncated', message: 'ответ модели обрезан' })
      const text = response.content.find((block) => block.type === 'text')
      if (!text || text.type !== 'text') return json(502, { error: 'empty', message: 'модель не вернула разметку' })
      const objects = cleanObjects(JSON.parse(text.text), body.shapeCount)
      if (!objects.length) return json(502, { error: 'empty', message: 'модель не вернула объекты' })
      return json(200, { objects, model: response.model })
    } catch (error) {
      if (error instanceof Anthropic.RateLimitError) return json(429, { error: 'rate_limited', message: 'слишком много запросов, попробуйте позже' })
      if (error instanceof Anthropic.AuthenticationError) return json(503, { error: 'not_configured', message: 'неверный ANTHROPIC_API_KEY' })
      if (error instanceof Anthropic.APIError) return json(502, { error: 'upstream', message: `Claude API: ${error.status ?? ''} ${error.message}`.trim() })
      if (error instanceof SyntaxError) return json(502, { error: 'bad_output', message: 'модель вернула некорректный JSON' })
      throw error
    }
  }
}

function defaultClient(): Anthropic | null {
  return process.env.ANTHROPIC_API_KEY ? new Anthropic() : null
}

/** Vercel: POST /api/annotate */
export const POST = createAnnotateHandler()
