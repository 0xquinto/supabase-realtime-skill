// eval/embed-corpus.mjs
//
// One-time script: reads all fixtures (ci-fast + ci-nightly +
// resolved-corpus) and computes 384-dim embeddings via the local
// all-MiniLM-L6-v2 model (Transformers.js / sentence-transformers).
// Writes one JSON keyed by fixture/corpus id → number[384].
//
// Run via Node (NOT bun — bun 1.2 has known onnxruntime-common
// resolution issues with @huggingface/transformers v4):
//
//   node eval/embed-corpus.mjs
//
// Idempotent: re-running overwrites the cache. Cheap (~10s on first
// run after model download, ~3s subsequently). Zero external API
// dependencies; the model runs locally.

import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pipeline } from "@huggingface/transformers";

const FIXTURES = ["ci-fast", "ci-nightly"];
const RESOLVED_CORPUS = "fixtures/resolved-corpus.json";
const OUT = "fixtures/embeddings.json";

async function loadDir(tier) {
  const dir = join("fixtures", tier);
  const files = (await readdir(dir)).filter((f) => f.endsWith(".json")).sort();
  const items = [];
  for (const f of files) {
    const raw = JSON.parse(await readFile(join(dir, f), "utf-8"));
    items.push(raw);
  }
  return items;
}

function textFor(item) {
  // The retrieval target is the same shape used by Supabase Automatic
  // Embeddings on the schema in the migration: subject + body
  // concatenated. This matches the `references/pgvector-composition.md`
  // pattern.
  return `${item.ticket?.subject ?? item.subject ?? ""}\n${item.ticket?.body ?? item.body ?? ""}`;
}

async function main() {
  console.log("[embed-corpus] loading model…");
  const extractor = await pipeline("feature-extraction", "Xenova/all-MiniLM-L6-v2");

  const out = {};
  let total = 0;
  for (const tier of FIXTURES) {
    const items = await loadDir(tier);
    for (const item of items) {
      const text = textFor(item);
      const r = await extractor(text, { pooling: "mean", normalize: true });
      out[item.id] = Array.from(r.data);
      total++;
    }
    console.log(`[embed-corpus] ${tier}: ${items.length} embedded`);
  }

  const resolved = JSON.parse(await readFile(RESOLVED_CORPUS, "utf-8"));
  for (const item of resolved) {
    const text = textFor(item);
    const r = await extractor(text, { pooling: "mean", normalize: true });
    out[item.id] = Array.from(r.data);
    total++;
  }
  console.log(`[embed-corpus] resolved-corpus: ${resolved.length} embedded`);

  await mkdir("fixtures", { recursive: true });
  await writeFile(OUT, JSON.stringify(out));
  console.log(`[embed-corpus] wrote ${total} embeddings → ${OUT}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
