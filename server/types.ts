// The four flow states a watched stream can be in, worst → best.
export type State = 'down' | 'stalled' | 'slow' | 'flowing'

// A problem state has a matching incident type; 'flowing' opens none.
export type IncidentType = Exclude<State, 'flowing'>

export type Station = {
  id: number
  name: string
  /** Base URL, e.g. https://live.superfm.ro */
  url: string
  /** Paths appended to the base, e.g. ["/stream", "/stream.aac"] */
  paths: string[]
  createdAt: number
}

export type StationInput = {
  name: string
  url: string
  paths: string[]
}

export type Incident = {
  id: number
  stationId: number
  path: string
  type: IncidentType
  startedAt: number
  endedAt: number | null
  detail: string
}

export type Heartbeat = {
  ts: number
  path: string
  state: State
  /** Measured bytes/sec at the sample. */
  rate: number
}

// Live per-target snapshot the watcher keeps in memory (drives status pills).
export type TargetStatus = {
  path: string
  url: string
  state: State
  /** Current throughput in bytes/sec (for the kbps readout), or null. */
  rate: number | null
  /** Seconds of audio delivered ÷ seconds of wall-clock (~1.0 = keeping
   *  pace). null during warmup or when the format can't be parsed. */
  realtime: number | null
  since: number
  /** False for HLS paths — not watched (byte-rate doesn't apply). */
  monitored: boolean
}
