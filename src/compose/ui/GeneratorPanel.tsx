import { useCatalog } from '../catalogStore'
import { useComposition } from '../compositionStore'
import { composeFromMetaphor, composeFromNames } from '../generate'
import { useComposeUi } from '../uiStore'
import { AI_MODEL } from '../ai'
import { Button } from '../../components/ui'
import { Icon } from '../../components/Icon'
import { promptDialog } from '../../store/confirm'
import { notify } from '../../store/ui'

const EXAMPLES = ['Финансовая грамотность', 'Идея для стартапа', 'Музыка для концентрации', 'Командная работа', 'Подписать договор', 'Рост и забота']

async function configureAi() {
  const current = useComposeUi.getState().apiKey
  const key = await promptDialog({
    title: 'ИИ для метафор (по желанию)',
    message:
      `Со своим ключом Claude API метафору разберет модель ${AI_MODEL}: она понимает сложные фразы и выбирает объекты только из набора. ` +
      'Ключ хранится только в этом браузере, запросы идут напрямую в API Anthropic и оплачиваются по вашему ключу. ' +
      'Без ключа работает встроенный словарь. Чтобы отключить ИИ, очистите поле.',
    confirmText: 'Сохранить',
    input: { label: 'Ключ Claude API', value: current, placeholder: 'sk-ant-…', maxLength: 400, type: 'password' },
  })
  if (key === null) return
  useComposeUi.getState().setApiKey(key.trim())
  notify(key.trim() ? 'ИИ включен: метафоры разбирает Claude' : 'ИИ выключен: работает словарь')
}

export function GeneratorPanel() {
  const ui = useComposeUi()
  const generation = useComposition((s) => s.generation)
  const items = useCatalog((s) => s.items)
  const pickedItems = ui.picked.flatMap((id) => items.find((i) => i.id === id) ?? [])
  // Наборов несколько — пояснение к тому, что сейчас на холсте («Другой» меняет и объекты)
  const currentEntry = generation && generation.sets.length > 1 ? generation.entries[generation.index] : undefined
  const currentNote = currentEntry ? generation!.sets[currentEntry.set]?.note : undefined

  const run = () => (ui.tab === 'metaphor' ? void composeFromMetaphor(ui.metaphor) : void composeFromNames(ui.names, ui.picked))
  const field = 'w-full rounded-md border border-line bg-white px-2.5 py-2 text-sm outline-none focus:border-accent'

  return (
    <section className="border-b border-line p-3" aria-label="Сборка композиции">
      <div className="mb-2 grid grid-cols-2 rounded-lg bg-workspace p-0.5 text-xs font-medium" role="tablist">
        {(
          [
            ['metaphor', 'По метафоре'],
            ['names', 'По объектам'],
          ] as const
        ).map(([tab, label]) => (
          <button
            key={tab}
            type="button"
            role="tab"
            aria-selected={ui.tab === tab}
            className={`rounded-md py-1.5 transition-colors ${ui.tab === tab ? 'bg-white text-ink shadow-sm' : 'text-muted hover:text-ink'}`}
            onClick={() => ui.setTab(tab)}
          >
            {label}
          </button>
        ))}
      </div>

      {ui.tab === 'metaphor' ? (
        <>
          <textarea
            className={`${field} h-16 resize-none`}
            placeholder="Метафора или название: «финансовая грамотность», «идея для стартапа»…"
            value={ui.metaphor}
            onChange={(e) => ui.setMetaphor(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                run()
              }
            }}
            data-testid="metaphor-input"
          />
          <div className="mt-1.5 flex flex-wrap gap-1">
            {EXAMPLES.map((x) => (
              <button
                key={x}
                type="button"
                className="rounded-full border border-line px-2 py-0.5 text-[11px] text-muted hover:border-accent hover:text-accent-strong"
                onClick={() => {
                  ui.setMetaphor(x)
                  void composeFromMetaphor(x)
                }}
              >
                {x}
              </button>
            ))}
          </div>
        </>
      ) : (
        <>
          <input
            className={field}
            placeholder="Названия: телефон, пазлы, монета…"
            value={ui.names}
            onChange={(e) => ui.setNames(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && run()}
            data-testid="names-input"
          />
          <div className="mt-1.5 min-h-6 text-xs text-muted">
            {pickedItems.length ? (
              <div className="flex flex-wrap gap-1">
                {pickedItems.map((i) => (
                  <button
                    key={i.id}
                    type="button"
                    className="inline-flex items-center gap-1 rounded-full bg-accent-soft px-2 py-0.5 text-[11px] text-accent-strong"
                    onClick={() => ui.togglePicked(i.id)}
                    title="Убрать"
                  >
                    {i.name} <Icon name="x" size={10} />
                  </button>
                ))}
              </div>
            ) : (
              'Или отметьте объекты в наборе ниже'
            )}
          </div>
        </>
      )}

      <div className="mt-2 flex items-center gap-1.5">
        <Button variant="primary" className="flex-1" onClick={run} disabled={ui.busy} data-testid="compose">
          <Icon name="sparkles" /> {ui.busy ? 'Подбираю…' : 'Собрать'}
        </Button>
        <Button
          onClick={() => useComposition.getState().nextVariant()}
          disabled={!generation || generation.total < 2}
          title="Другая раскладка тех же объектов"
          data-testid="next-variant"
        >
          <Icon name="shuffle" /> Другой
        </Button>
      </div>

      <div className="mt-2 flex items-center justify-between text-[11px] text-muted">
        <span data-testid="variant-info">{generation ? `Вариант ${generation.index + 1} из ${generation.total}` : 'Раскладки — по примерам дизайнера'}</span>
        <button type="button" className="inline-flex items-center gap-1 hover:text-accent-strong" onClick={() => void configureAi()} data-testid="ai-settings">
          <Icon name="key" size={12} /> {ui.apiKey ? 'ИИ: Claude' : 'ИИ: выкл'}
        </button>
      </div>

      {ui.explanation && (
        <p className="mt-2 rounded-md bg-workspace px-2 py-1.5 text-[11px] leading-snug text-muted" data-testid="explanation">
          <span className="font-medium text-ink">
            {ui.explanation.source === 'ai' ? 'Подобрал ИИ: ' : ui.explanation.source === 'dictionary' ? 'По словарю: ' : 'Объекты: '}
          </span>
          {currentNote ?? ui.explanation.text}
        </p>
      )}
    </section>
  )
}
