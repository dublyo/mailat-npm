// Web Crypto is global in browsers, edge runtimes, Deno, Bun and Node >= 19.
// Node 18 only exposes it from `node:crypto`, loaded lazily so bundlers for
// other runtimes never see a static Node import.
let cached: Crypto | undefined

export async function getCrypto(): Promise<Crypto> {
  if (cached) return cached
  const g = (globalThis as { crypto?: Crypto }).crypto
  if (g?.subtle && typeof g.getRandomValues === 'function') return (cached = g)
  try {
    const specifier = 'node:crypto'
    const mod = (await import(/* @vite-ignore */ /* webpackIgnore: true */ specifier)) as { webcrypto?: Crypto }
    if (mod.webcrypto?.subtle) return (cached = mod.webcrypto)
  } catch {
    // fall through
  }
  throw new Error('Web Crypto is not available in this runtime')
}

export async function randomUUID(): Promise<string> {
  const c = await getCrypto()
  if (typeof c.randomUUID === 'function') return c.randomUUID()
  const b = c.getRandomValues(new Uint8Array(16))
  b[6] = (b[6]! & 0x0f) | 0x40
  b[8] = (b[8]! & 0x3f) | 0x80
  const h = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`
}

const encoder = new TextEncoder()

export function toBytes(input: string | Uint8Array | ArrayBuffer): Uint8Array {
  if (typeof input === 'string') return encoder.encode(input)
  if (input instanceof Uint8Array) return input
  return new Uint8Array(input)
}

export function toHex(bytes: ArrayBuffer): string {
  return Array.from(new Uint8Array(bytes), (x) => x.toString(16).padStart(2, '0')).join('')
}

export function toBase64(bytes: Uint8Array): string {
  let binary = ''
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  }
  return btoa(binary)
}

/** Constant-time comparison of two strings of equal length. */
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}
