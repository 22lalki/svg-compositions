import type { ComponentProps, ReactNode } from 'react'
import { useEffect, useRef } from 'react'
import { Icon, type IconName } from './Icon'
import { useUi } from '../store/ui'
import { resolveConfirm, useConfirm } from '../store/confirm'

/** Кнопка-иконка с подсказкой */
export function IconButton({
  icon,
  label,
  shortcut,
  className = '',
  ...rest
}: { icon: IconName; label: string; shortcut?: string } & ComponentProps<'button'>) {
  return (
    <button
      type="button"
      title={shortcut ? `${label} (${shortcut})` : label}
      aria-label={label}
      className={`inline-flex h-8 w-8 items-center justify-center rounded-md text-ink transition-colors hover:bg-accent-soft hover:text-accent-strong disabled:pointer-events-none disabled:opacity-35 ${className}`}
      {...rest}
    >
      <Icon name={icon} />
    </button>
  )
}

export function Button({
  variant = 'secondary',
  className = '',
  children,
  ...rest
}: { variant?: 'primary' | 'secondary' | 'danger' | 'ghost'; children: ReactNode } & ComponentProps<'button'>) {
  const styles = {
    primary: 'bg-accent text-white hover:bg-accent-strong shadow-sm',
    secondary: 'bg-white text-ink border border-line hover:border-accent hover:text-accent-strong',
    danger: 'bg-rose-600 text-white hover:bg-rose-700 shadow-sm',
    ghost: 'text-ink hover:bg-accent-soft hover:text-accent-strong',
  }[variant]
  return (
    <button
      type="button"
      className={`inline-flex h-8 items-center justify-center gap-1.5 rounded-md px-3 text-sm font-medium transition-colors disabled:pointer-events-none disabled:opacity-40 ${styles} ${className}`}
      {...rest}
    >
      {children}
    </button>
  )
}

export const Divider = () => <div className="mx-1 h-5 w-px bg-line" />

/* ---------- Подтверждение ---------- */

export function ConfirmHost() {
  const request = useConfirm((s) => s.request)
  const confirmRef = useRef<HTMLButtonElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!request) return
    if (inputRef.current) inputRef.current.select()
    else confirmRef.current?.focus()
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') resolveConfirm(false)
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [request])

  if (!request) return null
  const close = (ok: boolean) => resolveConfirm(ok, inputRef.current?.value)
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink/30 p-4" onPointerDown={() => close(false)}>
      <div
        role="dialog"
        aria-modal
        className="w-full max-w-md rounded-xl bg-white p-5 shadow-2xl"
        onPointerDown={(e) => e.stopPropagation()}
      >
        <h2 className="text-base font-semibold">{request.title}</h2>
        <p className="mt-2 text-sm leading-relaxed text-muted">{request.message}</p>
        {request.input && (
          <input
            ref={inputRef}
            defaultValue={request.input.value}
            placeholder={request.input.placeholder}
            aria-label={request.input.label}
            maxLength={80}
            onKeyDown={(e) => e.key === 'Enter' && close(true)}
            className="mt-3 h-9 w-full rounded-md border border-line px-2.5 text-sm outline-none focus:border-accent"
          />
        )}
        <div className="mt-5 flex justify-end gap-2">
          <Button onClick={() => close(false)}>Отмена</Button>
          <Button ref={confirmRef} variant={request.danger ? 'danger' : 'primary'} onClick={() => close(true)}>
            {request.confirmText}
          </Button>
        </div>
      </div>
    </div>
  )
}

/* ---------- Уведомления ---------- */

export function Toasts() {
  const toasts = useUi((s) => s.toasts)
  return (
    <div className="pointer-events-none fixed bottom-4 left-1/2 z-50 flex -translate-x-1/2 flex-col items-center gap-2">
      {toasts.map((t) => (
        <div
          key={t.id}
          role="status"
          className={`rounded-lg px-4 py-2 text-sm font-medium shadow-lg ${t.kind === 'error' ? 'bg-rose-600 text-white' : 'bg-ink text-white'}`}
        >
          {t.text}
        </div>
      ))}
    </div>
  )
}
