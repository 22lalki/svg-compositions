import { create } from 'zustand'
import { keepAcrossHmr } from '../lib/hmr'

export type ConfirmRequest = {
  title: string
  message: string
  confirmText: string
  danger?: boolean
  /** Поле ввода (диалог-вопрос): подпись и начальное значение */
  input?: { label: string; value: string; placeholder?: string; maxLength?: number; type?: 'text' | 'password' }
  resolve: (ok: boolean, value?: string) => void
  /** Номер запроса: новый диалог — новое поле ввода, а не старое с прежним текстом */
  id?: number
}

export const useConfirm = keepAcrossHmr(import.meta.hot, 'store', () =>
  create<{ request: ConfirmRequest | null }>()(() => ({ request: null })),
)

let seq = 0

/** Показать запрос; открытый раньше диалог при этом считается отмененным, а не зависает навсегда */
function open(request: ConfirmRequest) {
  const previous = useConfirm.getState().request
  useConfirm.setState({ request: { ...request, id: ++seq } })
  previous?.resolve(false)
}

/** Модальное подтверждение: true — пользователь согласился */
export function confirmDialog(opts: Omit<ConfirmRequest, 'resolve'>): Promise<boolean> {
  return new Promise((resolve) => open({ ...opts, resolve }))
}

/** Диалог с полем ввода: введенный текст или null, если отменили */
export function promptDialog(opts: Omit<ConfirmRequest, 'resolve' | 'danger'> & { input: NonNullable<ConfirmRequest['input']> }): Promise<string | null> {
  return new Promise((resolve) => open({ ...opts, resolve: (ok, value) => resolve(ok ? (value ?? '') : null) }))
}

export function resolveConfirm(ok: boolean, value?: string) {
  const { request } = useConfirm.getState()
  if (!request) return
  useConfirm.setState({ request: null })
  request.resolve(ok, value)
}

export const isDialogOpen = () => useConfirm.getState().request !== null
