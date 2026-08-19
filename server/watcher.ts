import { config, watcher as tune } from './config'
import { heartbeats, incidents, stations as stationStore } from './db'
import { createAudioClock, type AudioClock } from './audioClock'
import type { State, Station, TargetStatus } from './types'

const isHls = (path: string) => /\.m3u8($|\?)|\/hls\b/i.test(path)
const key = (stationId: number, path: string) => `${stationId}::${path}`

/**
 * Watches ONE stream path: connects like a listener, parses the audio to
 * count delivered audio-time vs wall-clock, and classifies flow as
 * flowing / slow / stalled / down. Persists incidents on state change; the
 * manager samples state into heartbeats on a timer.
 */
class TargetWatcher {
  state: State = 'down'
  rate: number | null = null // bytes/sec, for the kbps readout
  realtime: number | null = null // delivered audio-seconds ÷ wall-seconds
  since = Date.now()

  private stopped = false
  private connected = false
  private connectedAt = 0
  private lastByteAt = 0
  private failures = 0
  private controller: AbortController | null = null
  private clock: AudioClock | null = null
  private byteLog: { t: number; n: number }[] = []
  private audioLog: { t: number; a: number }[] = []
  private timer: ReturnType<typeof setInterval> | null = null

  constructor(
    readonly stationId: number,
    readonly path: string,
    readonly url: string,
  ) {}

  start() {
    this.timer = setInterval(() => this.evaluate(), 1000)
    void this.connectLoop()
  }

  async stop() {
    this.stopped = true
    if (this.timer) clearInterval(this.timer)
    this.controller?.abort()
    // Close any open incident so history isn't left dangling
    const open = incidents.open(this.stationId, this.path)
    if (open) incidents.end(open.id, Date.now())
  }

  status(): TargetStatus {
    return {
      path: this.path,
      url: this.url,
      state: this.state,
      rate: this.rate,
      realtime: this.realtime,
      since: this.since,
      monitored: true,
    }
  }

  private async connectLoop() {
    while (!this.stopped) {
      this.controller = new AbortController()
      try {
        const res = await fetch(this.url, {
          signal: this.controller.signal,
          headers: { 'Icy-MetaData': '0', 'User-Agent': 'pulse-stream-monitor' },
        })
        if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`)

        this.onConnected()
        // Pick the audio-time parser from the content type (path as fallback)
        this.clock = createAudioClock(res.headers.get('content-type'), this.path)

        const reader = res.body.getReader()
        while (!this.stopped) {
          const { done, value } = await reader.read()
          if (done) break
          if (value) {
            this.onBytes(Buffer.from(value.buffer, value.byteOffset, value.byteLength))
          }
        }
        // Clean end of stream = the server closed on us
        this.onDisconnected()
      } catch {
        if (this.stopped) return
        this.onDisconnected()
      }
      if (this.stopped) return
      const backoff = Math.min(
        tune.reconnectBaseMs * 2 ** this.failures,
        tune.reconnectMaxMs,
      )
      this.failures++
      await sleep(backoff)
    }
  }

  private onConnected() {
    this.connected = true
    this.connectedAt = Date.now()
    this.lastByteAt = Date.now()
    this.failures = 0
    this.byteLog = []
    this.audioLog = []
    this.clock = null
    this.realtime = null
  }

  private onDisconnected() {
    this.connected = false
  }

  private onBytes(chunk: Buffer) {
    this.lastByteAt = Date.now()
    this.byteLog.push({ t: this.lastByteAt, n: chunk.length })
    this.clock?.feed(chunk)
  }

  /** Current bytes/sec over the rolling window (for the kbps readout). */
  private currentByteRate(now: number): number {
    const windowMs = tune.windowSeconds * 1000
    const from = now - windowMs
    this.byteLog = this.byteLog.filter((e) => e.t >= from)
    const bytes = this.byteLog.reduce((s, e) => s + e.n, 0)
    const spanMs = Math.min(now - this.connectedAt, windowMs)
    if (spanMs <= 0) return 0
    return bytes / (spanMs / 1000)
  }

  /** Delivered audio-seconds ÷ wall-seconds over the window (~1.0 = healthy). */
  private computeRealtime(now: number): number | null {
    const from = now - tune.windowSeconds * 1000
    this.audioLog = this.audioLog.filter((e) => e.t >= from)
    if (this.audioLog.length < 2) return null
    const first = this.audioLog[0]
    const last = this.audioLog[this.audioLog.length - 1]
    const wall = (last.t - first.t) / 1000
    if (wall < 5) return null // not enough span to judge yet
    return (last.a - first.a) / wall
  }

  private evaluate() {
    if (this.stopped) return
    const now = Date.now()
    let next: State

    if (!this.connected) {
      next = 'down'
      this.rate = null
      this.realtime = null
    } else {
      this.rate = this.currentByteRate(now)
      if (this.clock) {
        this.audioLog.push({ t: now, a: this.clock.audioSeconds() })
        this.realtime = this.computeRealtime(now)
      }
      const inWarmup = now - this.connectedAt < tune.warmupSeconds * 1000

      if (now - this.lastByteAt > tune.stallSeconds * 1000) {
        next = 'stalled'
      } else if (inWarmup) {
        next = 'flowing'
      } else if (this.realtime != null && this.realtime < tune.slowRatio) {
        // Delivering audio slower than realtime → listener buffers drain.
        // Measured on audio-time, so it's correct for VBR (Opus) too.
        next = 'slow'
      } else {
        next = 'flowing'
      }
    }

    if (next !== this.state) this.transition(next, now)
  }

  private transition(next: State, now: number) {
    const open = incidents.open(this.stationId, this.path)
    if (next === 'flowing') {
      if (open) incidents.end(open.id, now)
    } else if (!open || open.type !== next) {
      if (open) incidents.end(open.id, now)
      incidents.start(this.stationId, this.path, next, now, this.detail(next))
    }
    this.state = next
    this.since = now
  }

  private detail(state: State): string {
    if (state === 'slow' && this.realtime != null) {
      return `${Math.round(this.realtime * 100)}% of realtime`
    }
    return ''
  }

  sampleHeartbeat() {
    heartbeats.add(this.stationId, this.path, Date.now(), this.state, this.rate ?? 0)
  }
}

class WatcherManager {
  private watchers = new Map<string, TargetWatcher>()
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null

  start() {
    this.reconcile()
    this.heartbeatTimer = setInterval(
      () => this.watchers.forEach((w) => w.sampleHeartbeat()),
      config.heartbeatSeconds * 1000,
    )
  }

  /** Sync running watchers to the current station list (call after any CRUD). */
  reconcile() {
    const wanted = new Set<string>()
    for (const st of stationStore.list()) {
      for (const path of st.paths) {
        if (isHls(path)) continue // HLS needs playlist-freshness monitoring — TODO
        const k = key(st.id, path)
        wanted.add(k)
        if (!this.watchers.has(k)) {
          const w = new TargetWatcher(st.id, path, `${st.url}${path}`)
          this.watchers.set(k, w)
          w.start()
        }
      }
    }
    for (const [k, w] of this.watchers) {
      if (!wanted.has(k)) {
        void w.stop()
        this.watchers.delete(k)
      }
    }
  }

  snapshot(station: Station): TargetStatus[] {
    return station.paths.map((path) => {
      const url = `${station.url}${path}`
      if (isHls(path)) {
        return { path, url, state: 'flowing', rate: null, realtime: null, since: 0, monitored: false }
      }
      const w = this.watchers.get(key(station.id, path))
      return (
        w?.status() ?? {
          path,
          url,
          state: 'down',
          rate: null,
          realtime: null,
          since: 0,
          monitored: true,
        }
      )
    })
  }

  async stop() {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer)
    await Promise.all([...this.watchers.values()].map((w) => w.stop()))
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

export const manager = new WatcherManager()
