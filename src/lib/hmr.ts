/**
 * Один экземпляр на всю жизнь страницы, даже если модуль перевыполнился при горячем обновлении (Vite HMR).
 * Иначе часть модулей держит старое хранилище, а часть — новое, и, например, меню открывается «в пустоту».
 * В продакшене import.meta.hot нет — просто создаем экземпляр.
 */
export function keepAcrossHmr<T>(hot: { data: Record<string, unknown> } | undefined, key: string, create: () => T): T {
  if (!hot) return create()
  if (!(key in hot.data)) hot.data[key] = create()
  return hot.data[key] as T
}
