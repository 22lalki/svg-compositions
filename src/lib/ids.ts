const ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz'

/** Короткий случайный id из [0-9a-z] — годится и для id, и для префикса c<id>- */
export function shortId(length = 8): string {
  const bytes = crypto.getRandomValues(new Uint8Array(length))
  let id = ''
  for (const b of bytes) id += ALPHABET[b % ALPHABET.length]
  return id
}
