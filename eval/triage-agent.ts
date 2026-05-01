// eval/triage-agent.ts
//
// The worked-example agent: watches support_tickets for INSERT, retrieves
// 5 most-similar past resolved tickets, decides routing via LLM, writes
// routing back. Returns per-trial telemetry the eval/runner.ts uses to
// compute metrics.
//
// Library-style code — exported for eval/runner.ts (T24). No CLI entry
// point here.

import Anthropic from "@anthropic-ai/sdk";
import postgres from "postgres";
import { boundedWatch, makeSupabaseAdapter } from "../src/server/realtime-client.ts";

export interface TriageInput {
  fixture: {
    id: string;
    ticket: { subject: string; body: string };
    expected_routing: string;
    embedding: number[];
  };
  supabaseUrl: string;
  supabaseKey: string;
  databaseUrl: string;
}

export interface TriageResult {
  fixture_id: string;
  observed: boolean;
  latency_ms: number | null;
  agent_action_taken: boolean;
  routing_chosen: string | null;
  expected_routing: string;
  correct: boolean;
}

// Module-scope construction would throw at import time if ANTHROPIC_API_KEY
// is unset (the SDK validates the key in its constructor). Defer until
// triageOne actually runs, so unrelated typecheck/lint paths that import
// this file don't blow up.
function getAnthropic(): Anthropic {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error("ANTHROPIC_API_KEY is required for triageOne");
  return new Anthropic({ apiKey: key });
}

const VALID_ROUTINGS = new Set(["urgent", "engineering", "billing", "general"]);

export async function triageOne(input: TriageInput): Promise<TriageResult> {
  const anthropic = getAnthropic();
  const sql = postgres(input.databaseUrl, { max: 1, prepare: false });
  const adapter = makeSupabaseAdapter("support_tickets", {
    supabaseUrl: input.supabaseUrl,
    supabaseKey: input.supabaseKey,
  });

  try {
    // Arm the watch first; the INSERT is fired ~100ms later so the
    // SUBSCRIBED handshake has completed before the row commits.
    const watchPromise = boundedWatch({
      adapter,
      table: "support_tickets",
      predicate: { event: "INSERT" },
      timeout_ms: 30_000,
      max_events: 1,
    });

    const insertedAt = Date.now();
    // halfvec literal accepted by pgvector via `[a,b,c]` text form.
    const embeddingLiteral = `[${input.fixture.embedding.join(",")}]`;
    setTimeout(() => {
      sql`
        insert into support_tickets (customer_id, subject, body, embedding)
        values (gen_random_uuid(), ${input.fixture.ticket.subject}, ${input.fixture.ticket.body}, ${embeddingLiteral})
      `.catch(() => {
        // Insert errors surface as a watch timeout below. Swallowing here
        // keeps the unhandled-rejection noise out of the runner's logs.
      });
    }, 100);

    const result = await watchPromise;
    if (result.closed_reason === "timeout" || result.events.length === 0) {
      return {
        fixture_id: input.fixture.id,
        observed: false,
        latency_ms: null,
        agent_action_taken: false,
        routing_chosen: null,
        expected_routing: input.fixture.expected_routing,
        correct: false,
      };
    }

    // Guard against the rare race where the event arrives but `new` is
    // empty (e.g. a malformed payload from upstream). Two non-null
    // assertions on indexed access would mask this as a runtime crash
    // mid-trial; instead we emit the same telemetry shape as a timeout.
    const event = result.events[0];
    if (!event || !event.new) {
      return {
        fixture_id: input.fixture.id,
        observed: false,
        latency_ms: null,
        agent_action_taken: false,
        routing_chosen: null,
        expected_routing: input.fixture.expected_routing,
        correct: false,
      };
    }
    const ticket = event.new;
    const latency_ms = Date.now() - insertedAt;

    if (typeof ticket.id !== "string") {
      throw new Error("ticket.id missing from event payload");
    }
    const ticketId = ticket.id;

    // Retrieve 5 most-similar past resolved tickets via pgvector cosine
    // similarity. The embedding column is halfvec(384) populated either
    // synchronously (here, with the pre-computed embedding from
    // fixtures/embeddings.json) or asynchronously in production via
    // Supabase Automatic Embeddings — same retrieval pattern either way.
    const similar = await sql<{ subject: string; routing: string }[]>`
      select subject, routing from support_tickets
      where status = 'resolved' and routing is not null and id != ${ticketId}
      order by embedding <=> ${embeddingLiteral}
      limit 5
    `;

    // LLM routing decision. haiku-4-5 is the canonical cost-sensitive
    // model in supabase-mcp-evals/CLAUDE.md. Override via EVAL_TRIAGE_MODEL
    // env (e.g., `claude-sonnet-4-6`) for the multi-model probe — see
    // ADR-0006's v0.2 follow-ups + task [I] in docs/ship-status.md.
    const triageModel = process.env.EVAL_TRIAGE_MODEL ?? "claude-haiku-4-5";
    const message = await anthropic.messages.create({
      model: triageModel,
      max_tokens: 100,
      messages: [
        {
          role: "user",
          content: `Route this support ticket to one of: urgent, engineering, billing, general.

Past resolved examples:
${similar.map((s) => `- "${s.subject}" → ${s.routing}`).join("\n") || "(none)"}

New ticket:
Subject: ${ticket.subject}
Body: ${ticket.body}

Reply with ONLY one word: urgent, engineering, billing, or general.`,
        },
      ],
    });

    // Type-narrow via the discriminated union — `text` only exists on
    // text blocks, and biome's noExplicitAny rejects the cast in the
    // plan literal.
    const block = message.content[0];
    const text = block?.type === "text" ? block.text : "";
    const routing = text.trim().toLowerCase().split(/\s+/)[0] ?? "general";
    const finalRouting = VALID_ROUTINGS.has(routing) ? routing : "general";

    await sql`update support_tickets set routing = ${finalRouting} where id = ${ticketId}`;

    return {
      fixture_id: input.fixture.id,
      observed: true,
      latency_ms,
      agent_action_taken: true,
      routing_chosen: finalRouting,
      expected_routing: input.fixture.expected_routing,
      correct: finalRouting === input.fixture.expected_routing,
    };
  } finally {
    await sql.end();
  }
}
