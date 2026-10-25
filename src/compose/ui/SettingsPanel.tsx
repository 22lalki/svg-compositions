import { useRef, useState, type ReactNode } from 'react'
import { Icon } from '../../components/Icon'
import { confirmDialog, promptDialog } from '../../store/confirm'
import { openContextMenu } from '../../store/contextMenu'
import { notify } from '../../store/ui'
import { shortId } from '../../lib/ids'
import { getAsset, useAssets } from '../assets'
import { lookupItem, schemeById, useCatalog } from '../catalogStore'
import { normalizeAngle, useComposition } from '../compositionStore'
import {
  FORMAT_KEYS,
  FORMAT_LABELS,
  allowedKeys,
  formatSize,
  keyLabel,
  resolveKey,
  schemeColor,
  schemeKeys,
  type CObject,
  type DecorKind,
  type Role,
  type Scheme,
} from '../model'
import { rolesInMarkup } from '../render'
import { PaletteError, inkOn, parseHexGroups, parsePaletteSvg, schemeToHex } from '../schemes'
import { objectMenu } from './ComposeCanvas'
import { ItemThumb } from './Markup'

function Section({ title, children, aside }: { title: string; children: ReactNode; aside?: ReactNode }) {
  return (
    <section className="border-b border-line p-3">
      <div className="mb-2 flex items-center justify-between">
        <h2 className="text-xs font-semibold tracking-wide text-muted uppercase">{title}</h2>
        {aside}
      </div>
      {children}
    </section>
  )
}

function Segmented<T extends string>({
  value,
  options,
  onChange,
  testid,
  disabled = [],
}: {
  value: T
  options: Array<[T, ReactNode, string?]>
  onChange: (v: T) => void
  testid?: string
  disabled?: T[]
}) {
  return (
    <div className="grid rounded-lg bg-workspace p-0.5 text-xs font-medium" style={{ gridTemplateColumns: `repeat(${options.length}, 1fr)` }} data-testid={testid}>
      {options.map(([v, label, title]) => (
        <button
          key={v}
          type="button"
          title={title}
          aria-pressed={value === v}
          disabled={disabled.includes(v)}
          className={`rounded-md px-1 py-1.5 transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${value === v ? 'bg-white text-ink shadow-sm' : 'text-muted hover:text-ink'}`}
          onClick={() => onChange(v)}
          data-value={v}
        >
          {label}
        </button>
      ))}
    </div>
  )
}

function FormatSection() {
  const size = useComposition((s) => s.comp.size)
  const format = useComposition((s) => s.comp.format)
  const st = useComposition.getState()
  return (
    <Section title="Размер и формат">
      <Segmented
        value={size}
        onChange={(v) => st.setSize(v)}
        testid="size"
        options={[
          ['L', 'L — крупный', 'Объекты L: основные форматы 1000×1000, 1200×630, 800×1200'],
          ['S', 'S — малый', 'Объекты S (вдвое меньше и проще): превью, карточки, мобильные экраны'],
        ]}
      />
      <div className="mt-2">
        <Segmented
          value={format}
          onChange={(v) => st.setFormat(v)}
          testid="format"
          options={FORMAT_KEYS.map((f) => {
            const { width, height } = formatSize(f, size)
            return [f, <span className="flex flex-col leading-tight" key={f}>{FORMAT_LABELS[f]}<span className="text-[10px] font-normal text-muted tabular-nums">{width}×{height}</span></span>]
          })}
        />
      </div>
    </Section>
  )
}

/** Полоска схемы: цвета фона | цвета объектов | черный и белый */
function SchemeBar({ scheme }: { scheme: Scheme }) {
  const part = (keys: string[]) =>
    keys.map((k) => <span key={k} className="flex-1" style={{ background: schemeColor(scheme, k) }} title={`${keyLabel(k, scheme)} ${schemeColor(scheme, k)}`} />)
  const keys = schemeKeys(scheme)
  return (
    <div className="flex h-4 gap-px overflow-hidden rounded border border-black/10 bg-black/10">
      <div className="flex flex-[3]">{part(keys.filter((k) => k.startsWith('bg.')))}</div>
      {scheme.accents.length > 0 && <div className="flex flex-[3]">{part(keys.filter((k) => k.startsWith('obj.')))}</div>}
      <div className="flex flex-1">{part(['black', 'white'])}</div>
    </div>
  )
}

async function addSchemeFromHex(base: Scheme) {
  const text = await promptDialog({
    title: 'Новая цветовая схема',
    message:
      'Цвета HEX двумя группами через «|»: сначала цвета фона (от светлого к темному), потом цвета объектов. ' +
      'Сколько угодно в каждой группе; черный и белый можно указать в любой — они узнаются сами. Ниже — текущая схема для правки.',
    confirmText: 'Добавить',
    input: { label: 'Цвета', value: schemeToHex(base), maxLength: 600 },
  })
  if (text === null) return
  try {
    const scheme = parseHexGroups(text, `user-${shortId(6)}`, `Своя схема ${useCatalog.getState().schemes.filter((s) => !s.builtin).length + 1}`)
    useCatalog.getState().addScheme(scheme)
    useComposition.getState().setScheme(scheme.id)
  } catch (e) {
    notify(e instanceof PaletteError ? `Схема не добавлена: ${e.message}` : 'Не удалось разобрать цвета', 'error')
  }
}

/** Своя схема: поправить цвета и их разбивку на фон и объекты (та же схема, композиция перекрасится сразу) */
async function editSchemeColors(s: Scheme) {
  const text = await promptDialog({
    title: `Цвета схемы «${s.name}»`,
    message: 'Цвета HEX двумя группами через «|»: сначала цвета фона (от светлого к темному), потом цвета объектов. Черный и белый можно указать в любой группе.',
    confirmText: 'Сохранить',
    input: { label: 'Цвета', value: schemeToHex(s), maxLength: 600 },
  })
  if (text === null) return
  try {
    useCatalog.getState().addScheme(parseHexGroups(text, s.id, s.name))
  } catch (e) {
    notify(e instanceof PaletteError ? `Цвета не изменены: ${e.message}` : 'Не удалось разобрать цвета', 'error')
  }
}

function SchemeSection() {
  const schemes = useCatalog((s) => s.schemes)
  const schemeId = useComposition((s) => s.comp.schemeId)
  const fileRef = useRef<HTMLInputElement>(null)

  async function onPalette(files: FileList | null) {
    const file = files?.[0]
    if (!file) return
    try {
      const { scheme, auto } = parsePaletteSvg(await file.text(), `user-${shortId(6)}`, file.name.replace(/\.svg$/i, ''))
      useCatalog.getState().addScheme(scheme)
      useComposition.getState().setScheme(scheme.id)
      notify(
        auto
          ? `Схема «${scheme.name}» добавлена. Цвета не разделены на колонки, поэтому светлые отнесены к фону (${scheme.bg.length}), остальные — к объектам (${scheme.accents.length}). Поправить — правый клик по схеме`
          : `Схема «${scheme.name}» добавлена: фон — ${scheme.bg.length}, объекты — ${scheme.accents.length} цв.; композиция перекрашена`,
      )
    } catch (e) {
      notify(`Палитра не распознана: ${e instanceof PaletteError ? e.message : 'не удалось прочитать файл'}`, 'error')
    }
  }

  return (
    <Section
      title="Цветовая схема"
      aside={
        <div className="flex gap-0.5">
          <button type="button" className="rounded p-1 text-muted hover:bg-accent-soft hover:text-accent-strong" title="Загрузить палитру (SVG как в наборе: 2 колонки по 4 цвета)" onClick={() => fileRef.current?.click()}>
            <Icon name="upload" size={14} />
          </button>
          <button type="button" className="rounded p-1 text-muted hover:bg-accent-soft hover:text-accent-strong" title="Ввести цвета HEX" onClick={() => void addSchemeFromHex(schemeById(schemeId))}>
            <Icon name="plus" size={14} />
          </button>
          <input ref={fileRef} type="file" accept=".svg,image/svg+xml" hidden onChange={(e) => (void onPalette(e.target.files), (e.target.value = ''))} data-testid="upload-palette" />
        </div>
      }
    >
      <div className="flex flex-col gap-1.5" data-testid="schemes">
        {schemes.map((s) => (
          <button
            key={s.id}
            type="button"
            aria-pressed={s.id === schemeId}
            className={`rounded-lg border p-1.5 text-left transition-colors ${s.id === schemeId ? 'border-accent ring-1 ring-accent' : 'border-line hover:border-accent/60'}`}
            onClick={() => useComposition.getState().setScheme(s.id)}
            onContextMenu={(e) => {
              if (s.builtin) return
              e.preventDefault()
              openContextMenu(e.clientX, e.clientY, [
                { label: 'Изменить цвета', icon: 'pencil', onSelect: () => void editSchemeColors(s) },
                {
                  label: 'Удалить схему',
                  icon: 'trash',
                  danger: true,
                  onSelect: () =>
                    void confirmDialog({ title: `Удалить схему «${s.name}»?`, message: 'Композиции с ней перейдут на первую схему.', confirmText: 'Удалить', danger: true }).then(
                      (ok) => {
                        if (!ok) return
                        if (useComposition.getState().comp.schemeId === s.id) useComposition.getState().setScheme(useCatalog.getState().schemes[0]!.id)
                        useCatalog.getState().removeScheme(s.id)
                      },
                    ),
                },
              ])
            }}
            data-scheme={s.id}
          >
            <div className="mb-1 flex items-center justify-between text-xs">
              <span className="truncate">{s.name}</span>
              {!s.builtin && <span className="text-[10px] text-muted">своя</span>}
            </div>
            <SchemeBar scheme={s} />
          </button>
        ))}
      </div>
    </Section>
  )
}

function BackgroundSection() {
  const decor = useComposition((s) => s.comp.decor)
  const mirror = useComposition((s) => s.comp.mirror)
  return (
    <Section
      title="Фон"
      aside={
        <button
          type="button"
          aria-pressed={mirror}
          disabled={decor === 'none'}
          className={`rounded px-1.5 py-0.5 text-[11px] disabled:opacity-40 ${mirror ? 'bg-accent-soft text-accent-strong' : 'text-muted hover:text-ink'}`}
          onClick={() => useComposition.getState().toggleMirror()}
          title="Отразить декор фона по горизонтали"
        >
          ⇋ Отразить
        </button>
      }
    >
      <Segmented<DecorKind>
        value={decor}
        onChange={(v) => useComposition.getState().setDecor(v)}
        testid="decor"
        options={[
          ['circles', 'Круги'],
          ['wedge', 'Клин'],
          ['none', 'Без декора'],
        ]}
      />
    </Section>
  )
}

/** Цвета объекта: каждая роль файла — на любой допустимый цвет схемы */
function ColorRow({ obj, role, scheme }: { obj: CObject; role: Role; scheme: Scheme }) {
  const [open, setOpen] = useState(false)
  const allowed = allowedKeys(obj.state, scheme)
  const chosen = obj.colors[role]
  // Выбор, недоступный в этом состоянии или схеме, не действует — показываем цвет по умолчанию
  const target = resolveKey(chosen && allowed.includes(resolveKey(chosen, scheme)) ? chosen : role, scheme)
  return (
    <div className="relative">
      <button
        type="button"
        className="flex w-full items-center gap-2 rounded-md px-1 py-1 text-left text-xs hover:bg-workspace"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        data-role={role}
      >
        <span className="h-5 w-5 shrink-0 rounded border border-black/10" style={{ background: schemeColor(scheme, role) }} />
        <Icon name="chevronRight" size={12} className="text-muted" />
        <span className="h-5 w-5 shrink-0 rounded border border-black/10" style={{ background: schemeColor(scheme, target) }} />
        <span className="min-w-0 flex-1 truncate">{keyLabel(target, scheme)}</span>
        {target !== resolveKey(role, scheme) && <span className="text-[10px] text-accent-strong">изменен</span>}
      </button>
      {open && (
        <div className="mt-1 mb-1 grid grid-cols-5 gap-1 rounded-md border border-line bg-white p-1.5">
          {schemeKeys(scheme).map((k) => {
            const ok = allowed.includes(k)
            const color = schemeColor(scheme, k)
            return (
              <button
                key={k}
                type="button"
                disabled={!ok}
                title={ok ? `${keyLabel(k, scheme)} ${color}` : `${keyLabel(k, scheme)}: у фонового объекта — только цвета фона`}
                className={`flex h-7 items-center justify-center rounded border text-[10px] disabled:cursor-not-allowed disabled:opacity-25 ${k === target ? 'border-accent ring-1 ring-accent' : 'border-black/10'}`}
                style={{ background: color, color: inkOn(color) }}
                onClick={() => {
                  useComposition.getState().setColor(obj.id, role, k)
                  setOpen(false)
                }}
                data-target={k}
              >
                {k === target ? '✓' : ''}
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}

function ObjectSection() {
  const selected = useComposition((s) => s.selected)
  const objects = useComposition((s) => s.comp.objects)
  const size = useComposition((s) => s.comp.size)
  const schemeId = useComposition((s) => s.comp.schemeId)
  useCatalog((s) => s.schemes)
  useAssets((s) => s.version)
  const scheme = schemeById(schemeId)
  const st = useComposition.getState()

  if (!selected.length) {
    return (
      <Section title="Объект">
        <p className="text-xs leading-relaxed text-muted">Выберите объект на холсте. Shift+клик или рамка — несколько; {navigator.platform.includes('Mac') ? '⌘' : 'Ctrl'}+G — объединить.</p>
      </Section>
    )
  }
  if (selected.length > 1) {
    const groupable = !objects.filter((o) => selected.includes(o.id)).every((o) => o.groupId && o.groupId === objects.find((x) => x.id === selected[0])?.groupId)
    return (
      <Section title={`Выделено: ${selected.length}`}>
        <div className="flex gap-1.5">
          {groupable ? (
            <button type="button" className="flex-1 rounded-md border border-line px-2 py-1.5 text-xs hover:border-accent" onClick={() => st.groupSelected()}>
              Объединить
            </button>
          ) : (
            <button type="button" className="flex-1 rounded-md border border-line px-2 py-1.5 text-xs hover:border-accent" onClick={() => st.ungroupSelected()}>
              Разъединить
            </button>
          )}
        </div>
      </Section>
    )
  }
  const obj = objects.find((o) => o.id === selected[0])
  const item = obj && lookupItem(obj.itemId)
  if (!obj || !item) return null
  const asset = getAsset(item, size, obj.state)
  const roles = asset ? rolesInMarkup(asset.markup) : []
  const hasBg = !!item.variants[`${size}-bg`]
  return (
    <Section title="Объект" aside={<span className="truncate pl-2 text-xs text-ink">{item.name}</span>}>
      <div className="mb-2 flex h-16 items-center justify-center rounded-md bg-workspace p-1">
        <ItemThumb item={item} size={size} state={obj.state} scheme={scheme} className="h-full w-full" />
      </div>
      <Segmented
        value={obj.state}
        onChange={(v) => st.setState(obj.id, v)}
        testid="object-state"
        disabled={hasBg ? [] : ['bg']}
        options={[
          ['main', 'Основной', 'Цветной вариант объекта'],
          ['bg', 'Фоновый', hasBg ? 'Монохромный вариант: только цвета фона' : 'У этого объекта нет фонового варианта'],
        ]}
      />
      <label className="mt-2 flex items-center gap-2 text-xs text-muted">
        Поворот
        <input
          type="number"
          className="h-7 w-16 rounded border border-line px-1.5 text-xs tabular-nums outline-none focus:border-accent"
          value={Math.round(obj.rotation * 10) / 10}
          step={15}
          onChange={(e) => {
            const v = Number(e.target.value)
            if (Number.isFinite(v)) st.setRotation(obj.id, normalizeAngle(v))
          }}
          data-testid="rotation"
        />
        °
        <span className="ml-auto tabular-nums">
          X {Math.round(obj.x)} Y {Math.round(obj.y)}
        </span>
      </label>
      <div className="mt-3 mb-1 flex items-center justify-between text-xs text-muted">
        <span>Цвета {obj.state === 'bg' ? '(только фоновые)' : ''}</span>
        {Object.keys(obj.colors).length > 0 && (
          <button type="button" className="hover:text-accent-strong" onClick={() => st.resetColors(obj.id)}>
            Сбросить
          </button>
        )}
      </div>
      <div data-testid="object-colors">
        {roles.map((r) => (
          <ColorRow key={`${obj.id}:${r}`} obj={obj} role={r} scheme={scheme} />
        ))}
      </div>
      {obj.state === 'bg' && (
        <p className="mt-1 text-[11px] leading-snug text-muted">
          По правилам схемы фоновым объектам доступны только цвета фона и белый.
        </p>
      )}
    </Section>
  )
}

function LayersSection() {
  const objects = useComposition((s) => s.comp.objects)
  const selected = useComposition((s) => s.selected)
  useCatalog((s) => s.items)
  const [dragId, setDragId] = useState<string | null>(null)
  const rows = [...objects].reverse()
  return (
    <Section title={`Слои · ${objects.length}`}>
      {rows.length === 0 ? (
        <p className="text-xs text-muted">Пока пусто</p>
      ) : (
        <ul className="flex flex-col gap-0.5" data-testid="layers">
          {rows.map((o, i) => {
            const item = lookupItem(o.itemId)
            const prev = rows[i - 1]
            const groupStart = o.groupId && prev?.groupId !== o.groupId
            return (
              <li key={o.id}>
                {groupStart && <div className="mt-1 px-1 text-[10px] tracking-wide text-muted uppercase">Группа</div>}
                <button
                  type="button"
                  draggable
                  onDragStart={() => setDragId(o.id)}
                  onDragEnd={() => setDragId(null)}
                  onDragOver={(e) => dragId && e.preventDefault()}
                  onDrop={(e) => {
                    if (!dragId) return
                    e.preventDefault()
                    const r = e.currentTarget.getBoundingClientRect()
                    useComposition.getState().moveLayer(dragId, o.id, e.clientY < r.top + r.height / 2 ? 'above' : 'below')
                  }}
                  onClick={(e) => useComposition.getState().select(o.id, e.shiftKey)}
                  onContextMenu={(e) => {
                    e.preventDefault()
                    if (!useComposition.getState().selected.includes(o.id)) useComposition.getState().select(o.id)
                    openContextMenu(e.clientX, e.clientY, objectMenu(o.id))
                  }}
                  className={`flex w-full items-center gap-2 rounded-md px-1.5 py-1 text-left text-xs ${o.groupId ? 'pl-4' : ''} ${selected.includes(o.id) ? 'bg-accent-soft text-accent-strong' : 'hover:bg-workspace'}`}
                  data-layer={o.id}
                >
                  <span className="min-w-0 flex-1 truncate">{item?.name ?? 'Объект'}</span>
                  <span className={`rounded px-1 text-[10px] ${o.state === 'bg' ? 'bg-workspace text-muted' : 'bg-accent-soft text-accent-strong'}`}>
                    {o.state === 'bg' ? 'фон' : 'осн.'}
                  </span>
                </button>
              </li>
            )
          })}
        </ul>
      )}
    </Section>
  )
}

export function SettingsPanel() {
  return (
    <div className="scroll-thin h-full overflow-y-auto">
      <FormatSection />
      <SchemeSection />
      <BackgroundSection />
      <ObjectSection />
      <LayersSection />
    </div>
  )
}
