import { createHash } from 'node:crypto'

const {
  MONITOR_USERNAME,
  MONITOR_PASSWORD,
  MONITOR_SECRET,
  MONITOR_PORT,
  MONITOR_DB,
  MONITOR_RETENTION_DAYS,
  MONITOR_HEARTBEAT_SECONDS,
} = process.env

const username = MONITOR_USERNAME || 'admin'
const password = MONITOR_PASSWORD || 'admin'

if (!MONITOR_PASSWORD) {
  console.warn(
    '[config] MONITOR_PASSWORD is unset — using the dev default "admin". Set it before exposing this tool.',
  )
}

export const config = {
  username,
  password,
  // Cookie-signing secret: explicit, else derived from the credentials so it
  // stays stable across restarts without a second env var.
  secret:
    MONITOR_SECRET ||
    createHash('sha256').update(`${username}:${password}`).digest('hex'),
  port: Number(MONITOR_PORT) || 4000,
  dbPath: MONITOR_DB || './data/monitor.db',
  retentionDays: Number(MONITOR_RETENTION_DAYS) || 30,
  heartbeatSeconds: Number(MONITOR_HEARTBEAT_SECONDS) || 60,
}

// ── Watcher tuning (fixed; sane for internet radio) ──────────────────
export const watcher = {
  // Rolling window over which the realtime ratio + byte rate are measured.
  windowSeconds: 20,
  // No bytes for this long while connected → stalled.
  stallSeconds: 8,
  // Delivered-audio ÷ wall-clock below this → slow (falling behind realtime).
  slowRatio: 0.9,
  // Ignore the first moments of a connection (icecast burst, window fill).
  warmupSeconds: 15,
  // Reconnect backoff after a drop.
  reconnectBaseMs: 2000,
  reconnectMaxMs: 30_000,
}
