/**
 * Сборка встроенного набора из материалов работодателя (materials/, в репозиторий не входит):
 *
 *  - public/set/{L,S}/{item}-{main|bg}.svg — объекты как есть, под латинскими именами;
 *  - public/set/palettes/*.svg — палитры схем (образец для загрузки своей);
 *  - src/compose/data/set.json — размеры объектов, цветовые схемы, декор фона и шаблоны раскладки.
 *
 * Шаблоны раскладки берутся из примеров композиций (materials/examples, 6 композиций × 3 формата).
 * Примеры — плоский экспорт Figma: контуры с абсолютными координатами. Объект находим по габаритам его контуров:
 * каждый контур ассета, найденный в примере с тем же размером, голосует за сдвиг; побеждает сдвиг с большинством.
 * Поворотов и масштаба в примерах нет (голоса сходятся к одному сдвигу), поэтому позиция объекта — сдвиг его рамки.
 * Состояние (основной/фоновый) — по цветам найденных контуров.
 *
 * Запуск: node scripts/build-set.mjs
 */
import fs from 'node:fs'
import path from 'node:path'

const MAT = path.resolve('materials')
const PUBLIC = path.resolve('public/set')
const OUT = path.resolve('src/compose/data/set.json')

const read = (...p) => fs.readFileSync(path.join(MAT, ...p), 'utf8')
const attr = (a, name) => new RegExp(`\\s${name}="([^"]*)"`).exec(a)?.[1]
const SIZE_RE = /width="([\d.]+)" height="([\d.]+)"/
const sizeOf = (svg) => {
  const [, w, h] = SIZE_RE.exec(svg)
  return [Number(w), Number(h)]
}

/* ---------- Цветовые схемы ---------- */

// Раскладка палитры (одинакова во всех файлах): две колонки по четыре прямоугольника.
// Левая сверху вниз — светлый, средний, темный фоновые и черный; правая — три акцента и белый
const ROLES_LEFT = ['bgLight', 'bgMid', 'bgDark', 'black']
const ROLES_RIGHT = ['accent1', 'accent2', 'accent3', 'white']
const SCHEME_NAMES = { '#D7CDF5': ['violet', 'Фиолетовая'], '#FDD7B9': ['orange', 'Оранжевая'], '#BEEBEB': ['teal', 'Бирюзовая'] }

const hex = (c) => (c === 'white' ? '#FFFFFF' : c === 'black' ? '#000000' : c.toUpperCase())

function parsePalette(svg) {
  // Клетки — rect или контур (белая клетка с обводкой экспортируется контуром); положение — левый верхний угол
  const rects = [...svg.matchAll(/<(rect|path)\b([^>]*?)\/?>/g)].map((m) => {
    const box = m[1] === 'path' ? bbox(attr(m[2], 'd')) : null
    return {
      x: Math.round(box ? box.x0 : Number(attr(m[2], 'x') ?? 0)),
      y: Math.round(box ? box.y0 : Number(attr(m[2], 'y') ?? 0)),
      fill: hex(attr(m[2], 'fill')),
    }
  })
  if (rects.length !== 8) throw new Error(`палитра: ожидалось 8 прямоугольников, найдено ${rects.length}`)
  const mid = (Math.min(...rects.map((r) => r.x)) + Math.max(...rects.map((r) => r.x))) / 2
  const column = (left) => rects.filter((r) => (r.x < mid) === left).sort((a, b) => a.y - b.y)
  const colors = {}
  column(true).forEach((r, i) => (colors[ROLES_LEFT[i]] = r.fill))
  column(false).forEach((r, i) => (colors[ROLES_RIGHT[i]] = r.fill))
  return colors
}

const schemes = fs
  .readdirSync(path.join(MAT, 'palettes', 'L'))
  .sort()
  .map((f) => {
    const colors = parsePalette(read('palettes', 'L', f))
    const small = parsePalette(read('palettes', 'S', fs.readdirSync(path.join(MAT, 'palettes', 'S')).sort()[fs.readdirSync(path.join(MAT, 'palettes', 'L')).sort().indexOf(f)]))
    if (JSON.stringify(small) !== JSON.stringify(colors)) throw new Error(`палитры L и S различаются: ${f}`)
    const [id, name] = SCHEME_NAMES[colors.bgLight]
    return { id, name, colors }
  })
// Палитры — образцы для загрузки своей схемы (и для автопроверки разбора палитры)
fs.mkdirSync(path.join(PUBLIC, 'palettes'), { recursive: true })
for (const f of fs.readdirSync(path.join(MAT, 'palettes', 'L')).sort()) {
  const id = SCHEME_NAMES[parsePalette(read('palettes', 'L', f)).bgLight][0]
  fs.copyFileSync(path.join(MAT, 'palettes', 'L', f), path.join(PUBLIC, 'palettes', `${id}.svg`))
}
const BASE = schemes.find((s) => s.id === 'violet').colors
const BG_HEX = new Set([BASE.bgLight, BASE.bgMid, BASE.bgDark, '#FFFFFF'])

/* ---------- Объекты ---------- */

// Файлы набора → объекты. Основной и фоновый варианты различаем по цветам, а не по имени файла:
// фоновый нарисован только цветами фона
const FILES = {
  L: {
    phone: ['Телефон', 'Телефон (1)'],
    puzzle: ['Пазлы', 'Пазлы (1)'],
    book: ['Книга', 'Книга (1)'],
    folder: ['Папка', 'Папка (1)'],
    coin: ['Монета', 'Монета (1)'],
    wallet: ['Кошелек', 'Кошелек (1)'],
    headphones: ['Наушники', 'Наушники (1)'],
    lamp: ['Лампа', 'Лампа (1)'],
    pen: ['Ручка', 'Ручка (1)'],
    person: ['Group 2136136344', 'Group 2136136347'],
  },
  S: {
    phone: ['Телефон', 'Телефон (1)'],
    puzzle: ['Пазлы', 'Пазлы (1)'],
    book: ['Group 2136136335', 'Group 2136136341'],
    folder: ['Group 2136136337', 'Group 2136136342'],
    coin: ['Монета', 'Монета (1)'],
    wallet: ['Кошелек', 'Кошелек (1)'],
    headphones: ['Наушники', 'Наушники (1)'],
    lamp: ['Лампа', 'Лампа (1)'],
    pen: ['Group 2136136336', 'Group 2136136343'],
    person: ['Group 2136136345', 'Group 2136136346'],
  },
}

const fillsOf = (svg) => new Set([...svg.matchAll(/\s(?:fill|stroke)="([^"]+)"/g)].map((m) => m[1]).filter((c) => c !== 'none').map(hex))
const palette = new Set(Object.values(BASE))

const items = {}
for (const size of ['L', 'S']) {
  fs.mkdirSync(path.join(PUBLIC, size), { recursive: true })
  for (const [id, names] of Object.entries(FILES[size])) {
    const variants = names.map((n) => read(size, `${n}.svg`))
    const states = variants.map((svg) => ([...fillsOf(svg)].every((c) => BG_HEX.has(c)) ? 'bg' : 'main'))
    if (states.sort().join() !== 'bg,main') throw new Error(`${size}/${id}: нужен один основной и один фоновый вариант`)
    const dims = variants.map(sizeOf)
    if (dims[0].join() !== dims[1].join()) throw new Error(`${size}/${id}: размеры вариантов различаются`)
    variants.forEach((svg, i) => {
      const state = [...fillsOf(svg)].every((c) => BG_HEX.has(c)) ? 'bg' : 'main'
      const foreign = [...fillsOf(svg)].filter((c) => !palette.has(c))
      if (foreign.length) throw new Error(`${size}/${id}: цвета вне схемы ${foreign.join(', ')}`)
      fs.writeFileSync(path.join(PUBLIC, size, `${id}-${state}.svg`), svg)
    })
    ;(items[id] ??= {})[size] = dims[0]
  }
}

/* ---------- Разбор контуров ---------- */

/** Габариты контура по опорным точкам (для сопоставления хватает: одинаковые контуры дают одинаковые числа) */
function bbox(d) {
  const toks = d.match(/[A-Za-z]|-?(?:\d+\.?\d*|\.\d+)(?:e-?\d+)?/g) ?? []
  let cur = ''
  let k = 0
  const xs = []
  const ys = []
  for (const t of toks) {
    if (/[A-Za-z]/.test(t)) {
      cur = t
      k = 0
      continue
    }
    const v = Number(t)
    if (cur === 'H') xs.push(v)
    else if (cur === 'V') ys.push(v)
    else (k % 2 ? ys : xs).push(v)
    k++
  }
  if (!xs.length || !ys.length) return null
  return { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) }
}

/** Элементы верхнего уровня: rect фона и контуры (<defs> с clipPath пропускаем) */
function elements(svg) {
  const out = []
  for (const m of svg.replace(/<defs>[\s\S]*?<\/defs>/g, '').matchAll(/<(path|rect)\b([^>]*?)\/?>/g)) {
    const a = m[2]
    if (m[1] === 'rect') {
      out.push({ tag: 'rect', fill: attr(a, 'fill') })
      continue
    }
    const d = attr(a, 'd')
    out.push({ tag: 'path', d, fill: attr(a, 'fill'), stroke: attr(a, 'stroke'), strokeWidth: attr(a, 'stroke-width'), box: bbox(d) })
  }
  return out
}

/* ---------- Декор фона ---------- */

const ROLE_BY_HEX = Object.fromEntries(Object.entries(BASE).map(([role, c]) => [c, role]))

/** Элемент декора с цветами-ролями; null — цвет не из фоновых (значит, это часть объекта) */
function decorElement(e, schemeColors = BASE) {
  const roleOf = (c) => {
    const role = Object.entries(schemeColors).find(([, v]) => v === hex(c))?.[0]
    return role && ['bgLight', 'bgMid', 'bgDark', 'white'].includes(role) ? role : null
  }
  if (e.tag === 'rect') return null // сплошная заливка фона рисуется отдельно
  const el = { d: e.d }
  if (e.fill && e.fill !== 'none') el.fill = roleOf(e.fill)
  if (e.stroke) {
    el.stroke = roleOf(e.stroke)
    el.strokeWidth = Number(e.strokeWidth ?? 1)
  }
  if ((e.fill && e.fill !== 'none' && !el.fill) || (e.stroke && !el.stroke)) return null
  return el
}

/** Половинный масштаб контура для размера S: все команды в примерах абсолютные (M L C H V Z) */
const halfPath = (d) => {
  if (/[a-y]/.test(d.replace(/z/g, '')) || /A/.test(d)) throw new Error(`относительные команды или дуги в декоре: ${d.slice(0, 40)}`)
  return d.replace(/-?(?:\d+\.?\d*|\.\d+)(?:e-?\d+)?/g, (n) => String(Number((Number(n) / 2).toFixed(4))))
}

const FORMATS = { square: [1000, 1000], wide: [1200, 630], tall: [800, 1200] }
const formatOf = (w, h) => Object.entries(FORMATS).find(([, [fw, fh]]) => fw === w && fh === h)?.[0]

/** Декор из готового фона: цвета фона сопоставляем ролям его же схемы */
function decorFromBackground(file) {
  const svg = read('backgrounds', file)
  const bg = hex(attr(/<rect\b([^>]*)>/.exec(svg)[1], 'fill'))
  const scheme = schemes.find((s) => s.colors.bgLight === bg)
  return elements(svg).flatMap((e) => (e.tag === 'rect' ? [] : [decorElement(e, scheme.colors)]))
}

/* ---------- Шаблоны из примеров ---------- */

// Контуры обоих вариантов: геометрия у них общая (тот же порядок контуров), различаются только цвета
const assets = Object.entries(FILES.L).map(([id, files]) => {
  const variants = {}
  for (const file of files) {
    const svg = read('L', `${file}.svg`)
    const state = [...fillsOf(svg)].every((c) => BG_HEX.has(c)) ? 'bg' : 'main'
    variants[state] = elements(svg).filter((e) => e.box)
  }
  const [width, height] = sizeOf(read('L', `${files[0]}.svg`))
  const sameGeometry = variants.main.length === variants.bg.length && variants.main.every((p, i) => p.d === variants.bg[i].d)
  return { id, width, height, paths: variants.main, variants: sameGeometry ? variants : { main: variants.main } }
})

const median = (v) => [...v].sort((a, b) => a - b)[Math.floor(v.length / 2)]

function findObject(asset, els) {
  const votes = new Map()
  for (const { box: p } of asset.paths) {
    const w = p.x1 - p.x0
    const h = p.y1 - p.y0
    if (w < 8 || h < 8) continue
    els.forEach((e, i) => {
      const q = e.box
      if (!q || Math.abs(q.x1 - q.x0 - w) > 0.6 || Math.abs(q.y1 - q.y0 - h) > 0.6) return
      const dx = q.x0 - p.x0
      const dy = q.y0 - p.y0
      const key = `${Math.round(dx)},${Math.round(dy)}`
      const v = votes.get(key) ?? { dxs: [], dys: [], idx: new Set() }
      v.dxs.push(dx)
      v.dys.push(dy)
      v.idx.add(i)
      votes.set(key, v)
    })
  }
  const best = [...votes.values()].sort((a, b) => b.idx.size - a.idx.size)[0]
  if (!best || best.idx.size < 5) return null
  const x = +median(best.dxs).toFixed(2)
  const y = +median(best.dys).toFixed(2)
  // Пары «контур ассета → контур примера» при найденном сдвиге; из одинаковых по габаритам — ближайший по длине d
  const pairs = []
  asset.paths.forEach((p, pi) => {
    const cands = els
      .map((e, i) => ({ e, i }))
      .filter(({ e }) => e.box && ['x0', 'y0', 'x1', 'y1'].every((k) => Math.abs(e.box[k] - p.box[k] - (k[0] === 'x' ? x : y)) < 0.6))
      .sort((a, b) => Math.abs(a.e.d.length - p.d.length) - Math.abs(b.e.d.length - p.d.length))
    if (cands[0]) pairs.push([pi, cands[0].i])
  })
  return { id: asset.id, x, y, width: asset.width, height: asset.height, matched: best.idx, pairs, asset }
}

/** Ближайшая роль набора для цвета примера (в примерах встречаются оттенки старых версий: #0C0C0D, #F5EFC9) */
function nearestRole(c) {
  const rgb = (h) => [1, 3, 5].map((k) => Number.parseInt(h.slice(k, k + 2), 16))
  const [r, g, b] = rgb(hex(c))
  let best = null
  let bestD = Infinity
  for (const [role, h] of Object.entries(BASE)) {
    const [r2, g2, b2] = rgb(h)
    const d = (r - r2) ** 2 + (g - g2) ** 2 + (b - b2) ** 2
    if (d < bestD) {
      bestD = d
      best = role
    }
  }
  return best
}

/**
 * Перекраска объекта дизайнером в примере: по парам контуров голосуем «роль в файле → роль в примере».
 * Берем только уверенное большинство (больше 70% голосов роли) — так оттенки старых версий не дают ложных замен
 */
function colorOverrides(o, els) {
  const paths = o.asset.variants[o.state]
  if (!paths) return {}
  const votes = {}
  for (const [pi, i] of o.pairs) {
    const fill = els[i].fill
    if (!fill || fill === 'none' || fill.startsWith('url(')) continue
    const src = ROLE_BY_HEX[hex(paths[pi].fill)]
    if (!src) continue
    const dst = nearestRole(fill)
    ;(votes[src] ??= {})[dst] = (votes[src][dst] ?? 0) + 1
  }
  const out = {}
  for (const [src, v] of Object.entries(votes)) {
    const total = Object.values(v).reduce((a, b) => a + b, 0)
    const [dst, n] = Object.entries(v).sort((a, b) => b[1] - a[1])[0]
    const bgOnly = ['bgLight', 'bgMid', 'bgDark', 'white']
    if (dst !== src && n / total > 0.7 && total >= 2 && (o.state === 'main' || bgOnly.includes(dst))) out[src] = dst
  }
  return out
}

/** Контур внутри рамки объекта — часть объекта. Запас: опорные точки кривых и тени старых версий выходят за рамку */
const inside = (b, o) => {
  const m = 6 + 0.05 * Math.max(o.width, o.height)
  return b && b.x0 >= o.x - m && b.y0 >= o.y - m && b.x1 <= o.x + o.width + m && b.y1 <= o.y + o.height + m
}

// Цвета примеров, считающиеся фоновыми (для определения состояния объекта)
const EXAMPLE_BG = new Set([...BG_HEX, 'WHITE'])

const exampleFiles = fs
  .readdirSync(path.join(MAT, 'examples'))
  .filter((f) => f.endsWith('.svg'))
  .sort((a, b) => Number(a.match(/\d+/)) - Number(b.match(/\d+/)))
if (exampleFiles.length !== 18) throw new Error(`ожидалось 18 примеров, найдено ${exampleFiles.length}`)

const examples = exampleFiles.map((f) => {
  const svg = read('examples', f)
  const [w, h] = sizeOf(svg)
  const format = formatOf(w, h)
  if (!format) throw new Error(`${f}: неизвестный формат ${w}×${h}`)
  const els = elements(svg)
  const objects = assets.map((a) => findObject(a, els)).filter(Boolean)
  // Элемент, совпавший с контуром ассета, — точно часть объекта. Остальные — тоже объекта, если помещаются
  // в его рамку (старые версии ассетов, тени), иначе декор. Линии декора (только обводка) — всегда декор
  const owner = els.map((e, i) => {
    if (e.tag === 'rect' || (e.stroke && !e.fill)) return null
    const exact = objects.find((o) => o.matched.has(i))
    if (exact) return exact
    const area = (o) => o.width * o.height
    return objects.filter((o) => inside(e.box, o)).sort((a, b) => area(a) - area(b))[0] ?? null
  })
  for (const o of objects) {
    const idx = [...o.matched]
    const colors = idx.flatMap((i) => [els[i].fill, els[i].stroke]).filter((c) => c && c !== 'none').map(hex)
    o.state = colors.every((c) => EXAMPLE_BG.has(c)) ? 'bg' : 'main'
    o.z = Math.min(...idx)
  }
  objects.sort((a, b) => a.z - b.z)
  const decor = els.flatMap((e, i) => (owner[i] ? [] : (decorElement(e) ?? [])))
  return {
    file: f,
    format,
    // В примерах два вида декора: «клин» (клин в углу и две линии) и «круги» (круги, линии)
    decorKind: decor.length > 3 ? 'circles' : 'wedge',
    decor,
    slots: objects.map((o) => {
      const colors = colorOverrides(o, els)
      return { item: o.id, state: o.state, x: o.x, y: o.y, ...(Object.keys(colors).length ? { colors } : {}) }
    }),
  }
})

// 6 композиций подряд для каждого формата: примеры 6–11 квадрат, 12–17 горизонталь, 18–23 вертикаль
const templates = Array.from({ length: 6 }, (_, comp) => {
  const formats = {}
  for (const format of Object.keys(FORMATS)) {
    const ex = examples.filter((e) => e.format === format)[comp]
    formats[format] = { decor: ex.decorKind, slots: ex.slots, source: ex.file }
  }
  const sig = (f) => formats[f].slots.map((s) => s.item).sort().join()
  if (new Set(Object.keys(FORMATS).map(sig)).size !== 1) throw new Error(`композиция ${comp + 1}: разные объекты в форматах`)
  return { id: `example-${comp + 1}`, formats }
})

// Декор L: квадрат — из готовых фонов набора; горизонталь и вертикаль — из примеров (самый полный вариант каждого вида).
// Декор S — половинный масштаб L с той же толщиной линий (так сделаны фоны S 500×500)
const decorL = { square: { circles: decorFromBackground('L/Фон.svg'), wedge: decorFromBackground('L/Фон (1).svg') } }
for (const format of ['wide', 'tall']) {
  decorL[format] = {}
  for (const kind of ['circles', 'wedge']) {
    const best = examples.filter((e) => e.format === format && e.decorKind === kind).sort((a, b) => b.decor.length - a.decor.length)[0]
    decorL[format][kind] = best.decor
  }
}
const decorS = { square: { circles: decorFromBackground('S/Фон (3).svg'), wedge: decorFromBackground('S/Фон (4).svg') } }
for (const format of ['wide', 'tall']) {
  decorS[format] = {}
  for (const kind of ['circles', 'wedge']) decorS[format][kind] = decorL[format][kind].map((e) => ({ ...e, d: halfPath(e.d) }))
}
// Проверка половинного масштаба на готовых фонах S
for (const kind of ['circles', 'wedge']) {
  const a = decorL.square[kind].map((e) => bbox(halfPath(e.d)))
  const b = decorS.square[kind].map((e) => bbox(e.d))
  const off = Math.max(...a.flatMap((x, i) => ['x0', 'y0', 'x1', 'y1'].map((k) => Math.abs(x[k] - b[i][k]))))
  if (off > 1) throw new Error(`декор S «${kind}» не совпадает с половиной L: ${off}`)
}

const data = { schemes, items, formats: FORMATS, decor: { L: decorL, S: decorS }, templates }
fs.mkdirSync(path.dirname(OUT), { recursive: true })
fs.writeFileSync(OUT, JSON.stringify(data) + '\n')

for (const t of templates) {
  console.log(t.id, Object.entries(t.formats).map(([f, v]) => `${f}:${v.decor}[${v.slots.map((s) => `${s.item}/${s.state}${s.colors ? JSON.stringify(s.colors) : ''}`).join(' ')}]`).join('  '))
}
console.log(`схемы: ${schemes.map((s) => s.name).join(', ')}; объектов: ${Object.keys(items).length}`)
console.log(`→ ${path.relative(process.cwd(), OUT)} (${(fs.statSync(OUT).size / 1024).toFixed(0)} КБ), public/set/`)
