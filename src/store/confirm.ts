import { create } from 'zustand'
import { keepAcrossHmr } from '../lib/hmr'

export type ConfirmRequest = {
  title: string
  message: string
  confirmText: string
  danger?: boolean
  /** Поле ввода (диалог-вопрос): подпись и начальное значение */
  input?: { label: string; value: string; placeholder?: string }
  resolve: (ok: boolean, value?: string) => void
}

export const useConfirm = keepAcrossHmr(import.meta.hot, 'store', () =>
  create<{ request: ConfirmRequest | null }>()(() => ({ request: null })),
)

/** Модальное подтверждение: true — пользователь согласился */
export function confirmDialog(opts: Omit<ConfirmRequest, 'resolve'>): Promise<boolean> {
  return new Promise((resolve) => useConfirm.setState({ request: { ...opts, resolve } }))
}

/** Диалог с полем ввода: введенный текст или null, если отменили */
export function promptDialog(opts: Omit<ConfirmRequest, 'resolve' | 'danger'> & { input: NonNullable<ConfirmRequest['input']> }): Promise<string | null> {
  return new Promise((resolve) =>
    useConfirm.setState({ request: { ...opts, resolve: (ok, value) => resolve(ok ? (value ?? '') : null) } }),
  )
}

export function resolveConfirm(ok: boolean, value?: string) {
  const { request } = useConfirm.getState()
  if (!request) return
  useConfirm.setState({ request: null })
  request.resolve(ok, value)
}

export const isDialogOpen = () => useConfirm.getState().request !== null
