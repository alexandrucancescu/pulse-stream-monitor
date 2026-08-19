import { createHmac, timingSafeEqual } from 'node:crypto'
import { config } from './config'

// A tiny signed-cookie session: base64url(payload).hmac. No store needed —
// the signature is the whole check. Good enough for a single-user tool.
const TTL_MS = 30 * 86_400_000

function sign(data: string): string {
  return createHmac('sha256', config.secret).update(data).digest('base64url')
}

export function issueSession(): string {
  const payload = Buffer.from(
    JSON.stringify({ u: config.username, exp: Date.now() + TTL_MS }),
  ).toString('base64url')
  return `${payload}.${sign(payload)}`
}

export function verifySession(token: string | undefined): boolean {
  if (!token) return false
  const [payload, mac] = token.split('.')
  if (!payload || !mac) return false
  const expected = sign(payload)
  // Constant-time compare on equal-length buffers
  if (mac.length !== expected.length) return false
  if (!timingSafeEqual(Buffer.from(mac), Buffer.from(expected))) return false
  try {
    const { exp } = JSON.parse(Buffer.from(payload, 'base64url').toString()) as {
      exp: number
    }
    return typeof exp === 'number' && exp > Date.now()
  } catch {
    return false
  }
}

export function checkCredentials(username: string, password: string): boolean {
  // Constant-time-ish: compare both fields via HMAC of each side
  const a = sign(`${username}:${password}`)
  const b = sign(`${config.username}:${config.password}`)
  return a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b))
}

export const SESSION_COOKIE = 'psm_session'
export const SESSION_MAX_AGE = TTL_MS / 1000
