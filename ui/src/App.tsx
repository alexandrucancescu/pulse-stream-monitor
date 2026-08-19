import { createResource, createSignal, For, onCleanup, Show, type Component } from 'solid-js'
import {
  api,
  fmtDuration,
  fmtRate,
  type Heartbeat,
  type Incident,
  type State,
  type Station,
  type Target,
} from './api'

const STATE_LABEL: Record<State, string> = {
  flowing: 'Flowing',
  slow: 'Slow',
  stalled: 'Stalled',
  down: 'Down',
}

const App: Component = () => {
  const [me, { refetch: refetchMe }] = createResource(api.me)

  return (
    <Show when={me.state === 'ready'} fallback={<div class="center muted">Loading…</div>}>
      <Show when={me()} fallback={<Login onDone={refetchMe} />}>
        <Dashboard username={me()!.username} onLogout={refetchMe} />
      </Show>
    </Show>
  )
}

const Login: Component<{ onDone: () => void }> = (props) => {
  const [u, setU] = createSignal('')
  const [p, setP] = createSignal('')
  const [err, setErr] = createSignal<string | null>(null)
  const [busy, setBusy] = createSignal(false)

  async function submit(e: Event) {
    e.preventDefault()
    setBusy(true)
    setErr(null)
    try {
      await api.login(u(), p())
      props.onDone()
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Login failed')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div class="center">
      <form class="card login" onSubmit={submit}>
        <div class="brand">
          <span class="dot flowing" /> Pulse Stream Monitor
        </div>
        <Show when={err()}>
          <div class="error">{err()}</div>
        </Show>
        <input placeholder="Username" value={u()} onInput={(e) => setU(e.currentTarget.value)} autofocus />
        <input placeholder="Password" type="password" value={p()} onInput={(e) => setP(e.currentTarget.value)} />
        <button class="primary" disabled={busy() || !u() || !p()}>
          {busy() ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
    </div>
  )
}

const Dashboard: Component<{ username: string; onLogout: () => void }> = (props) => {
  const [stations, { refetch }] = createResource(api.stations)
  const timer = setInterval(refetch, 3000)
  onCleanup(() => clearInterval(timer))

  async function logout() {
    await api.logout()
    props.onLogout()
  }

  return (
    <div class="page">
      <header class="topbar">
        <div class="brand">
          <span class="dot flowing" /> Pulse Stream Monitor
        </div>
        <div class="row">
          <span class="muted small">{props.username}</span>
          <button class="ghost small" onClick={logout}>
            Sign out
          </button>
        </div>
      </header>

      <main class="stack">
        <AddStation onAdded={refetch} />
        <Show
          when={(stations() ?? []).length > 0}
          fallback={<div class="muted center-pad">No streams yet — add one above.</div>}
        >
          <For each={stations()}>{(s) => <StationCard station={s} onChanged={refetch} />}</For>
        </Show>
      </main>
    </div>
  )
}

const AddStation: Component<{ onAdded: () => void }> = (props) => {
  const [open, setOpen] = createSignal(false)
  const [name, setName] = createSignal('')
  const [url, setUrl] = createSignal('')
  const [paths, setPaths] = createSignal('')
  const [err, setErr] = createSignal<string | null>(null)

  async function submit(e: Event) {
    e.preventDefault()
    setErr(null)
    try {
      await api.createStation({
        name: name().trim(),
        url: url().trim(),
        paths: paths().split(/[\s,]+/).map((p) => p.trim()).filter(Boolean),
      })
      setName('')
      setUrl('')
      setPaths('')
      setOpen(false)
      props.onAdded()
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Failed to add')
    }
  }

  return (
    <Show
      when={open()}
      fallback={
        <button class="primary" onClick={() => setOpen(true)}>
          + Add stream
        </button>
      }
    >
      <form class="card add" onSubmit={submit}>
        <Show when={err()}>
          <div class="error">{err()}</div>
        </Show>
        <input placeholder="Name (e.g. Super FM)" value={name()} onInput={(e) => setName(e.currentTarget.value)} autofocus />
        <input placeholder="Base URL (https://live.superfm.ro)" value={url()} onInput={(e) => setUrl(e.currentTarget.value)} />
        <input placeholder="Paths (/stream /stream.aac …)" value={paths()} onInput={(e) => setPaths(e.currentTarget.value)} />
        <div class="row">
          <button class="primary">Add</button>
          <button type="button" class="ghost" onClick={() => setOpen(false)}>
            Cancel
          </button>
        </div>
      </form>
    </Show>
  )
}

const StationCard: Component<{ station: Station; onChanged: () => void }> = (props) => {
  const [expanded, setExpanded] = createSignal(false)

  async function remove() {
    if (!confirm(`Remove ${props.station.name}?`)) return
    await api.deleteStation(props.station.id)
    props.onChanged()
  }

  const worst = () => {
    const order: State[] = ['down', 'stalled', 'slow', 'flowing']
    return props.station.targets.reduce<State>(
      (w, t) => (order.indexOf(t.state) < order.indexOf(w) ? t.state : w),
      'flowing',
    )
  }

  return (
    <div class="card station">
      <div class="station-head" onClick={() => setExpanded(!expanded())}>
        <span class={`dot ${worst()}`} />
        <div class="grow">
          <div class="station-name">{props.station.name}</div>
          <div class="muted small mono">{props.station.url}</div>
        </div>
        <button class="ghost small" onClick={(e) => (e.stopPropagation(), remove())}>
          Remove
        </button>
      </div>

      <div class="targets">
        <For each={props.station.targets}>
          {(t) => (
            <div class="target">
              <Show when={t.monitored} fallback={<span class="pill muted-pill">HLS · off</span>}>
                <span class={`pill ${t.state}`}>{STATE_LABEL[t.state]}</span>
              </Show>
              <span class="mono grow">{t.path}</span>
              <Show
                when={t.monitored}
                fallback={<span class="muted small">not monitored</span>}
              >
                <span class="muted small mono">
                  {fmtRate(t.rate)}
                  <Show when={t.expected}> / {fmtRate(t.expected)}</Show>
                </span>
              </Show>
            </div>
          )}
        </For>
      </div>

      <Show when={expanded()}>
        <StationHistory id={props.station.id} targets={props.station.targets} />
      </Show>
    </div>
  )
}

const StationHistory: Component<{ id: number; targets: Target[] }> = (props) => {
  const [history] = createResource(() => props.id, (id) => api.history(id, 24))
  const since = Date.now() - 24 * 3_600_000
  const now = Date.now()

  const beatsByPath = () => {
    const m = new Map<string, Heartbeat[]>()
    for (const b of history()?.heartbeats ?? []) {
      const arr = m.get(b.path) ?? []
      arr.push(b)
      m.set(b.path, arr)
    }
    return m
  }

  return (
    <div class="history">
      <Show when={history()} fallback={<div class="muted small">Loading history…</div>}>
        <div class="muted small section-label">Flow · last 24h</div>
        <For each={props.targets.filter((t) => t.monitored)}>
          {(t) => (
            <div class="strip-row">
              <span class="mono small strip-path">{t.path}</span>
              <Strip beats={beatsByPath().get(t.path) ?? []} since={since} now={now} />
            </div>
          )}
        </For>
        <div class="strip-axis muted small mono">
          <span>24h ago</span>
          <span>now</span>
        </div>

        <div class="muted small section-label">Incidents · last 24h</div>
        <Show
          when={(history()!.incidents ?? []).length > 0}
          fallback={<div class="muted small">No incidents — steady.</div>}
        >
          <For each={history()!.incidents}>{(inc) => <IncidentRow inc={inc} />}</For>
        </Show>
      </Show>
    </div>
  )
}

const STRIP_ORDER: State[] = ['down', 'stalled', 'slow', 'flowing']

const Strip: Component<{ beats: Heartbeat[]; since: number; now: number }> = (props) => {
  const COLS = 120
  const cols = () => {
    const colMs = (props.now - props.since) / COLS
    const out: (State | 'gap')[] = Array.from({ length: COLS }, () => 'gap')
    for (const b of props.beats) {
      const i = Math.floor((b.ts - props.since) / colMs)
      if (i < 0 || i >= COLS) continue
      const cur = out[i]
      if (cur === 'gap' || STRIP_ORDER.indexOf(b.state) < STRIP_ORDER.indexOf(cur)) {
        out[i] = b.state
      }
    }
    return out
  }
  return (
    <div class="strip">
      <For each={cols()}>
        {(c) => <div class={`seg ${c}`} title={c === 'gap' ? 'no data' : c} />}
      </For>
    </div>
  )
}

const IncidentRow: Component<{ inc: Incident }> = (props) => {
  const end = () => props.inc.endedAt ?? Date.now()
  const dur = () => fmtDuration(end() - props.inc.startedAt)
  const when = () => new Date(props.inc.startedAt).toLocaleString()
  return (
    <div class="incident">
      <span class={`pill ${props.inc.type}`}>{STATE_LABEL[props.inc.type]}</span>
      <span class="mono grow">{props.inc.path}</span>
      <span class="muted small">{props.inc.detail}</span>
      <span class="muted small mono">{dur()}</span>
      <span class="muted small">
        {when()}
        <Show when={!props.inc.endedAt}> · ongoing</Show>
      </span>
    </div>
  )
}

export default App
