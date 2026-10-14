# Proposal: server-side synthesis proxy

> **Status: proposal only** — deferred from the free-tts v1 grill (2026-10-14). Pick up when
> Microsoft starts refusing browser sockets (or earlier by choice). Grill before design/tasks.

## Problem

In the browser the Edge engine cannot set `Origin` or `User-Agent`. If Microsoft enforces them, the
browser path dies while the Node path (which sends both — verified on Node 22.22) keeps working.

## Proposed direction

- A small, framework-neutral request handler in free-tts (e.g. `free-tts/server`) that runs the Edge
  engine in Node and returns `audio/mpeg`, plus a browser **transport/engine adapter** that calls it.
- Consumers mount it: pavilio in its Express server, motyl.dev in a Next.js route.
- Cache and scheduler stay in the browser instance; the proxy is a stateless pipe.

## Open questions for the grill

- Latency: motyl's Vercel functions run in iad1 while readers are in Europe — per-unit round trips.
- Abuse protection for a public route (motyl.dev).
- Streaming chunks through vs whole-buffer responses.
