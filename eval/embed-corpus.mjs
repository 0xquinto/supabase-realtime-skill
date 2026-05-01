// eval/embed-corpus.mjs
//
// One-time script: reads all fixtures (ci-fast + ci-full +
// resolved-corpus) and computes embeddings keyed by fixture id.
// Writes JSON with metadata { provider, dim, embeddings: {...} }.
//
// Two providers, picked by env:
//   - OPENAI_API_KEY set → text-embedding-3-small (1536-dim).
//     Spec-compliant path (matches Supabase Automatic Embeddings shape
//     in the canonical migration). Cost: ~$0.0005 for the full corpus.
//   - OPENAI_API_KEY unset → Xenova/all-MiniLM-L6-v2 via Transformers.js
//     (384-dim, local). Zero external API deps. The runner detects this
//     dim and applies eval/migrations/eval-dim-override-384.sql.
//
// Run via Node (NOT bun — bun 1.2 has known onnxruntime-common
// resolution issues with @huggingface/transformers v4):
//
//   node eval/embed-corpus.mjs

import { readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

const FIXTURES = ["ci-fast", "ci-full"];
const RESOLVED_CORPUS = "fixtures/resolved-corpus.json";
const OUT = "fixtures/embeddings.json";

async function loadDir(tier) {
  const dir = join("fixtures", tier);
  const files = (await readdir(dir)).filter((f) => f.endsWith(".json")).sort();
  const items = [];
  for (const f of files) {
    items.push(JSON.parse(await readFile(join(dir, f), "utf-8")));
  }
  return items;
}

function textFor(item) {
  // The retrieval target shape matches Supabase Automatic Embeddings:
  // subject + body concatenated. See references/pgvector-composition.md.
  return `${item.ticket?.subject ?? item.subject ?? ""}\n${item.ticket?.body ?? item.body ?? ""}`;
}

async function makeOpenAIExtractor(apiKey) {
  // Direct fetch — keeps the script free of an OpenAI SDK dep.
  return async (text) => {
    const res = await fetch("https://api.openai.com/v1/embeddings", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ model: "text-embedding-3-small", input: text }),
    });
    if (!res.ok) {
      throw new Error(`OpenAI embeddings HTTP ${res.status}: ${await res.text()}`);
    }
    const json = await res.json();
    return json.data[0].embedding;
  };
}

async function makeTransformersExtractor() {
  const { pipeline } = await import("@huggingface/transformers");
  const ext = await pipeline("feature-extraction", "Xenova/all-MiniLM-L6-v2");
  return async (text) => {
    const r = await ext(text, { pooling: "mean", normalize: true });
    return Array.from(r.data);
  };
}

async function main() {
  const useOpenAI = !!process.env.OPENAI_API_KEY;
  const provider = useOpenAI ? "openai-text-embedding-3-small" : "transformers-all-MiniLM-L6-v2";
  const expectedDim = useOpenAI ? 1536 : 384;
  console.log(`[embed-corpus] provider=${provider} dim=${expectedDim}`);

  const extract = useOpenAI
    ? await makeOpenAIExtractor(process.env.OPENAI_API_KEY)
    : await makeTransformersExtractor();

  const embeddings = {};
  let total = 0;
  for (const tier of FIXTURES) {
    const items = await loadDir(tier);
    for (const item of items) {
      embeddings[item.id] = await extract(textFor(item));
      total++;
    }
    console.log(`[embed-corpus] ${tier}: ${items.length} embedded`);
  }

  const resolved = JSON.parse(await readFile(RESOLVED_CORPUS, "utf-8"));
  for (const item of resolved) {
    embeddings[item.id] = await extract(textFor(item));
    total++;
  }
  console.log(`[embed-corpus] resolved-corpus: ${resolved.length} embedded`);

  // Sanity-check dim. OpenAI sometimes truncates on rate limits — better
  // to fail loudly than ship inconsistent vectors.
  for (const [id, vec] of Object.entries(embeddings)) {
    if (vec.length !== expectedDim) {
      throw new Error(`embedding for ${id} has dim ${vec.length}, expected ${expectedDim}`);
    }
  }

  const out = { provider, dim: expectedDim, embeddings };
  await writeFile(OUT, JSON.stringify(out));
  console.log(`[embed-corpus] wrote ${total} embeddings (dim=${expectedDim}) → ${OUT}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
