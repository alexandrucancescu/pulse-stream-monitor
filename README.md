# Pulse Stream Monitor

A small standalone watchdog for internet radio streams. It connects to your
stream URLs the same way a listener would, from outside the broadcaster, and
watches the **audio actually flowing** — not just whether the URL returns 200.

It exists to answer one annoying question: _"the stream cut out — what happened,
and when?"_ It records the evidence so you can look **after** the fact, instead
of being paged at 6am for something you can't fix while half asleep.

## What it detects

For every stream path you add, per connection:

- **Down** — the connection dropped or refused.
- **Stalled** — connected, but no audio bytes are arriving.
- **Slow** — audio is arriving **below real time**, so listener buffers will
  drain and eventually cut out (the usual cause of "it just stopped").
- **Flowing** — healthy.

State changes are logged as **incidents** (with start, end, and duration), and a
low-frequency **heartbeat** records the live rate so you get a scannable timeline
and a rate sparkline per stream.

## What it is not

- Not an alerter — it doesn't page you. It's a record you consult.
- Not tied to any broadcaster — it watches plain public stream URLs, so it works
  against Pulse, Icecast, Shoutcast, or anything that serves an audio stream.

## Stack

- **Backend:** Node 22.5+ with the built-in `node:sqlite` (no native deps),
  Fastify. Stores stations, incidents, and heartbeats in one small SQLite file.
- **Frontend:** SolidJS — one dashboard to add streams and read their history.
- **Auth:** a single username/password from the environment.

## Run

```bash
npm install
MONITOR_USERNAME=admin MONITOR_PASSWORD=change-me npm run dev      # backend :4000
npm run dev:ui                                                    # UI :5173 (proxies /api)
```

Add a station (name + base URL + the paths to watch), and the dashboard shows
each stream's live status and its incident timeline.

## Environment

| Var | Default | Purpose |
| --- | --- | --- |
| `MONITOR_USERNAME` | `admin` | dashboard login |
| `MONITOR_PASSWORD` | `admin` (dev only, warns) | dashboard login |
| `MONITOR_SECRET` | derived from password | session cookie signing |
| `MONITOR_PORT` | `4000` | HTTP port |
| `MONITOR_DB` | `./data/monitor.db` | SQLite file |
| `MONITOR_RETENTION_DAYS` | `30` | how long history is kept |
| `MONITOR_HEARTBEAT_SECONDS` | `60` | timeline sample interval |
