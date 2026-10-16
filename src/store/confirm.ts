import { create } from 'zustand'
import { keepAcrossHmr } from '../lib/hmr'

export type ConfirmRequest = {
  title: string
  message: string
  confirmText: string
  danger?: boolean
  resolve: (ok: boolean) => void
}

export const useConfirm = keepAcrossHmr(import.meta.hot, 'store', () =>
  create<{ request: ConfirmRequest | null }>()(() => ({ request: null })),
)

/** Модальное подтверждение: true — пользователь согласился */
export function confirmDialog(opts: Omit<ConfirmRequest, 'resolve'>): Promise<boolean> {
  return new Promise((resolve) => useConfirm.setState({ request: { ...opts, resolve } }))
}

export function resolveConfirm(ok: boolean) {
  const { request } = useConfirm.getState()
  if (!request) return
  useConfirm.setState({ request: null })
  request.resolve(ok)
}

export const isDialogOpen = () => useConfirm.getState().request !== null
