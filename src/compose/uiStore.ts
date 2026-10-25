import { create } from 'zustand'
import { loadApiKey, saveApiKey } from './storage'

/** Состояние панелей режима «Композиции» (не входит в историю и не сохраняется, кроме ключа ИИ) */
type ComposeUi = {
  tab: 'metaphor' | 'names'
  metaphor: string
  names: string
  /** Объекты, отмеченные в наборе для сценария «по объектам» */
  picked: string[]
  /** Чем объяснить последнюю сборку: какие слова к каким объектам привели */
  explanation: { source: 'ai' | 'dictionary' | 'names'; text: string } | null
  busy: boolean
  apiKey: string
  setTab: (tab: ComposeUi['tab']) => void
  setMetaphor: (v: string) => void
  setNames: (v: string) => void
  togglePicked: (id: string) => void
  setPicked: (ids: string[]) => void
  setExplanation: (e: ComposeUi['explanation']) => void
  setBusy: (busy: boolean) => void
  setApiKey: (key: string) => void
}

export const useComposeUi = create<ComposeUi>()((set) => ({
  tab: 'metaphor',
  metaphor: '',
  names: '',
  picked: [],
  explanation: null,
  busy: false,
  apiKey: loadApiKey(),
  setTab: (tab) => set({ tab }),
  setMetaphor: (metaphor) => set({ metaphor }),
  setNames: (names) => set({ names }),
  togglePicked: (id) => set((s) => ({ picked: s.picked.includes(id) ? s.picked.filter((x) => x !== id) : [...s.picked, id] })),
  setPicked: (picked) => set({ picked }),
  setExplanation: (explanation) => set({ explanation }),
  setBusy: (busy) => set({ busy }),
  setApiKey: (apiKey) => {
    saveApiKey(apiKey)
    set({ apiKey })
  },
}))
