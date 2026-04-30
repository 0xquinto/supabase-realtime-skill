// eval/synthesize-fixtures.ts
//
// Seeds n=100 fixtures by augmenting the ci-fast 20 hand-labels with LLM-
// generated variations. Each variation is then SPOT-CHECKED by hand
// (open the JSON, eyeball the labels). Per playbook lesson: never
// synthetic-only; always hand-seeded.
//
// One-off script: regenerates ALL variations on every run. Idempotence
// not needed — fresh LLM output is fine for one-shot seed generation.

import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import Anthropic from "@anthropic-ai/sdk";

const VARIATIONS_PER_SEED = 4; // 20 seeds × (1 seed + 4 variations) = 100 total

async function main() {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.error("ANTHROPIC_API_KEY is required");
    process.exit(2);
  }
  const anthropic = new Anthropic({ apiKey });

  await mkdir("fixtures/ci-nightly", { recursive: true });
  const seedFiles = (await readdir("fixtures/ci-fast")).filter((f) => f.endsWith(".json")).sort();

  let counter = 1;
  let skipCount = 0;
  for (const seedFile of seedFiles) {
    const seed = JSON.parse(await readFile(join("fixtures/ci-fast", seedFile), "utf-8"));
    // Copy the seed first
    await writeFile(
      join("fixtures/ci-nightly", `n${String(counter).padStart(3, "0")}-${seed.id}.json`),
      `${JSON.stringify(seed, null, 2)}\n`,
    );
    counter++;

    // Generate variations
    for (let v = 1; v <= VARIATIONS_PER_SEED; v++) {
      const message = await anthropic.messages.create({
        model: "claude-haiku-4-5",
        max_tokens: 400,
        messages: [
          {
            role: "user",
            content: `Generate a variation of this support ticket. Same expected routing (${seed.expected_routing}), different specific facts. Return ONLY JSON: { "subject": "...", "body": "..." }.

Original:
Subject: ${seed.ticket.subject}
Body: ${seed.ticket.body}`,
          },
        ],
      });
      const block = message.content[0];
      const raw = block?.type === "text" ? block.text : "";
      const match = raw.match(/\{[\s\S]*\}/);
      if (!match) {
        console.warn(`[v=${v} seed=${seed.id}] LLM returned no JSON; skipping`);
        skipCount++;
        continue;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(match[0]);
      } catch {
        console.warn(`[v=${v} seed=${seed.id}] LLM JSON parse failed; skipping`);
        skipCount++;
        continue;
      }
      if (
        typeof parsed !== "object" ||
        parsed === null ||
        typeof (parsed as { subject?: unknown }).subject !== "string" ||
        typeof (parsed as { body?: unknown }).body !== "string"
      ) {
        console.warn(`[v=${v} seed=${seed.id}] LLM returned unexpected JSON shape; skipping`);
        skipCount++;
        continue;
      }
      const ticket = {
        subject: (parsed as { subject: string }).subject,
        body: (parsed as { body: string }).body,
      };
      const variation = {
        id: `${seed.id}-v${v}`,
        ticket,
        expected_routing: seed.expected_routing,
      };
      await writeFile(
        join("fixtures/ci-nightly", `n${String(counter).padStart(3, "0")}-${variation.id}.json`),
        `${JSON.stringify(variation, null, 2)}\n`,
      );
      counter++;
    }
  }
  console.log(`generated ${counter - 1} fixtures (${skipCount} skipped)`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
