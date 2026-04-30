# References — Presence (deferred to v2)

Realtime Presence — the third primitive next to Postgres-Changes and Broadcast — is **not** in v1 of this skill. This page explains why, so a reader (or hiring panel) can see the call was deliberate.

## What Presence does

Presence tracks who is "in" a channel and pushes diffs when members join, leave, or update their state. The classic use case is a Google-Docs-style cursor-and-avatar overlay.

## Why it's not in v1

The semantics for *agents* are unsettled in a way the semantics for human users aren't. Specifically:

- **What does it mean for an agent to "be present"?** A human user joining a channel maps to "this person is on the page right now." An agent joining a channel could mean "this agent is the canonical worker for this workflow" *or* "this agent is currently mid-tool-call" *or* "this agent has subscribed and is buffering events." All three are different and all three matter for coordination.
- **Heartbeat shape doesn't fit bounded subscriptions.** Presence requires the client to keep the connection alive between events; otherwise the server marks them gone. The whole point of the bounded-subscription pattern is that the agent *doesn't* hold a connection between tool-calls.
- **No clean way to express "agent identity" in Presence's `key` parameter.** Human Presence usually uses `auth.uid()` — but multiple agent workflows might share an identity, and one workflow might span multiple agent instances.

These are real design questions, not implementation difficulty. Shipping a half-formed Presence story in v1 risks giving an agent a primitive that *looks* like coordination but doesn't compose with the rest of the skill's bounded model.

## What v2 might look like

Sketch only — not committed:

- A `presence_track(channel, key, state, lease_ms)` that holds presence for a bounded interval, similar to bounded subscription but on the join side.
- A `presence_list(channel)` that returns *current* members snapshot without subscribing.
- Both designed around lease semantics so the bounded model still holds.

If you have a use case for agent Presence that the v1 deferred design needs to know about, open an issue.

## What to use instead in v1

If you need to know "is workflow X currently running," coordinate via Broadcast: have the worker periodically broadcast a `heartbeat` event on a workflow channel and use `subscribe_to_channel` with `event_filter = "heartbeat"` and a tight timeout to check.
