export type State = 'down' | 'stalled' | 'slow' | 'flowing'

export type Target = {
  path: string
  url: string
  state: State
  rate: number | null
  expected: number | null
  since: number
  monitored: boolean
}

export type Station = {
  id: number
  name: string
  url: string
  paths: string[]
  createdAt: number
  targets: Target[]
}

export type Incident = {
  id: number
  stationId: number
  path: string
  type: Exclude<State, 'flowing'>
  startedAt: number
  endedAt: number | null
  detail: string
}

export type Heartbeat = { ts: number; path: string; state: State; rate: number }

export type History = {
  station: Omit<Station, 'targets'>
  targets: Target[]
  incidents: Incident[]
  heartbeats: Heartbeat[]
}

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null
    throw new Error(body?.error ?? `HTTP ${res.status}`)
  }
  return res.json() as Promise<T>
}

export const api = {
  async me(): Promise<{ username: string } | null> {
    const res = await fetch('/api/me')
    if (res.status === 401) return null
    return json(res)
  },
  async login(username: string, password: string): Promise<void> {
    await json(
      await fetch('/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
      }),
    )
  },
  async logout(): Promise<void> {
    await fetch('/api/logout', { method: 'POST' })
  },
  async stations(): Promise<Station[]> {
    return json(await fetch('/api/stations'))
  },
  async createStation(input: { name: string; url: string; paths: string[] }): Promise<Station> {
    return json(
      await fetch('/api/stations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(input),
      }),
    )
  },
  async deleteStation(id: number): Promise<void> {
    await json(await fetch(`/api/stations/${id}`, { method: 'DELETE' }))
  },
  async history(id: number, hours = 24): Promise<History> {
    return json(await fetch(`/api/stations/${id}/history?hours=${hours}`))
  },
}

export function fmtRate(bytesPerSec: number | null): string {
  if (bytesPerSec == null) return '—'
  const kbps = (bytesPerSec * 8) / 1000
  return kbps >= 1000 ? `${(kbps / 1000).toFixed(1)} Mbps` : `${Math.round(kbps)} kbps`
}

export function fmtDuration(ms: number): string {
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.round(s / 60)
  if (m < 60) return `${m}m`
  return `${(m / 60).toFixed(1)}h`
}
