// Тест серверной ИИ-разметки без сети: Anthropic SDK получает поддельный fetch.
// Запуск: node --experimental-strip-types scripts/test-annotate-api.mjs
import Anthropic from '@anthropic-ai/sdk'
import { createAnnotateHandler } from '../api/annotate.ts'

let failed = 0
const check = (name, ok, details = '') => {
  if (!ok) failed++
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}${details ? ` — ${details}` : ''}`)
}

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
const body = { image: PNG, table: '0\tpath\t#6c63ff\t0,0,10,10\t', shapeCount: 5, title: 'Тест', hint: [[0, 1], [2, 3, 4]] }
const post = (b) => new Request('http://x/api/annotate', { method: 'POST', body: JSON.stringify(b), headers: { 'content-type': 'application/json' } })

/** Клиент, у которого вместо сети — заранее заданный ответ API; запросы запоминаются */
function fakeClient(status, payload) {
  const calls = []
  const client = new Anthropic({
    apiKey: 'test-key',
    maxRetries: 0,
    fetch: async (url, init) => {
      calls.push({ url: String(url), headers: new Headers(init.headers), body: JSON.parse(init.body) })
      return new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } })
    },
  })
  return { client, calls }
}

const message = (text, stop_reason = 'end_turn') => ({
  id: 'msg_test',
  type: 'message',
  role: 'assistant',
  model: 'claude-opus-5-5',
  content: [{ type: 'text', text }],
  stop_reason,
  stop_sequence: null,
  usage: { input_tokens: 10, output_tokens: 10 },
})

// 1. Нет ключа → 503, приложение уходит на эвристику
{
  const res = await createAnnotateHandler(() => null)(post(body))
  check('без ключа: 503 not_configured', res.status === 503 && (await res.json()).error === 'not_configured')
}

// 2. Неверное тело → 400, в API ничего не уходит
{
  const { client, calls } = fakeClient(200, message('{}'))
  const res = await createAnnotateHandler(() => client)(post({ ...body, image: 'not base64!' }))
  check('неверная картинка: 400 и без запроса в API', res.status === 400 && calls.length === 0)
  const res2 = await createAnnotateHandler(() => client)(post({ ...body, shapeCount: 5000 }))
  check('слишком много фигур: 400', res2.status === 400)
}

// 3. Успех: что ушло в Claude и как почищен ответ
{
  const answer = { objects: [{ name: ' Собака ', shapes: [0, 1, 1, 99] }, { name: 'Косточка', shapes: [1, 2] }, { name: '', shapes: [3, 4] }, { name: 'Пусто', shapes: [] }] }
  const { client, calls } = fakeClient(200, message(JSON.stringify(answer)))
  const res = await createAnnotateHandler(() => client)(post(body))
  const data = await res.json()
  const sent = calls[0]
  check('успех: 200', res.status === 200, JSON.stringify(data))
  check('запрос: модель claude-opus-5-5', sent?.body.model === 'claude-opus-5-5')
  check('запрос: запасная модель при отказе (fallbacks default + beta)', sent?.body.fallbacks === 'default' && (sent?.headers.get('anthropic-beta') ?? '').includes('server-side-fallback-2026-07-01'))
  check('запрос: структурированный JSON и effort', sent?.body.output_config?.format?.type === 'json_schema' && sent?.body.output_config?.effort === 'medium')
  const content = sent?.body.messages?.[0]?.content ?? []
  check('запрос: картинка с номерами и таблица', content[0]?.type === 'image' && content[0]?.source?.data === PNG && content[1]?.text.includes('0\tpath'))
  check('запрос: подсказка эвристики в тексте', content[1]?.text.includes('0: 0,1'))
  check(
    'ответ почищен: дубли и номера вне диапазона убраны, пустые объекты выброшены',
    JSON.stringify(data.objects) === JSON.stringify([{ name: 'Собака', shapes: [0, 1] }, { name: 'Косточка', shapes: [2] }, { name: 'Объект', shapes: [3, 4] }]),
    JSON.stringify(data.objects),
  )
}

// 4. Отказ модели → 422
{
  const { client } = fakeClient(200, message('', 'refusal'))
  const res = await createAnnotateHandler(() => client)(post(body))
  check('отказ модели: 422', res.status === 422)
}

// 5. Лимит запросов → 429, ошибка API → 502
{
  const { client } = fakeClient(429, { type: 'error', error: { type: 'rate_limit_error', message: 'slow down' } })
  const res = await createAnnotateHandler(() => client)(post(body))
  check('лимит API: 429', res.status === 429)
  const { client: c2 } = fakeClient(500, { type: 'error', error: { type: 'api_error', message: 'boom' } })
  const res2 = await createAnnotateHandler(() => c2)(post(body))
  check('ошибка API: 502', res2.status === 502)
}

// 6. Модель вернула не JSON → 502
{
  const { client } = fakeClient(200, message('not json'))
  const res = await createAnnotateHandler(() => client)(post(body))
  check('некорректный JSON от модели: 502', res.status === 502)
}

console.log(failed ? `\n${failed} проверок не прошли` : '\nВсе проверки серверной разметки пройдены')
process.exit(failed ? 1 : 0)
