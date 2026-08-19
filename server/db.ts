import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { config } from './config'
import type { Incident, IncidentType, State, Station, StationInput } from './types'

mkdirSync(dirname(config.dbPath), { recursive: true })

const db = new DatabaseSync(config.dbPath)
db.exec('PRAGMA journal_mode = WAL')
db.exec(`
  CREATE TABLE IF NOT EXISTS stations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    url TEXT NOT NULL,
    paths TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS incidents (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    station_id INTEGER NOT NULL,
    path TEXT NOT NULL,
    type TEXT NOT NULL,
    started_at INTEGER NOT NULL,
    ended_at INTEGER,
    detail TEXT NOT NULL DEFAULT ''
  );
  CREATE INDEX IF NOT EXISTS idx_incidents ON incidents (station_id, started_at);
  CREATE TABLE IF NOT EXISTS heartbeats (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    station_id INTEGER NOT NULL,
    path TEXT NOT NULL,
    ts INTEGER NOT NULL,
    state TEXT NOT NULL,
    rate INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_heartbeats ON heartbeats (station_id, ts);
`)

function rowToStation(r: Record<string, unknown>): Station {
  return {
    id: r.id as number,
    name: r.name as string,
    url: r.url as string,
    paths: JSON.parse(r.paths as string) as string[],
    createdAt: r.created_at as number,
  }
}

export const stations = {
  list(): Station[] {
    return db
      .prepare('SELECT * FROM stations ORDER BY name')
      .all()
      .map(rowToStation)
  },
  get(id: number): Station | null {
    const r = db.prepare('SELECT * FROM stations WHERE id = ?').get(id) as
      | Record<string, unknown>
      | undefined
    return r ? rowToStation(r) : null
  },
  create(input: StationInput): Station {
    const r = db
      .prepare(
        'INSERT INTO stations (name, url, paths, created_at) VALUES (?, ?, ?, ?) RETURNING *',
      )
      .get(
        input.name,
        input.url.replace(/\/+$/, ''),
        JSON.stringify(input.paths),
        Date.now(),
      ) as Record<string, unknown>
    return rowToStation(r)
  },
  update(id: number, input: StationInput): Station | null {
    const r = db
      .prepare(
        'UPDATE stations SET name = ?, url = ?, paths = ? WHERE id = ? RETURNING *',
      )
      .get(
        input.name,
        input.url.replace(/\/+$/, ''),
        JSON.stringify(input.paths),
        id,
      ) as Record<string, unknown> | undefined
    return r ? rowToStation(r) : null
  },
  remove(id: number): void {
    db.prepare('DELETE FROM incidents WHERE station_id = ?').run(id)
    db.prepare('DELETE FROM heartbeats WHERE station_id = ?').run(id)
    db.prepare('DELETE FROM stations WHERE id = ?').run(id)
  },
}

export const incidents = {
  /** The still-open incident for a target, if any. */
  open(stationId: number, path: string): Incident | null {
    const r = db
      .prepare(
        'SELECT * FROM incidents WHERE station_id = ? AND path = ? AND ended_at IS NULL ORDER BY started_at DESC LIMIT 1',
      )
      .get(stationId, path) as Record<string, unknown> | undefined
    return r ? (r as unknown as Incident) : null
  },
  start(
    stationId: number,
    path: string,
    type: IncidentType,
    startedAt: number,
    detail: string,
  ): void {
    db.prepare(
      'INSERT INTO incidents (station_id, path, type, started_at, detail) VALUES (?, ?, ?, ?, ?)',
    ).run(stationId, path, type, startedAt, detail)
  },
  end(id: number, endedAt: number): void {
    db.prepare('UPDATE incidents SET ended_at = ? WHERE id = ?').run(endedAt, id)
  },
  since(stationId: number, sinceTs: number): Incident[] {
    return db
      .prepare(
        'SELECT id, station_id AS stationId, path, type, started_at AS startedAt, ended_at AS endedAt, detail FROM incidents WHERE station_id = ? AND (ended_at IS NULL OR ended_at >= ?) ORDER BY started_at DESC',
      )
      .all(stationId, sinceTs) as unknown as Incident[]
  },
}

export const heartbeats = {
  add(stationId: number, path: string, ts: number, state: State, rate: number): void {
    db.prepare(
      'INSERT INTO heartbeats (station_id, path, ts, state, rate) VALUES (?, ?, ?, ?, ?)',
    ).run(stationId, path, ts, state, Math.round(rate))
  },
  since(stationId: number, sinceTs: number): { ts: number; path: string; state: State; rate: number }[] {
    return db
      .prepare(
        'SELECT ts, path, state, rate FROM heartbeats WHERE station_id = ? AND ts >= ? ORDER BY ts',
      )
      .all(stationId, sinceTs) as unknown as { ts: number; path: string; state: State; rate: number }[]
  },
}

/** Delete history older than the retention window. */
export function prune(): void {
  const cutoff = Date.now() - config.retentionDays * 86_400_000
  db.prepare('DELETE FROM heartbeats WHERE ts < ?').run(cutoff)
  db.prepare('DELETE FROM incidents WHERE ended_at IS NOT NULL AND ended_at < ?').run(cutoff)
}
