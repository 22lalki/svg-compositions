// Собирает проверенные черновики разметки scripts/.out/ann/<id>.json в public/sources/objects.json.
// Запуск после `node scripts/annotate.mjs check-draft <id>` без проблем: node scripts/annotate-merge.mjs 01 02 …
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const target = path.join(ROOT, 'public', 'sources', 'objects.json')
const all = existsSync(target) ? JSON.parse(readFileSync(target, 'utf8')) : {}
for (const id of process.argv.slice(2)) {
  const draft = JSON.parse(readFileSync(path.join(ROOT, 'scripts', '.out', 'ann', `${id}.json`), 'utf8'))
  all[id] = { shapeCount: draft.shapeCount, objects: draft.objects.map((o) => ({ name: o.name, shapes: String(o.shapes) })) }
  console.log(`${id}: ${draft.objects.length} объектов`)
}
const sorted = Object.fromEntries(Object.keys(all).sort().map((k) => [k, all[k]]))
writeFileSync(target, JSON.stringify(sorted, null, 2) + '\n')
console.log(`→ ${path.relative(ROOT, target)}`)
