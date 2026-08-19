import { config, watcher as tune } from './config'
import { heartbeats, incidents, stations as stationStore } from './db'
import type { State, Station, TargetStatus } from './types'

const isHls = (path: string) => /\.m3u8($|\?)|\/hls\b/i.test(path)
const key = (stationId: number, path: string) => `${stationId}::${path}`

/**
 * Watches ONE stream path: connects like a listener, tracks the byte rate,
 * and classifies flow as flowing / slow / stalled / down. Persists incidents
 * on state change; the manager samples state into heartbeats on a timer.
 */
class TargetWatcher {
  state: State = 'down'
  rate: number | null = null
  expected: number | null = null // baseline bytes/sec (icy-br or learned)
  private expectedLocked = false // true when the baseline came from icy-br
  since = Date.now()

  private stopped = false
  private connected = false
  private connectedAt = 0
  private lastByteAt = 0
  private failures = 0
  private controller: AbortController | null = null
  private log: { t: number; n: number }[] = []
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
      expected: this.expected,
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

        // Fresh baseline each connection (so a bitrate change in the source,
        // which drops + reconnects the stream, is re-learned cleanly).
        this.onConnected()

        // Authoritative nominal from ICY bitrate when the server sends it;
        // locked so VBR peaks can't drag the baseline up (which would make
        // the average look "slow").
        const icyBr = Number(res.headers.get('icy-br'))
        if (icyBr > 0) {
          this.expected = (icyBr * 1000) / 8
          this.expectedLocked = true
        }
        const reader = res.body.getReader()
        while (!this.stopped) {
          const { done, value } = await reader.read()
          if (done) break
          if (value) this.onBytes(value.length)
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
    this.log = []
    this.expected = null
    this.expectedLocked = false
  }

  private onDisconnected() {
    this.connected = false
  }

  private onBytes(n: number) {
    const now = Date.now()
    this.lastByteAt = now
    this.log.push({ t: now, n })
  }

  /** Current bytes/sec over the rolling window. */
  private currentRate(now: number): number {
    const windowMs = tune.windowSeconds * 1000
    const from = now - windowMs
    this.log = this.log.filter((e) => e.t >= from)
    const bytes = this.log.reduce((s, e) => s + e.n, 0)
    const spanMs = Math.min(now - this.connectedAt, windowMs)
    if (spanMs <= 0) return 0
    return bytes / (spanMs / 1000)
  }

  private evaluate() {
    if (this.stopped) return
    const now = Date.now()
    let next: State

    if (!this.connected) {
      next = 'down'
      this.rate = null
    } else {
      const rate = this.currentRate(now)
      this.rate = rate
      const inWarmup = now - this.connectedAt < tune.warmupSeconds * 1000

      if (now - this.lastByteAt > tune.stallSeconds * 1000) {
        next = 'stalled'
      } else if (inWarmup) {
        next = 'flowing'
      } else {
        // With no icy-br to lock onto, learn the baseline as the running max
        // of the (30s-averaged) rate. The wide window means VBR is already
        // smoothed, so the max ≈ the true bitrate rather than a peak.
        if (!this.expectedLocked && (!this.expected || rate > this.expected)) {
          this.expected = rate
        }
        next = this.expected && rate < this.expected * tune.slowRatio ? 'slow' : 'flowing'
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
    if (state === 'slow' && this.rate != null && this.expected) {
      return `${Math.round((this.rate / this.expected) * 100)}% of realtime`
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
        return { path, url, state: 'flowing', rate: null, expected: null, since: 0, monitored: false }
      }
      const w = this.watchers.get(key(station.id, path))
      return (
        w?.status() ?? {
          path,
          url,
          state: 'down',
          rate: null,
          expected: null,
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
