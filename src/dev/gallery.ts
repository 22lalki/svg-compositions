/**
 * Галерея автосборок (только dev: /compose-gallery.html?seed=1&n=36&format=square&variant=0, ?examples=1).
 * Случайные наборы объектов (или примеры дизайнера) → раскладка → картинка и метрики оценки. Для калибровки
 * норм в aesthetics.ts и оценки качества глазами.
 */
import { preloadSize } from '../compose/assets'
import { BUILTIN_ITEMS } from '../compose/catalog'
import { lookupItem, schemeById, useCatalog } from '../compose/catalogStore'
import { useComposition } from '../compose/compositionStore'
import { arrangements, scoreComposition } from '../compose/layout'
import { preloadMasks } from '../compose/masks'
import { DEFAULT_COMPOSITION, FORMAT_KEYS, SET, type FormatKey, type SizeKey } from '../compose/model'
import { buildCompositionSvg } from '../compose/render'
import { svgDataUrl } from '../lib/svg'

const q = new URLSearchParams(location.search)
let seed = Number(q.get('seed') ?? 1)
const rnd = () => ((seed = (seed * 16807) % 2147483647), seed / 2147483647)
const n = Number(q.get('n') ?? 36)
const formats = (q.get('format') ?? 'square,wide,tall').split(',') as FormatKey[]
const size = (q.get('size') ?? 'L') as SizeKey
const variant = Number(q.get('variant') ?? 0)
const examples = q.has('examples')

const pct = (v: number) => Math.round(v * 100)

async function run() {
  useCatalog.getState().init([], [])
  await preloadSize(BUILTIN_ITEMS, size)
  await preloadMasks(BUILTIN_ITEMS, size)
  const grid = document.getElementById('grid')!
  const sets = q.get('sets')?.split(';').map((x) => x.split(','))
  // ?all=1 — для наборов sets все варианты «Другого» подряд
  const showAll = q.has('all')
  const jobs: Array<{ ids: string[]; format: FormatKey; label: string; variant?: number }> = sets
    ? sets.flatMap((ids) =>
        formats.flatMap((format) => {
          const count = showAll ? Math.max(1, arrangements(ids.map((id) => BUILTIN_ITEMS.find((x) => x.id === id)!), format, size).length) : 1
          return Array.from({ length: count }, (_, v) => ({ ids, format, label: ids.join('+'), variant: showAll ? v : undefined }))
        }),
      )
    : examples
    ? SET.templates.flatMap((t) => FORMAT_KEYS.map((format) => ({ ids: t.formats[format].slots.map((s) => s.item), format, label: t.formats[format].source })))
    : Array.from({ length: n }, (_, i) => {
        const k = 2 + Math.floor(rnd() * 2)
        const ids = [...BUILTIN_ITEMS].sort(() => rnd() - 0.5).slice(0, k).map((x) => x.id)
        return { ids, format: formats[i % formats.length]!, label: String(i + 1) }
      })
  const all: unknown[] = []
  for (const job of jobs) {
    const st = useComposition.getState()
    st.init({ ...DEFAULT_COMPOSITION, format: job.format, size, schemeId: 'violet' })
    const t0 = performance.now()
    st.generate(job.ids, 'g', job.variant ?? variant)
    const ms = Math.round(performance.now() - t0)
    const c = useComposition.getState().comp
    const g = useComposition.getState().generation
    const svg = buildCompositionSvg(c, schemeById('violet'), lookupItem)
    const { metrics: m, penalty: pen } = scoreComposition(c, lookupItem)
    all.push({ label: job.label, format: job.format, ms, penalty: pen, ...m })
    const objs = m.objects.map((o) => `${o.itemId}${o.state === 'bg' ? '(ф)' : ''} в${pct(o.visible)} з${pct(o.hidden)} р${pct(o.size)} g${o.gap}`).join('<br>')
    const cell = document.createElement('div')
    cell.style.cssText = 'background:#fff;padding:3px'
    cell.innerHTML =
      `<div>${job.label} · ${job.format} · ${g ? `${g.index + 1}/${g.total}` : ''}</div><img style="width:100%" src="${svgDataUrl(svg)}">` +
      `<div>штраф ${pen.toFixed(2)} · ${ms} мс · покр ${pct(m.coverage)} бал ${pct(m.balance)} ${m.connected ? 'связно' : '<b>НЕСВЯЗНО</b>'}<br>${objs}</div>`
    grid.appendChild(cell)
  }
  ;(window as unknown as { __metrics: unknown }).__metrics = all
  document.title = 'gallery: done'
}
void run()
