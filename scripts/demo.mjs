// Сквозной сценарий через настоящий UI (Playwright):
//   извлечение компонентов рамкой → сборка трех композиций → экспорт в examples/ → проверки чек-листа.
// Запуск (dev-сервер должен работать):  node scripts/demo.mjs            — композиции + проверки
//                                        node scripts/demo.mjs --video    — запись демо-видео (examples/demo.webm)
import { chromium } from 'playwright'
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const BASE = process.env.BASE_URL ?? 'http://localhost:5173'
const VIDEO = process.argv.includes('--video')
const EXAMPLES = path.join(ROOT, 'examples')
const OUT = path.join(ROOT, 'scripts', '.out')
mkdirSync(EXAMPLES, { recursive: true })
mkdirSync(OUT, { recursive: true })

/* ---------- Что извлекаем: рамки в координатах исходника ---------- */

const C = {
  woman: { source: '02', name: 'Девушка', rect: [115, -5, 318, 470] },
  dog: { source: '02', name: 'Собака с косточкой', rect: [328, 238, 552, 470] },
  window: { source: '07', name: 'Звездное окно', rect: [20, -5, 428, 540], subtract: [[-8, 325, 125, 425]] },
  stargazer: { source: '07', name: 'Мечтатель', rect: [-8, 320, 185, 885], subtract: [[100, 445, 165, 520]] },
  truck: { source: '11', name: 'Фудтрак', rect: [30, -5, 965, 500], subtract: [[-8, 170, 180, 362]] },
  cloudSmall: { source: '05', name: 'Облачко', rect: [-8, 5, 232, 100] },
  cloudBig: { source: '05', name: 'Большое облако', rect: [60, -5, 815, 275] },
  cloudPurple: { source: '05', name: 'Сиреневое облако', rect: [160, 195, 520, 318] },
  cabin: { source: '14', name: 'Домик', rect: [280, 210, 442, 337] },
  trees: { source: '14', name: 'Деревья', rect: [438, 205, 595, 337] },
  mountain: { source: '14', name: 'Гора', rect: [-8, 58, 326, 337] },
  ground: { source: '14', name: 'Поляна', rect: [100, 325, 830, 428] },
  sun: { source: '04', name: 'Солнце', rect: [28, 22, 348, 345] },
  beachDog: { source: '04', name: 'Пес', rect: [492, 600, 685, 805] },
  moon: { source: '16', name: 'Луна', rect: [125, 145, 300, 323] },
  businessman: { source: '17', name: 'Бизнесмен', rect: [185, -5, 565, 845] },
  chart: { source: '17', name: 'Круговая диаграмма', rect: [535, 10, 885, 335] },
}

/* ---------- Композиции: центр и ширина/высота на артборде 1200×800 ---------- */

const COMPOSITIONS = [
  {
    file: 'composition-1-food-truck',
    title: 'Вечерний фудтрак',
    items: [
      { c: 'ground', cx: 600, cy: 712, w: 1150 },
      { c: 'cloudBig', cx: 330, cy: 175, w: 460 },
      { c: 'moon', cx: 990, cy: 150, w: 150 },
      { c: 'cloudSmall', cx: 815, cy: 250, w: 200 },
      { c: 'trees', cx: 130, cy: 600, w: 210 },
      { c: 'truck', cx: 555, cy: 505, w: 720 },
      { c: 'woman', cx: 950, cy: 525, h: 400 },
      { c: 'dog', cx: 1078, cy: 618, h: 205 },
    ],
  },
  {
    file: 'composition-2-cabin',
    title: 'Домик в горах',
    items: [
      { c: 'sun', cx: 960, cy: 210, w: 230 },
      { c: 'mountain', cx: 310, cy: 425, w: 560 },
      { c: 'mountain', cx: 880, cy: 455, w: 470, flip: true },
      { c: 'cloudSmall', cx: 230, cy: 150, w: 230 },
      { c: 'cloudBig', cx: 700, cy: 140, w: 360 },
      { c: 'ground', cx: 600, cy: 690, w: 1180 },
      { c: 'cabin', cx: 565, cy: 560, w: 260 },
      { c: 'trees', cx: 790, cy: 575, w: 230 },
      { c: 'stargazer', cx: 300, cy: 600, h: 330 },
      { c: 'beachDog', cx: 420, cy: 692, h: 120, flip: true },
    ],
  },
  {
    file: 'composition-3-analytics',
    title: 'Вечер с аналитикой',
    items: [
      { c: 'cloudPurple', cx: 1030, cy: 660, w: 300 },
      { c: 'window', cx: 260, cy: 390, h: 580, flip: true },
      { c: 'moon', cx: 1090, cy: 130, w: 120 },
      { c: 'chart', cx: 875, cy: 290, w: 300, rotate: -15 },
      { c: 'businessman', cx: 590, cy: 440, h: 640 },
      { c: 'dog', cx: 880, cy: 650, h: 230 },
    ],
  },
]

/* ---------- Браузер ---------- */

const CURSOR_SCRIPT = `(() => {
  const install = () => {
    if (document.getElementById('__cursor')) return
    const c = document.createElement('div')
    c.id = '__cursor'
    c.innerHTML = '<svg width="24" height="24" viewBox="0 0 24 24"><path d="M4 2l6.5 19 2.6-7.6L21 11z" fill="#111" stroke="#fff" stroke-width="1.6" stroke-linejoin="round"/></svg>'
    Object.assign(c.style, { position: 'fixed', left: '0', top: '0', zIndex: 2147483647, pointerEvents: 'none', transform: 'translate(-100px,-100px)' })
    document.body.appendChild(c)
    const cap = document.createElement('div')
    Object.assign(cap.style, { position: 'fixed', left: '50%', top: '9px', transform: 'translateX(-50%)', zIndex: 2147483646, pointerEvents: 'none',
      background: 'rgba(31,35,48,.94)', color: '#fff', font: '600 15px/1.3 Segoe UI, Inter, sans-serif', padding: '7px 16px', borderRadius: '10px',
      opacity: '0', transition: 'opacity .25s', whiteSpace: 'nowrap' })
    document.body.appendChild(cap)
    window.__caption = (t) => { if (t) cap.textContent = t; cap.style.opacity = t ? '1' : '0' }
    const move = (e) => { c.style.transform = 'translate(' + (e.clientX - 4) + 'px,' + (e.clientY - 2) + 'px)' }
    for (const t of ['pointermove', 'mousemove', 'dragover', 'drag']) window.addEventListener(t, move, true)
    window.addEventListener('pointerdown', (e) => {
      const r = document.createElement('div')
      Object.assign(r.style, { position: 'fixed', left: e.clientX - 12 + 'px', top: e.clientY - 12 + 'px', width: '24px', height: '24px', borderRadius: '50%',
        background: 'rgba(108,99,255,.4)', zIndex: 2147483645, pointerEvents: 'none', transition: 'transform .4s, opacity .4s' })
      document.body.appendChild(r)
      requestAnimationFrame(() => { r.style.transform = 'scale(2.2)'; r.style.opacity = '0' })
      setTimeout(() => r.remove(), 450)
    }, true)
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', install)
  else install()
})()`

const browser = await chromium.launch()
const context = await browser.newContext({
  viewport: { width: 1440, height: 900 },
  acceptDownloads: true,
  recordVideo: VIDEO ? { dir: OUT, size: { width: 1440, height: 900 } } : undefined,
})
if (VIDEO) await context.addInitScript(CURSOR_SCRIPT)
const page = await context.newPage()
const errors = []
page.on('pageerror', (e) => errors.push(e.message))
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()))
let navigations = 0
page.on('framenavigated', (fr) => fr === page.mainFrame() && navigations++)

const wait = (ms) => page.waitForTimeout(VIDEO ? ms : Math.min(ms, 80))
const steps = (n) => (VIDEO ? n : 2)
async function caption(text, ms = 0) {
  if (!VIDEO) return
  await page.evaluate((t) => window.__caption?.(t), text)
  if (ms) await wait(ms)
}

/* ---------- Режим выделения ---------- */

async function srcToClient(x, y) {
  return page.evaluate(([x, y]) => {
    const p = new DOMPoint(x, y).matrixTransform(document.querySelector('[data-source-svg]').getScreenCTM())
    return { x: p.x, y: p.y }
  }, [x, y])
}

async function openSource(id) {
  await page.click(`[data-source-id="${id}"]`)
  await page.waitForSelector(`[data-source-svg="${id}"]`)
  await page.waitForFunction(() => {
    const r = document.querySelector('[data-source-svg]')?.getBoundingClientRect()
    return r && r.width > 100 && r.height > 100
  })
  await wait(500)
}

async function marquee([x0, y0, x1, y1], modifier) {
  const a = await srcToClient(x0, y0)
  const b = await srcToClient(x1, y1)
  await page.mouse.move(a.x, a.y, { steps: steps(15) })
  if (modifier) await page.keyboard.down(modifier)
  await page.mouse.down()
  await page.mouse.move(b.x, b.y, { steps: steps(35) })
  await page.mouse.up()
  if (modifier) await page.keyboard.up(modifier)
  await wait(400)
}

async function saveComponent(name) {
  const input = page.getByLabel('Название компонента')
  await input.click()
  await input.fill('')
  if (VIDEO) await input.pressSequentially(name, { delay: 45 })
  else await input.fill(name)
  await wait(300)
  await page.getByRole('button', { name: 'Сохранить в библиотеку' }).click()
  await page.waitForSelector(`[data-component-id][data-name="${name}"]`)
  await wait(700)
}

async function extract(key) {
  const spec = C[key]
  const opened = await page.$(`[data-source-svg="${spec.source}"]`)
  if (!opened) await openSource(spec.source)
  await marquee(spec.rect)
  for (const r of spec.subtract ?? []) await marquee(r, 'Alt')
  const count = await page.textContent('[data-testid="selection-count"]')
  if (!VIDEO) console.log(`  ${key}: ${count}`)
  if (!(await page.$('[data-testid="component-preview"]'))) await page.screenshot({ path: path.join(OUT, `fail-${key}.png`) })
  await page.locator('[data-testid="component-preview"]').screenshot({ path: path.join(OUT, `preview-${key}.png`) })
  await saveComponent(spec.name)
  return count
}

async function backToCanvas() {
  await page.getByRole('button', { name: 'Холст' }).click()
  await page.waitForSelector('[data-testid="canvas"] svg')
  await wait(400)
}

/* ---------- Холст ---------- */

async function boardToClient(x, y) {
  return page.evaluate(([x, y]) => {
    const p = new DOMPoint(x, y).matrixTransform(document.querySelector('[data-testid="canvas"] svg').getScreenCTM())
    return { x: p.x, y: p.y }
  }, [x, y])
}

/** Ручки выделенного объекта в координатах артборда */
async function frame() {
  return page.evaluate(() => {
    const svg = document.querySelector('[data-testid="canvas"] svg')
    const inv = svg.getScreenCTM().inverse()
    const at = (sel) => {
      const r = document.querySelector(sel).getBoundingClientRect()
      const p = new DOMPoint(r.x + r.width / 2, r.y + r.height / 2).matrixTransform(inv)
      return { x: p.x, y: p.y }
    }
    const nw = at('[data-handle="scale:-1:-1"]')
    const ne = at('[data-handle="scale:1:-1"]')
    const se = at('[data-handle="scale:1:1"]')
    const sw = at('[data-handle="scale:-1:1"]')
    const rot = at('[data-handle="rotate"]')
    return { nw, ne, se, sw, rot, center: { x: (nw.x + se.x) / 2, y: (nw.y + se.y) / 2 } }
  })
}

const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y)

async function dragBoard(from, to, modifier) {
  const a = await boardToClient(from.x, from.y)
  const b = await boardToClient(to.x, to.y)
  await page.mouse.move(a.x, a.y, { steps: steps(10) })
  if (modifier) await page.keyboard.down(modifier)
  await page.mouse.down()
  await page.mouse.move(b.x, b.y, { steps: steps(30) })
  await page.mouse.up()
  if (modifier) await page.keyboard.up(modifier)
  await wait(300)
}

/** Перетащить карточку компонента из библиотеки в точку артборда (центр объекта встанет в нее) */
async function dropComponent(name, cx, cy) {
  const card = page.locator(`[data-component-id][data-name="${name}"]`).first()
  const canvas = page.locator('[data-testid="canvas"]')
  const box = await canvas.boundingBox()
  const p = await boardToClient(cx, cy)
  await card.dragTo(canvas, { targetPosition: { x: p.x - box.x, y: p.y - box.y }, steps: steps(25) })
  await wait(400)
}

async function scaleSelected({ w, h }) {
  const f = await frame()
  const cur = w ? dist(f.nw, f.ne) : dist(f.nw, f.sw)
  const k = (w ?? h) / cur
  const target = { x: f.center.x + (f.se.x - f.center.x) * k, y: f.center.y + (f.se.y - f.center.y) * k }
  await dragBoard(f.se, target)
}

async function rotateSelected(deg) {
  const f = await frame()
  const v = { x: f.rot.x - f.center.x, y: f.rot.y - f.center.y }
  const r = (deg * Math.PI) / 180
  const target = { x: f.center.x + v.x * Math.cos(r) - v.y * Math.sin(r), y: f.center.y + v.x * Math.sin(r) + v.y * Math.cos(r) }
  await dragBoard(f.rot, target, 'Shift')
}

/** Точка, где под курсором действительно выделенный объект (чтобы схватить его за закрашенную часть) */
async function grabPoint() {
  return page.evaluate(() => {
    const id = document.querySelector('[data-testid="canvas"]').dataset.selected
    const el = document.querySelector(`[data-obj-id="${id}"]`)
    const r = el.getBoundingClientRect()
    for (let t = 0; t < 400; t++) {
      const a = t * 0.7
      const rad = (t / 400) * Math.min(r.width, r.height) * 0.5
      const x = r.x + r.width / 2 + Math.cos(a) * rad
      const y = r.y + r.height / 2 + Math.sin(a) * rad
      if (document.elementFromPoint(x, y)?.closest('[data-obj-id]') === el) return { x, y }
    }
    return null
  })
}

async function moveSelectedBy(dx, dy) {
  const g = await grabPoint()
  const zoom = await page.evaluate(() => document.querySelector('[data-testid="canvas"] svg').getScreenCTM().a)
  await page.mouse.move(g.x, g.y, { steps: steps(10) })
  await page.mouse.down()
  await page.mouse.move(g.x + dx * zoom, g.y + dy * zoom, { steps: steps(30) })
  await page.mouse.up()
  await wait(300)
}

async function place(item) {
  const name = C[item.c].name
  await dropComponent(name, item.cx, item.cy)
  await scaleSelected(item)
  if (item.rotate) await rotateSelected(item.rotate)
  if (item.flip) {
    await page.getByRole('button', { name: 'Отразить по горизонтали' }).click()
    await wait(300)
  }
}

async function clearCanvas() {
  while ((await page.locator('[data-layer-id]').count()) > 0) {
    await page.locator('[data-layer-id]').first().click()
    await page.keyboard.press('Delete')
  }
}

async function exportSvg(file) {
  await page.keyboard.press('Escape')
  const [download] = await Promise.all([page.waitForEvent('download'), page.click('[data-testid="export"]')])
  const target = path.join(EXAMPLES, `${file}.svg`)
  await download.saveAs(target)
  return readFileSync(target, 'utf8')
}

/** PNG-превью экспортированного SVG — отдельная страница, только сам файл */
async function renderPng(svgText, file) {
  const p = await browser.newPage({ viewport: { width: 1200, height: 800 } })
  await p.setContent(`<body style="margin:0">${svgText.replace(/<\?xml[^>]*>/, '')}</body>`)
  await p.waitForTimeout(200)
  await p.locator('svg').first().screenshot({ path: path.join(EXAMPLES, `${file}.png`) })
  await p.close()
}

/** Сравнение холста и экспорта попиксельно (тот же размер, тот же масштаб) */
async function compareCanvasWithExport(svgText) {
  await page.keyboard.press('Escape')
  await page.mouse.move(5, 895)
  await wait(200)
  const rect = await page.evaluate(() => {
    const r = document.querySelector('[data-artboard]').getBoundingClientRect()
    return { x: r.x, y: r.y, width: r.width, height: r.height }
  })
  const clip = { x: Math.ceil(rect.x), y: Math.ceil(rect.y), width: Math.floor(rect.width) - 2, height: Math.floor(rect.height) - 2 }
  const canvasPng = await page.screenshot({ clip })
  const p = await browser.newPage({ viewport: { width: 1440, height: 900 } })
  await p.setContent(
    `<body style="margin:0"><img id="e" style="position:absolute;left:${rect.x}px;top:${rect.y}px;width:${rect.width}px;height:${rect.height}px" src="data:image/svg+xml;base64,${Buffer.from(svgText).toString('base64')}"></body>`,
  )
  await p.waitForFunction(() => document.getElementById('e').complete)
  const exportPng = await p.screenshot({ clip })
  const result = await p.evaluate(
    async ([a, b]) => {
      const load = (src) => new Promise((res) => { const i = new Image(); i.onload = () => res(i); i.src = src })
      const [ia, ib] = await Promise.all([load(a), load(b)])
      const px = (img) => {
        const c = document.createElement('canvas')
        c.width = img.width
        c.height = img.height
        const ctx = c.getContext('2d')
        ctx.drawImage(img, 0, 0)
        return ctx.getImageData(0, 0, c.width, c.height).data
      }
      const da = px(ia)
      const db = px(ib)
      let painted = 0
      let diff = 0
      for (let i = 0; i < da.length; i += 4) {
        if (Math.max(255 - da[i], 255 - da[i + 1], 255 - da[i + 2]) > 8) painted++
        if (Math.max(Math.abs(da[i] - db[i]), Math.abs(da[i + 1] - db[i + 1]), Math.abs(da[i + 2] - db[i + 2])) > 64) diff++
      }
      return { painted, diff, ratio: painted ? diff / painted : 0 }
    },
    [`data:image/png;base64,${canvasPng.toString('base64')}`, `data:image/png;base64,${exportPng.toString('base64')}`],
  )
  await p.close()
  return result
}

/* ---------- Проверки ---------- */

const checks = []
function check(name, ok, details = '') {
  checks.push({ name, ok, details })
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}${details ? ` — ${details}` : ''}`)
}

function inspectExport(svg, expectedObjects) {
  const groups = svg.match(/<g id="obj-[^"]+" data-component="[^"]+"/g) ?? []
  check('экспорт: каждый объект — отдельная группа obj-*', groups.length === expectedObjects, `${groups.length} из ${expectedObjects}`)
  check('экспорт: нет <image> и base64', !/<image|base64/i.test(svg))
  check('экспорт: <defs> в начале, viewBox артборда', /<svg[^>]+viewBox="0 0 1200 800">\s*<defs/.test(svg))
  const ids = Array.from(svg.matchAll(/\sid="([^"]+)"/g), (m) => m[1])
  check('экспорт: все id уникальны', new Set(ids).size === ids.length, `${ids.length} id`)
}

/* ---------- Сценарий ---------- */

await page.goto(BASE)
await page.waitForSelector('[data-source-id="01"]')
await wait(1200)

if (VIDEO) {
  // Демо-сценарий: исходник → выделение → библиотека → композиция из 3+ исходников → экспорт
  await caption('Открываем исходник 02 «Игра с собакой» — он рендерится инлайном', 900)
  await openSource('02')
  await wait(700)
  await caption('Наведение подсвечивает фигуру, клик выделяет самую глубокую под курсором')
  const bone = await srcToClient(346, 255)
  await page.mouse.move(bone.x, bone.y, { steps: 25 })
  await wait(900)
  await page.mouse.click(bone.x, bone.y)
  await wait(1000)
  await caption('↑ — расширить до родительской группы (косточка повернута через matrix)')
  await wait(500)
  await page.keyboard.press('ArrowUp')
  await wait(1500)
  await caption('Рамка выделяет все фигуры, целиком попавшие внутрь: персонаж из многих путей')
  await marquee(C.woman.rect)
  await wait(900)
  await caption('Справа — живое превью компонента. Название → «Сохранить в библиотеку»')
  await wait(900)
  await saveComponent(C.woman.name)
  await caption('Собака с косточкой — тоже рамкой')
  await marquee(C.dog.rect)
  await wait(500)
  await saveComponent(C.dog.name)

  await caption('07 «Звездное окно» (градиент): рамка, затем Alt+рамка вычитает лишнее — голову персонажа', 300)
  await openSource('07')
  await marquee(C.window.rect)
  await wait(500)
  await marquee(C.window.subtract[0], 'Alt')
  await wait(600)
  await saveComponent(C.window.name)

  await caption('11 «Фудтрак» (градиент): рамка + Alt-вычитание', 300)
  await openSource('11')
  await marquee(C.truck.rect)
  await marquee(C.truck.subtract[0], 'Alt')
  await wait(500)
  await saveComponent(C.truck.name)

  await caption('05 «Облака» и 16 «Звезды»', 300)
  await openSource('05')
  await marquee(C.cloudBig.rect)
  await saveComponent(C.cloudBig.name)
  await openSource('16')
  await marquee(C.moon.rect)
  await saveComponent(C.moon.name)
  await openSource('14')
  await marquee(C.ground.rect)
  await saveComponent(C.ground.name)
  await marquee(C.trees.rect)
  await saveComponent(C.trees.name)

  await backToCanvas()
  await caption('Холст: перетаскиваем компоненты из библиотеки', 600)
  const comp = COMPOSITIONS[0]
  for (const item of comp.items.filter((i) => i.c !== 'cloudSmall')) {
    if (item.c === 'woman') await caption('Масштаб за угловую ручку — от центра, пропорционально')
    await place(item)
  }
  await caption('Поворот за верхнюю ручку, Shift — шаг 15°')
  await page.locator('[data-layer-id]').first().click() // собака — верхний слой
  await rotateSelected(-15)
  await wait(700)
  await caption('Ctrl+D — дубликат, Shift+стрелки — сдвиг на 10px, кнопка — отражение')
  await page.locator('[data-layer-id]', { hasText: 'Деревья' }).click()
  await page.keyboard.press('Control+d')
  await wait(400)
  for (let i = 0; i < 18; i++) {
    await page.keyboard.press('Shift+ArrowRight')
    await wait(40)
  }
  await page.getByRole('button', { name: 'Отразить по горизонтали' }).click()
  await wait(700)
  await caption('Порядок слоев: кнопки или перетаскивание в панели «Слои»')
  await page.getByRole('button', { name: 'На задний план' }).click()
  await wait(900)
  await caption('Undo / Redo — Ctrl+Z / Ctrl+Shift+Z')
  for (let i = 0; i < 4; i++) {
    await page.keyboard.press('Control+z')
    await wait(450)
  }
  for (let i = 0; i < 4; i++) {
    await page.keyboard.press('Control+Shift+z')
    await wait(450)
  }
  await caption('Экспорт: чистый векторный SVG, объекты — отдельные группы')
  await wait(600)
  const svg = await exportSvg('demo-composition')
  await wait(1200)
  await caption('Перезагрузка: библиотека и сцена восстанавливаются из IndexedDB', 300)
  await page.reload()
  await page.waitForSelector('[data-testid="canvas"] svg')
  await wait(2200)
  await caption('Скачанный файл, открытый в браузере', 300)
  await page.goto(`data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`)
  await wait(3000)
  await page.close()
  const video = page.video()
  await context.close()
  const src = await video.path()
  renameSync(src, path.join(EXAMPLES, 'demo.webm'))
  rmSync(path.join(EXAMPLES, 'demo-composition.svg'), { force: true })
  console.log('Видео: examples/demo.webm')
  await browser.close()
  process.exit(0)
}

// 1. Извлекаем все компоненты через UI
const counts = {}
for (const key of Object.keys(C)) counts[key] = await extract(key)
console.log('Выделено фигур:', counts)
check('библиотека: все компоненты сохранены', (await page.locator('[data-component-id]').count()) === Object.keys(C).length)
await backToCanvas()

// 2. Три композиции → examples/
const exported = []
for (const comp of COMPOSITIONS) {
  for (const item of comp.items) await place(item)
  const svg = await exportSvg(comp.file)
  await renderPng(svg, comp.file)
  inspectExport(svg, comp.items.length)
  const sources = new Set(comp.items.map((i) => C[i.c].source))
  check(`${comp.title}: элементы из 3+ исходников`, sources.size >= 3, [...sources].join(', '))
  const cmp = await compareCanvasWithExport(svg)
  check(`${comp.title}: холст и экспорт совпадают`, cmp.ratio < 0.01, `отличается ${(cmp.ratio * 100).toFixed(2)}% закрашенных пикселей`)
  exported.push(svg)
  await page.screenshot({ path: path.join(OUT, `${comp.file}-app.png`) })
  if (comp !== COMPOSITIONS.at(-1)) await clearCanvas()
}

// 3. Перезагрузка: сцена и библиотека на месте, экспорт идентичен
await page.reload()
await page.waitForSelector('[data-testid="canvas"] svg')
await wait(500)
const afterReload = await exportSvg('_reload-check')
check('перезагрузка: сцена восстановлена без изменений', afterReload === exported.at(-1))
check('перезагрузка: библиотека на месте', (await page.locator('[data-component-id]').count()) === Object.keys(C).length)

// 4. Undo/redo: 32 шага назад и вперед возвращают ту же сцену
await clearCanvas()
await dropComponent(C.moon.name, 300, 200)
await scaleSelected({ w: 60 })
for (let i = 0; i < 32; i++) await page.keyboard.press('Control+d')
const beforeUndo = await exportSvg('_undo-a')
for (let i = 0; i < 32; i++) await page.keyboard.press('Control+z')
const undone = await page.locator('[data-layer-id]').count()
for (let i = 0; i < 32; i++) await page.keyboard.press('Control+Shift+z')
const afterRedo = await exportSvg('_undo-b')
check('undo/redo: 32 шага назад и вперед', undone === 1 && afterRedo === beforeUndo, `после 32×undo объектов: ${undone}`)

// 5. Градиенты 07, 11, 17 — по два экземпляра одновременно
await clearCanvas()
for (const [key, x, y, h] of [['window', 200, 330, 420], ['truck', 700, 230, 300], ['businessman', 1000, 480, 520]]) {
  await place({ c: key, cx: x, cy: y, h })
  await page.keyboard.press('Control+d')
  for (let i = 0; i < 8; i++) await page.keyboard.press('Shift+ArrowDown')
}
const gradSvg = await exportSvg('_gradients-check')
const gradientDefs = (gradSvg.match(/<linearGradient/g) ?? []).length
const gradientRefs = (gradSvg.match(/url\(#c[0-9a-z]+-/g) ?? []).length
check('градиенты: defs каждого компонента подключены один раз', gradientDefs === 3, `${gradientDefs} градиента, ${gradientRefs} ссылок`)
const gradCmp = await compareCanvasWithExport(gradSvg)
check('градиенты ×2: холст и экспорт совпадают', gradCmp.ratio < 0.01, `${(gradCmp.ratio * 100).toFixed(2)}%`)
await page.screenshot({ path: path.join(OUT, 'gradients-app.png') })

// 6. Поворот 45° + масштаб угловой ручкой: центр не уезжает, угол сохраняется
await page.locator('[data-layer-id]').first().click()
await rotateSelected(45)
const info45 = await page.textContent('[data-testid="selection-info"]')
const f0 = await frame()
await scaleSelected({ w: dist(f0.nw, f0.ne) * 1.35 })
const f1 = await frame()
const info2 = await page.textContent('[data-testid="selection-info"]')
const drift = dist(f0.center, f1.center)
check('поворот 45° (Shift)', info45.includes('45°'), info45)
check('масштаб повернутого объекта: центр на месте', drift < 0.5, `смещение центра ${drift.toFixed(3)}`)
check('масштаб повернутого объекта: угол сохранен, масштаб вырос', info2.includes('45°') && Math.abs(dist(f1.nw, f1.ne) / dist(f0.nw, f0.ne) - 1.35) < 0.01, info2)
const rotSvg = await exportSvg('_rotate-check')
const rotCmp = await compareCanvasWithExport(rotSvg)
check('повернутый объект: положение и угол в экспорте совпадают с холстом', rotCmp.ratio < 0.01, `${(rotCmp.ratio * 100).toFixed(2)}%`)

// Shift при масштабе отключает пропорциональность
await page.locator('[data-layer-id]').first().click()
const fs0 = await frame()
await dragBoard(fs0.se, { x: fs0.se.x + 40, y: fs0.se.y - 10 }, 'Shift')
const infoFree = await page.textContent('[data-testid="selection-info"]')
check('Shift + угловая ручка: непропорциональный масштаб', /\d+×\d+%/.test(infoFree), infoFree)
await page.keyboard.press('Control+z')

// 7. Порядок слоев: перетаскивание в панели слоев, затем сверка с экспортом
const rowsBefore = await page.locator('[data-layer-id]').evaluateAll((els) => els.map((e) => e.dataset.layerId))
await page.locator('[data-layer-id]').last().dragTo(page.locator('[data-layer-id]').first(), { targetPosition: { x: 40, y: 3 } })
const rowsAfter = await page.locator('[data-layer-id]').evaluateAll((els) => els.map((e) => e.dataset.layerId))
check('панель слоев: перетаскивание меняет порядок', rowsAfter[0] === rowsBefore.at(-1) && rowsAfter.length === rowsBefore.length)
const orderSvg = await exportSvg('_order-check')
const exportOrder = Array.from(orderSvg.matchAll(/<g id="obj-([^"]+)"/g), (m) => m[1])
check('порядок слоев на холсте = порядок в экспорте', JSON.stringify([...rowsAfter].reverse()) === JSON.stringify(exportOrder))

// 8. Удаление компонента, который стоит на холсте
const truckCard = page.locator(`[data-component-id][data-name="${C.truck.name}"]`).first()
await truckCard.hover()
await truckCard.getByRole('button', { name: 'Удалить' }).click()
const dialogText = await page.locator('[role="dialog"]').textContent()
await page.getByRole('button', { name: 'Удалить вместе с объектами' }).click()
await wait(300)
const leftObjects = await page.locator('[data-layer-id]').count()
check('удаление используемого компонента: предупреждение', dialogText.includes('используется на холсте'))
check('удаление используемого компонента: сцена цела', leftObjects === 4 && errors.length === 0, `осталось объектов: ${leftObjects}`)
for (let i = 0; i < 5; i++) await page.keyboard.press('Control+z')
const afterUndoDeleted = await page.locator('[data-layer-id]').count()
check('undo после удаления компонента не возвращает «битые» объекты', afterUndoDeleted <= 4 && errors.length === 0, `объектов: ${afterUndoDeleted}`)

for (const f of ['_reload-check', '_undo-a', '_undo-b', '_gradients-check', '_rotate-check', '_order-check']) rmSync(path.join(EXAMPLES, `${f}.svg`), { force: true })
writeFileSync(path.join(OUT, 'checks.json'), JSON.stringify(checks, null, 2))
check('нет ошибок в консоли', errors.length === 0, errors.join(' | '))
check('страница не перезагружалась сама (кроме явной перезагрузки в тесте)', navigations === 2, `навигаций: ${navigations}`)

await browser.close()
const failed = checks.filter((c) => !c.ok)
console.log(failed.length ? `\n${failed.length} проверок не прошли` : `\nВсе ${checks.length} проверок пройдены`)
process.exit(failed.length ? 1 : 0)
