import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import Fastify from 'fastify'
import type { FastifyReply, FastifyRequest } from 'fastify'
import cookie from '@fastify/cookie'
import fastifyStatic from '@fastify/static'
import { config } from './config'
import { stations as stationStore, incidents, heartbeats, prune } from './db'
import { manager } from './watcher'
import {
  SESSION_COOKIE,
  SESSION_MAX_AGE,
  checkCredentials,
  issueSession,
  verifySession,
} from './auth'
import type { StationInput } from './types'

const app = Fastify({ logger: { level: 'warn' } })
await app.register(cookie)

// ── Auth ─────────────────────────────────────────────────────────────
function authed(req: FastifyRequest): boolean {
  return verifySession(req.cookies[SESSION_COOKIE])
}

async function requireAuth(req: FastifyRequest, reply: FastifyReply) {
  if (!authed(req)) return reply.code(401).send({ error: 'Unauthorized' })
}

app.post('/api/login', async (req, reply) => {
  const { username, password } = (req.body ?? {}) as { username?: string; password?: string }
  if (!username || !password || !checkCredentials(username, password)) {
    return reply.code(401).send({ error: 'Wrong username or password' })
  }
  reply.setCookie(SESSION_COOKIE, issueSession(), {
    httpOnly: true,
    sameSite: 'lax',
    secure: req.protocol === 'https',
    path: '/',
    maxAge: SESSION_MAX_AGE,
  })
  return { ok: true }
})

app.post('/api/logout', async (_req, reply) => {
  reply.clearCookie(SESSION_COOKIE, { path: '/' })
  return { ok: true }
})

app.get('/api/me', async (req, reply) => {
  if (!authed(req)) return reply.code(401).send({ error: 'Unauthorized' })
  return { username: config.username }
})

// ── Stations ─────────────────────────────────────────────────────────
function parseInput(body: unknown): StationInput | { error: string } {
  const b = (body ?? {}) as Record<string, unknown>
  const name = String(b.name ?? '').trim()
  const url = String(b.url ?? '').trim()
  const paths = Array.isArray(b.paths) ? b.paths.map((p) => String(p).trim()).filter(Boolean) : []
  if (!name) return { error: 'Name is required' }
  if (!/^https?:\/\//.test(url)) return { error: 'URL must start with http:// or https://' }
  if (paths.length === 0) return { error: 'At least one path is required' }
  if (paths.some((p) => !p.startsWith('/'))) return { error: 'Paths must start with /' }
  return { name, url, paths }
}

// Discover a Pulse instance's mounts via its /api/discovery endpoint,
// server-side (no CORS). The UI turns the result into a station.
app.post('/api/discover', { preHandler: requireAuth }, async (req, reply) => {
  const base = String((req.body as { url?: string })?.url ?? '')
    .trim()
    .replace(/\/+$/, '')
  if (!/^https?:\/\//.test(base)) {
    return reply.code(400).send({ error: 'URL must start with http:// or https://' })
  }
  let data: { station?: unknown; streams?: unknown }
  try {
    const res = await fetch(`${base}/api/discovery`, { signal: AbortSignal.timeout(8000) })
    if (!res.ok) return reply.code(502).send({ error: `Discovery failed (HTTP ${res.status})` })
    data = (await res.json()) as typeof data
  } catch {
    return reply.code(502).send({ error: 'Could not reach that Pulse instance' })
  }
  if (!data || !Array.isArray(data.streams)) {
    return reply.code(502).send({ error: 'That does not look like a Pulse instance' })
  }
  return { url: base, station: data.station ?? null, streams: data.streams }
})

app.get('/api/stations', { preHandler: requireAuth }, async () =>
  stationStore.list().map((s) => ({ ...s, targets: manager.snapshot(s) })),
)

app.post('/api/stations', { preHandler: requireAuth }, async (req, reply) => {
  const input = parseInput(req.body)
  if ('error' in input) return reply.code(400).send(input)
  const station = stationStore.create(input)
  manager.reconcile()
  return station
})

app.put<{ Params: { id: string } }>(
  '/api/stations/:id',
  { preHandler: requireAuth },
  async (req, reply) => {
    const input = parseInput(req.body)
    if ('error' in input) return reply.code(400).send(input)
    const station = stationStore.update(Number(req.params.id), input)
    if (!station) return reply.code(404).send({ error: 'Station not found' })
    manager.reconcile()
    return station
  },
)

app.delete<{ Params: { id: string } }>(
  '/api/stations/:id',
  { preHandler: requireAuth },
  async (req) => {
    stationStore.remove(Number(req.params.id))
    manager.reconcile()
    return { ok: true }
  },
)

app.get<{ Params: { id: string }; Querystring: { hours?: string } }>(
  '/api/stations/:id/history',
  { preHandler: requireAuth },
  async (req, reply) => {
    const station = stationStore.get(Number(req.params.id))
    if (!station) return reply.code(404).send({ error: 'Station not found' })
    const hours = Math.min(Number(req.query.hours) || 24, config.retentionDays * 24)
    const since = Date.now() - hours * 3_600_000
    return {
      station,
      targets: manager.snapshot(station),
      incidents: incidents.since(station.id, since),
      heartbeats: heartbeats.since(station.id, since),
    }
  },
)

// ── Static UI (production build) ─────────────────────────────────────
const uiDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'ui')
if (existsSync(uiDir)) {
  await app.register(fastifyStatic, { root: uiDir })
  app.setNotFoundHandler((req, reply) => {
    if (req.url.startsWith('/api')) return reply.code(404).send({ error: 'Not found' })
    return reply.sendFile('index.html')
  })
}

// ── Boot ─────────────────────────────────────────────────────────────
manager.start()
prune()
setInterval(prune, 3_600_000).unref() // hourly retention sweep

await app.listen({ host: '0.0.0.0', port: config.port })
console.log(`[pulse-stream-monitor] listening on :${config.port}`)

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    void manager.stop().finally(() => process.exit(0))
  })
}
