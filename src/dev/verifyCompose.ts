/**
 * Самопроверка режима «Композиции» (только dev: /compose-verify.html, запускается scripts/verify-compose.mjs).
 *
 *  1. Примеры дизайнера: те же объекты в том же формате дают ту же раскладку (позиции, состояния, порядок слоев,
 *     перекраску объектов) —
 *     для 18 примеров в размере L и их половинных версий в размере S.
 *  2. Смена формата пересобирает композицию по ячейкам шаблона нового формата — как дизайнер перекладывал примеры.
 *  3. Смена размера L→S→L возвращает позиции; объекты подменяются вариантами нужного размера.
 *  4. Правила ТЗ на всех парах и тройках объектов × 3 формата × 2 размера × 3 схемы × первые варианты раскладки:
 *     масштаб 1 (в трансформациях нет scale), цвета только из схемы, в фоновых объектах и фоне — только цвета фона,
 *     основной объект виден в кадре хотя бы на 45% (у дизайнера в примерах — от 48%), число объектов равно числу запрошенных, SVG корректен.
 *  5. Перекраска: роль меняется на выбранную; фоновому объекту нельзя дать цвет объекта.
 *  6. Палитры набора распознаются при загрузке ровно в свои схемы.
 *  7. Загрузка своей библиотеки: «Телефон.svg» + «Телефон (1).svg» → один объект с основным и фоновым вариантом.
 *  8. Словарь метафор: фразы → ожидаемые объекты.
 */
import { preloadSize } from '../compose/assets'
import { preloadMasks } from '../compose/masks'
import { BUILTIN_ITEMS, itemSize } from '../compose/catalog'
import { lookupItem, schemeById, useCatalog } from '../compose/catalogStore'
import { useComposition } from '../compose/compositionStore'
import { arrangements, scoreComposition } from '../compose/layout'
import { LARGE } from '../compose/aesthetics'
import { itemsByNames, metaphorSets, pickByMetaphor } from '../compose/metaphor'
import { BUILTIN_SCHEMES, DEFAULT_COMPOSITION, FORMAT_KEYS, SET, schemeColor, schemeColors, schemeKeys, type Composition, type FormatKey, type Scheme, type SizeKey } from '../compose/model'
import { buildCompositionSvg, colorsInSvg, resolveObjects, validateComposition } from '../compose/render'
import { parseHexGroups, parsePaletteSvg } from '../compose/schemes'
import { importObjectFiles } from '../compose/upload'

type Check = { group: string; name: string; ok: boolean; detail?: string }
const checks: Check[] = []
const check = (group: string, name: string, ok: boolean, detail?: string) => checks.push({ group, name, ok, detail: ok ? undefined : detail })
const close = (a: number, b: number, eps = 0.02) => Math.abs(a - b) <= eps

const items = BUILTIN_ITEMS
const byId = (id: string) => items.find((i) => i.id === id)!

function compositionFrom(itemIds: string[], format: FormatKey, size: SizeKey, schemeId: string, variant = 0): Composition | null {
  const st = useComposition.getState()
  st.init({ ...DEFAULT_COMPOSITION, format, size, schemeId })
  if (!st.generate(itemIds, 'test', variant)) return null
  return useComposition.getState().comp
}

async function run() {
  useCatalog.getState().init([], [])
  await Promise.all([preloadSize(items, 'L'), preloadSize(items, 'S')])
  await Promise.all([preloadMasks(items, 'L'), preloadMasks(items, 'S')])

  // 1. Примеры дизайнера
  for (const t of SET.templates) {
    for (const format of FORMAT_KEYS) {
      for (const size of ['L', 'S'] as const) {
        const slots = t.formats[format].slots
        const k = size === 'L' ? 1 : 0.5
        const best = arrangements(slots.map((s) => byId(s.item)), format, size)[0]
        const same =
          !!best &&
          best.templateId === t.id &&
          !best.mirror &&
          best.placements.length === slots.length &&
          best.placements.every((p, i) => p.itemId === slots[i]!.item && p.state === slots[i]!.state && JSON.stringify(p.colors ?? {}) === JSON.stringify(slots[i]!.colors ?? {}) && close(p.x, slots[i]!.x * k, 0.6 * (1 - k) + 0.02) && close(p.y, slots[i]!.y * k, 0.6 * (1 - k) + 0.02))
        check('1. Примеры', `${t.formats[format].source} ${size}`, same, JSON.stringify(best?.placements.map((p) => [p.itemId, p.state, p.x, p.y])) + ' ≠ ' + JSON.stringify(slots.map((s) => [s.item, s.state, s.x * k, s.y * k])))
      }
    }
  }

  // Пересобранные примеры — для визуальной сверки с оригиналами (scripts/verify-compose.mjs кладет их рядом)
  const rebuilt: Record<string, string> = {}
  for (const t of SET.templates) {
    for (const format of FORMAT_KEYS) {
      const c = compositionFrom(t.formats[format].slots.map((s) => s.item), format, 'L', 'violet')
      if (c) rebuilt[t.formats[format].source] = buildCompositionSvg(c, schemeById('violet'), lookupItem)
    }
  }
  ;(window as unknown as { __rebuilt: typeof rebuilt }).__rebuilt = rebuilt

  // 2. Смена формата: собрали в квадрате → переключили формат → позиции как в примере этого формата
  for (const t of SET.templates) {
    const ids = t.formats.square.slots.map((s) => s.item)
    compositionFrom(ids, 'square', 'L', 'violet')
    for (const format of ['wide', 'tall'] as const) {
      useComposition.getState().setFormat(format)
      const c = useComposition.getState().comp
      const slots = t.formats[format].slots
      const ok = slots.every((s) => c.objects.some((o) => o.itemId === s.item && o.state === s.state && close(o.x, s.x) && close(o.y, s.y)))
      check('2. Смена формата', `${t.id}: квадрат → ${format}`, ok, JSON.stringify(c.objects.map((o) => [o.itemId, o.x, o.y])))
    }
  }

  // 3. Смена размера туда и обратно
  {
    const c0 = compositionFrom(['book', 'phone'], 'wide', 'L', 'teal')!
    const st = useComposition.getState()
    st.setSize('S')
    const s = useComposition.getState().comp
    const halved = s.objects.every((o, i) => {
      const a = c0.objects[i]!
      const item = lookupItem(o.itemId)!
      const L = itemSize(item, 'L', o.state)!
      const S = itemSize(item, 'S', o.state)!
      return close(o.x + S.width / 2, (a.x + L.width / 2) / 2, 0.02) && close(o.y + S.height / 2, (a.y + L.height / 2) / 2, 0.02)
    })
    check('3. Размер', 'L → S: центры объектов вдвое ближе к началу', halved, JSON.stringify(s.objects))
    st.setSize('L')
    const back = useComposition.getState().comp.objects.every((o, i) => close(o.x, c0.objects[i]!.x, 0.05) && close(o.y, c0.objects[i]!.y, 0.05))
    check('3. Размер', 'S → L возвращает позиции', back)
    const svg = buildCompositionSvg(s, schemeById('teal'), lookupItem)
    check('3. Размер', 'экспорт S: кадр 600×315', svg.includes('width="600" height="315"'))
  }

  // 4. Правила на множестве сочетаний
  const ids = items.map((i) => i.id)
  const combos: string[][] = []
  for (let a = 0; a < ids.length; a++) {
    for (let b = a + 1; b < ids.length; b++) {
      combos.push([ids[a]!, ids[b]!])
      for (let c = b + 1; c < ids.length; c++) combos.push([ids[a]!, ids[b]!, ids[c]!])
    }
  }
  combos.push(['phone'], ['coin', 'wallet', 'book', 'lamp'], ['pen', 'puzzle', 'person', 'headphones', 'folder'])
  let total = 0
  const failures: string[] = []
  // Качество: укладывается ли раскладка в нормы примеров дизайнера (штраф aesthetics.ts почти нулевой)
  const quality = { first: 0, firstOk: 0, all: 0, allOk: 0, worst: [] as Array<[number, string]>, perched: [] as string[] }
  const parser = new DOMParser()
  for (const combo of combos) {
    for (const format of FORMAT_KEYS) {
      for (const size of ['L', 'S'] as const) {
        const variants = Math.min(3, arrangements(combo.map(byId), format, size).length)
        for (let v = 0; v < variants; v++) {
          const scheme = BUILTIN_SCHEMES[(total + v) % BUILTIN_SCHEMES.length]!
          const c = compositionFrom(combo, format, size, scheme.id, v)
          total++
          const tag = `${combo.join('+')} ${format} ${size} #${v + 1} ${scheme.id}`
          if (!c) {
            failures.push(`${tag}: не собралась`)
            continue
          }
          if (c.objects.length !== combo.length) failures.push(`${tag}: объектов ${c.objects.length}`)
          const svg = buildCompositionSvg(c, scheme, lookupItem)
          if (/scale\(|matrix\((?!-1 0 0 1 )/.test(svg)) failures.push(`${tag}: масштаб в трансформации`)
          const allowed = new Set(schemeColors(scheme))
          const foreign = colorsInSvg(svg).filter((x) => !allowed.has(x))
          if (foreign.length) failures.push(`${tag}: цвета вне схемы ${foreign.join(',')}`)
          const issues = validateComposition(c, scheme, lookupItem)
          if (issues.length) failures.push(`${tag}: ${issues.map((i) => i.text).join('; ')}`)
          if (parser.parseFromString(svg, 'image/svg+xml').querySelector('parsererror')) failures.push(`${tag}: SVG не разбирается`)
          // Читаемость по форме объекта (маске): основной виден хотя бы наполовину (у дизайнера — от 54%),
          // небольшой основной заметно не закрыт (до 15%), фоновый виден хотя бы на треть. Для 5 объектов в одном
          // кадре это недостижимо без масштаба (сервис об этом предупреждает), поэтому — для наборов до 4 объектов
          const { metrics: m, penalty: pen } = scoreComposition(c, lookupItem)
          const pct = (x: number) => Math.round(x * 100)
          for (const o of combo.length <= 4 ? m.objects : []) {
            if (o.state === 'main' && o.visible < 0.5) failures.push(`${tag}: ${o.itemId} виден на ${pct(o.visible)}%`)
            if (o.state === 'main' && o.size < LARGE && o.hidden > 0.15) failures.push(`${tag}: ${o.itemId} закрыт на ${pct(o.hidden)}%`)
            if (o.state === 'bg' && o.visible < 0.35) failures.push(`${tag}: фоновый ${o.itemId} виден на ${pct(o.visible)}%`)
          }
          quality.all++
          if (pen <= 0.1) quality.allOk++
          if (v === 0) {
            quality.first++
            if (pen <= 0.1) quality.firstOk++
            quality.worst.push([pen, tag])
            const sits = m.objects.find((o) => o.perched > 0.05)
            if (sits) quality.perched.push(`${tag}: ${sits.itemId} лежит на чужом объекте на ${pct(sits.perched)}%`)
          }
          if (resolveObjects(c, scheme, lookupItem).length !== c.objects.length) failures.push(`${tag}: не все файлы загружены`)
        }
      }
    }
  }
  check('4. Правила', `${total} композиций: масштаб 1, цвета схемы, фон — цвета фона, объекты читаются`, failures.length === 0, failures.slice(0, 8).join('\n'))
  const share = (a: number, b: number) => Math.round((a / b) * 100)
  quality.worst.sort((a, b) => b[0] - a[0])
  check(
    '4. Правила',
    `первые варианты: объекты не лежат на лампе, букете, наушниках — только на книге или папке (нарушений ${quality.perched.length} из ${quality.first})`,
    quality.perched.length <= quality.first * 0.03,
    quality.perched.slice(0, 6).join('\n'),
  )
  check(
    '4. Правила',
    `качество: в нормах дизайнера ${share(quality.firstOk, quality.first)}% первых вариантов, ${share(quality.allOk, quality.all)}% всех показанных`,
    quality.firstOk / quality.first >= 0.85,
    'хуже всех: ' + quality.worst.slice(0, 6).map(([p, t]) => `${t} (${p.toFixed(2)})`).join('; '),
  )

  // Разнообразие «Другого»: в паре каждый объект хотя бы раз фоновый, варианты различаются не только сдвигами
  {
    const bad: string[] = []
    let slowest = 0
    for (const pair of [['pen', 'wallet'], ['phone', 'headphones'], ['coin', 'puzzle'], ['book', 'pen'], ['pen', 'puzzle']]) {
      for (const format of FORMAT_KEYS) {
        const t0 = performance.now()
        const list = arrangements(pair.map(byId), format, 'L')
        slowest = Math.max(slowest, performance.now() - t0)
        const sig = new Set(list.map((a) => `${a.templateId}:${a.mirror}:${a.placements.filter((p) => p.state === 'bg').map((p) => p.itemId).sort()}`))
        for (const id of pair) {
          if (!list.some((a) => a.placements.some((p) => p.itemId === id && p.state === 'bg'))) bad.push(`${pair.join('+')} ${format}: ${id} ни разу не фоновый`)
        }
        if (sig.size < Math.min(5, list.length)) bad.push(`${pair.join('+')} ${format}: различных вариантов ${sig.size} из ${list.length}`)
      }
    }
    check('4. Правила', `«Другой»: каждый объект пары бывает фоновым, варианты разные (сборка до ${Math.round(slowest)} мс)`, bad.length === 0, bad.slice(0, 6).join('\n'))
  }

  // Все объекты набора сразу: сборка не подвешивает вкладку, и «Другой» есть
  for (const format of FORMAT_KEYS) {
    const t0 = performance.now()
    const list = arrangements(items, format, 'L')
    const ms = Math.round(performance.now() - t0)
    check('4. Правила', `все ${items.length} объектов, ${format}: собрано за ${ms} мс, вариантов ${list.length}`, ms < 1000 && list.length >= 2, `${ms} мс, ${list.length}`)
  }

  // 5. Перекраска и правило «в фоне — только цвета фона»
  {
    const c = compositionFrom(['phone', 'puzzle'], 'square', 'L', 'orange')!
    const st = useComposition.getState()
    const main = c.objects.find((o) => o.state === 'main')!
    const orange = schemeById('orange')
    st.setColor(main.id, 'accent1', 'bg.2')
    let o = useComposition.getState().comp.objects.find((x) => x.id === main.id)!
    const svg = buildCompositionSvg(useComposition.getState().comp, orange, lookupItem)
    const group = new RegExp(`<g id="[^"]*" data-state="основной" transform="[^"]*">.*?</g>`).exec(svg)?.[0] ?? ''
    check('5. Перекраска', 'основной: акцент 1 → темный цвет фона', o.colors.accent1 === 'bg.2' && !colorsInSvg(group).includes(orange.accents[0]!))
    st.setState(main.id, 'bg')
    st.setColor(main.id, 'bgDark', 'obj.0')
    o = useComposition.getState().comp.objects.find((x) => x.id === main.id)!
    check('5. Перекраска', 'фоновому нельзя дать цвет объекта', !o.colors.bgDark && o.state === 'bg')
    st.setColor(main.id, 'bgDark', 'bg.1')
    o = useComposition.getState().comp.objects.find((x) => x.id === main.id)!
    check('5. Перекраска', 'фоновому можно дать другой цвет фона', o.colors.bgDark === 'bg.1')
    check('5. Перекраска', 'после правок схема соблюдена', validateComposition(useComposition.getState().comp, schemeById('orange'), lookupItem).length === 0)
  }

  // 6. Палитры: набора — ровно в свои схемы; с другим числом цветов — разбор и соблюдение правил в композициях
  const colorsOf = (x: Scheme) => JSON.stringify([x.bg, x.accents, x.black, x.white])
  for (const s of BUILTIN_SCHEMES) {
    const text = await fetch(`/set/palettes/${s.id}.svg`).then((r) => r.text())
    try {
      const { scheme: parsed } = parsePaletteSvg(text, s.id, s.name)
      check('6. Палитры', s.name, colorsOf(parsed) === colorsOf(s), colorsOf(parsed))
    } catch (e) {
      check('6. Палитры', s.name, false, String(e))
    }
  }
  /** Палитра-SVG: колонки (или ряды) клеток 100×60 с промежутком, как в наборе */
  const palette = (groups: string[][], rows = false) => {
    const cells = groups.flatMap((g, gi) =>
      g.map((c, i) => {
        const [x, y] = rows ? [i * 110, gi * 70] : [gi * 110, i * 70]
        return `<rect x="${x}" y="${y}" width="100" height="60" fill="${c}"/>`
      }),
    )
    return `<svg xmlns="http://www.w3.org/2000/svg" width="900" height="900"><text x="0" y="890">подпись</text>${cells.join('')}</svg>`
  }
  const cases: Array<{ name: string; svg: string; want: (x: Scheme) => boolean }> = [
    {
      name: '2 цвета фона + 5 цветов объектов, черный справа, белый слева',
      svg: palette([['#E8F0FF', '#FFFFFF', '#5470C6'], ['#FF7F50', '#FFD166', '#06D6A0', '#118AB2', '#EF476F', '#111111']]),
      want: (x) => x.bg.length === 2 && x.accents.length === 5 && x.black === '#111111' && x.white === '#FFFFFF',
    },
    {
      name: '6 цветов фона + 1 цвет объектов, без черного и белого',
      svg: palette([['#FFF4E6', '#FFE0B3', '#FFC680', '#FFAB4D', '#FF8F1A', '#B35C00'], ['#2E86AB']]),
      want: (x) => x.bg.length === 6 && x.accents.length === 1 && x.black === '#B35C00' && x.white === '#FFF4E6',
    },
    {
      name: 'два ряда: сверху 3 цвета фона, снизу 4 цвета объектов и черный',
      svg: palette([['#F1F8E9', '#AED581', '#558B2F'], ['#FF6F61', '#6B5B95', '#88B04B', '#F7CAC9', '#1A1A1A']], true),
      want: (x) => x.bg.length === 3 && x.accents.length === 4 && x.black === '#1A1A1A',
    },
  ]
  const custom: Scheme[] = []
  for (const k of cases) {
    try {
      const { scheme: x } = parsePaletteSvg(k.svg, `test-${custom.length}`, k.name)
      // Каждый цвет палитры доступен своим ключом (ключи цветов не путаются с именами ролей файлов)
      const keyed = schemeKeys(x).map((key) => schemeColor(x, key))
      check('6. Палитры', k.name, k.want(x) && new Set(keyed).size === schemeColors(x).length, `${colorsOf(x)} → ${keyed.join(' ')}`)
      custom.push(x)
    } catch (e) {
      check('6. Палитры', k.name, false, String(e))
    }
  }
  // Раскладка без двух групп (один ряд, сетка): группы по цветам — светлые и приглушенные в фон
  {
    const row = parsePaletteSvg(palette([['#000000'], ['#22B278'], ['#970000']]), 'r', 'r')
    check('6. Палитры', 'один ряд: черный, зеленый, красный — принят, группы по цветам', row.auto && row.scheme.black === '#000000' && row.scheme.bg.join() === '#22B278' && row.scheme.accents.join() === '#970000', colorsOf(row.scheme))
    const grid = parsePaletteSvg(palette([['#F4F1EA', '#E9C46A', '#264653'], ['#E0E7EF', '#F4A261', '#FFFFFF'], ['#C9D6DF', '#E76F51', '#2A9D8F']], true), 'g', 'g')
    check('6. Палитры', 'сетка 3×3 — принята: светлые приглушенные в фон, яркие в объекты, черный и белый по значению', grid.auto && grid.scheme.bg[0] === '#F4F1EA' && grid.scheme.bg.includes('#E0E7EF') && grid.scheme.accents.includes('#E76F51') && grid.scheme.black === '#264653' && grid.scheme.white === '#FFFFFF', colorsOf(grid.scheme))
    custom.push(row.scheme, grid.scheme)
  }
  const hex = parseHexGroups('#FDF6EC #F3D9B1 #C29875 | #3D5A80 #EE6C4D #293241 #FFFFFF', 'h', 'h')
  check('6. Палитры', 'HEX двумя группами: «фон | объекты»', hex.bg.length === 3 && hex.accents.length === 2 && hex.black === '#293241' && hex.white === '#FFFFFF', colorsOf(hex))
  // Композиции в палитрах другой длины: только цвета палитры, фоновым — только цвета фона, перекраска дизайнера работает
  {
    const bad: string[] = []
    for (const sc of custom) {
      useCatalog.getState().addScheme(sc)
      for (const combo of [['lamp', 'wallet', 'coin'], ['person', 'headphones'], ['pen', 'book', 'puzzle'], ['phone', 'folder']]) {
        for (const format of FORMAT_KEYS) {
          const c = compositionFrom(combo, format, 'L', sc.id)!
          const svg = buildCompositionSvg(c, sc, lookupItem)
          const allowed = new Set(schemeColors(sc))
          const foreign = colorsInSvg(svg).filter((x) => !allowed.has(x))
          const issues = validateComposition(c, sc, lookupItem)
          if (foreign.length || issues.length) bad.push(`${sc.name} ${combo.join('+')} ${format}: ${foreign.join(',')} ${issues.map((i) => i.text).join('; ')}`)
        }
      }
      useCatalog.getState().removeScheme(sc.id)
    }
    check('6. Палитры', 'композиции в палитрах 2+5, 6+1, 3+4, в один ряд и сеткой: только цвета палитры, фон — цвета фона', bad.length === 0 && custom.length === 5, bad.slice(0, 4).join('\n'))
  }

  // 7. Загрузка своей библиотеки
  {
    const file = async (url: string, name: string, dir?: string) => {
      const f = new File([await fetch(url).then((r) => r.text())], name, { type: 'image/svg+xml' })
      if (dir) Object.defineProperty(f, 'webkitRelativePath', { value: `${dir}/${name}` })
      return f
    }
    const { added, notes } = await importObjectFiles([
      await file('/set/L/phone-main.svg', 'Телефон.svg', 'Набор/L'),
      await file('/set/L/phone-bg.svg', 'Телефон (1).svg', 'Набор/L'),
      await file('/set/S/phone-main.svg', 'Телефон.svg', 'Набор/S'),
      await file('/set/S/phone-bg.svg', 'Телефон (1).svg', 'Набор/S'),
      await file('/set/L/coin-main.svg', 'Монета.svg'),
    ])
    const phone = added.find((a) => a.item.name === 'Телефон')
    check('7. Загрузка', 'варианты сгруппированы: L/S × основной/фоновый', !!phone && Object.keys(phone.assets).sort().join() === 'L-bg,L-main,S-bg,S-main', JSON.stringify(added.map((a) => [a.item.name, Object.keys(a.assets)])))
    check('7. Загрузка', 'цвета набора не меняются', notes.length === 0, notes.join('; '))
    check('7. Загрузка', 'файл без папки — размер L', added.find((a) => a.item.name === 'Монета')?.item.variants['L-main']?.width === 287)
  }

  // 7б. Загруженные файлы из других редакторов (по итогам ревью). Объекты регистрируются только в памяти:
  // страница проверки делит хранилище с приложением, и запись засорила бы набор пользователя
  {
    const svgFile = (name: string, text: string) => new File([text], name, { type: 'image/svg+xml' })
    const ns = 'xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"'
    const up = await importObjectFiles([
      // Градиент со ссылкой xlink:href (Illustrator/Inkscape), только основной вариант
      svgFile(
        'Градиент.svg',
        `<svg ${ns} width="200" height="100" viewBox="0 0 200 100"><defs><linearGradient id="a"><stop offset="0" stop-color="#F9ECB0"/><stop offset="1" stop-color="#F9A3AA"/></linearGradient><linearGradient id="b" xlink:href="#a"/></defs><rect width="200" height="100" fill="url(#b)" stroke="#181817"/></svg>`,
      ),
      // Без единого цвета (черный по умолчанию) — не «фоновый»
      svgFile('Иконка.svg', `<svg ${ns} width="100" height="100"><circle cx="50" cy="50" r="40"/></svg>`),
      // Масштаб viewBox: рамка 48, рисунок в координатах 24
      svgFile('Значок.svg', `<svg ${ns} width="48" height="48" viewBox="0 0 24 24"><rect x="0" y="0" width="24" height="24" fill="#181817"/></svg>`),
      // Основной и фоновый варианты одного размера, отличаются на пиксель — оба L
      svgFile('Лист.svg', `<svg ${ns} width="300" height="200"><rect width="300" height="200" fill="#181817"/></svg>`),
      svgFile('Лист (1).svg', `<svg ${ns} width="300" height="201"><rect width="300" height="201" fill="#7864D7"/></svg>`),
    ])
    const find = (n: string) => up.added.find((a) => a.item.name === n)!
    const grad = find('Градиент')
    const icon = find('Иконка')
    const badge = find('Значок')
    const leaf = find('Лист')
    check('7. Загрузка', 'файл без распознанных цветов — основной, а не фоновый', !!icon.item.variants['L-main'] && !icon.item.variants['L-bg'], JSON.stringify(Object.keys(icon.assets)))
    check('7. Загрузка', 'viewBox с масштабом: рисунок растянут на рамку', /matrix\(2 0 0 2 0 0\)/.test(badge.assets['L-main']?.markup ?? ''), badge.assets['L-main']?.markup.slice(0, 80))
    check('7. Загрузка', 'варианты 300×200 и 300×201 — оба размера L', Object.keys(leaf.assets).sort().join() === 'L-bg,L-main', JSON.stringify(Object.keys(leaf.assets)))
    // Регистрируем в кэше файлов (без сохранения) и собираем: градиент без фонового варианта
    const { putAsset } = await import('../compose/assets')
    for (const s of up.added) for (const [k, a] of Object.entries(s.assets)) if (a) putAsset(s.item.id, k as 'L-main', a)
    const mine = [...items, ...up.added.map((a) => a.item)]
    const lookup = (id: string) => mine.find((i) => i.id === id)
    const list = arrangements([grad.item, byId('book')], 'square', 'L')
    check('7. Загрузка', 'объект без фонового варианта автосборка не делает фоновым', list.every((a) => a.placements.find((p) => p.itemId === grad.item.id)!.state === 'main'), String(list.length))
    const comp: Composition = { ...DEFAULT_COMPOSITION, objects: list[0]!.placements.map((p, i) => ({ id: `t${i}`, itemId: p.itemId, state: p.state, x: p.x, y: p.y, rotation: 0, colors: {} })) }
    const svg = buildCompositionSvg(comp, schemeById('violet'), lookup)
    const parsedOk = !new DOMParser().parseFromString(svg, 'image/svg+xml').querySelector('parsererror')
    check('7. Загрузка', 'экспорт с градиентом xlink:href — корректный SVG', parsedOk && svg.includes('xlink:href'), svg.slice(0, 120))
  }

  // Палитра из Illustrator: цвета классами в <style>, колонки — сдвинутыми группами
  {
    const ai = `<svg xmlns="http://www.w3.org/2000/svg" width="220" height="200"><style>.c1{fill:#E8F0FF}.c2{fill:#5470C6}.c3{fill:#FF7F50}.c4{fill:#06D6A0}</style>
      <g><rect class="c1" width="100" height="60"/><rect class="c2" y="70" width="100" height="60"/></g>
      <g transform="translate(120 0)"><rect class="c3" width="100" height="60"/><rect class="c4" y="70" width="100" height="60"/></g></svg>`
    try {
      const { scheme, auto } = parsePaletteSvg(ai, 'ai', 'ai')
      check('6. Палитры', 'палитра из Illustrator (классы, сдвинутые группы) — две колонки и верные цвета', !auto && scheme.bg.join() === '#E8F0FF,#5470C6' && scheme.accents.join() === '#FF7F50,#06D6A0', JSON.stringify(scheme))
    } catch (e) {
      check('6. Палитры', 'палитра из Illustrator (классы, сдвинутые группы)', false, String(e))
    }
  }

  // 8. Словарь
  const expect: Array<[string, string[]]> = [
    ['Финансовая грамотность', ['coin', 'book']],
    ['идея для стартапа', ['lamp']],
    ['музыка для концентрации', ['headphones']],
    ['командная работа', ['puzzle']],
    ['подписать договор', ['pen']],
    ['рост и забота', ['person']],
    ['экономия денег', ['coin', 'wallet']],
    ['онлайн-банк в смартфоне', ['phone']],
    ['архив документов', ['folder']],
  ]
  for (const [phrase, want] of expect) {
    const pick = pickByMetaphor(phrase, items)
    const got = pick?.items.map((i) => i.id) ?? []
    check('8. Метафоры', `«${phrase}» → ${want.join(', ')}`, want.every((w) => got.includes(w)) && got.length >= 2, got.join(', '))
  }
  // Несколько наборов для метафоры: «Другой» показывает ее разными объектами, главный по смыслу объект — в каждом
  for (const [phrase, lead, also] of [
    ['Финансовая грамотность', 'coin', 'book'],
    ['идея для стартапа', 'lamp', 'puzzle'],
    ['музыка для концентрации', 'headphones', 'phone'],
  ] as const) {
    const fit = (ids: string[]) => {
      const a = arrangements(ids.map(byId), 'square', 'L', undefined, { bestOnly: true, hero: ids[0] })[0]!
      return { cost: a.quality, coverage: a.coverage }
    }
    const sets = metaphorSets(phrase, items, fit) ?? []
    const keys = sets.map((x) => x.items.map((i) => i.id).sort().join('+'))
    const ok = sets.length >= 3 && new Set(keys).size === sets.length && sets.every((x) => x.items[0]!.id === lead) && sets.filter((x) => x.items.some((i) => i.id === also)).length >= 2
    check('8. Метафоры', `«${phrase}»: ${sets.length} разных наборов, «${lead}» в каждом, «${also}» не в одном`, ok, keys.join(' | '))
  }
  const names = itemsByNames('телефон, пазлы и наушники', items).map((i) => i.id)
  check('8. Метафоры', 'по названиям: «телефон, пазлы и наушники»', names.join() === 'phone,puzzle,headphones', names.join())

  ;(window as unknown as { __verify: Check[] }).__verify = checks
  document.title = 'verify: done'
}

run().catch((e: unknown) => {
  checks.push({ group: 'run', name: 'исключение', ok: false, detail: e instanceof Error ? e.stack : String(e) })
  ;(window as unknown as { __verify: Check[] }).__verify = checks
  document.title = 'verify: done'
})
