/**
 * レート上限の環境変数（RATE_LIMIT_PER_DAY）のテスト。
 *   node --test test/rate-limit.test.js
 * Gemini API 呼び出しは globalThis.fetch を差し替えてスタブする（ネットワークアクセスなし）。
 */
import test from "node:test";
import assert from "node:assert";
import worker from "../worker/worker.js";

function stub() {
  globalThis.fetch = async () => new Response(JSON.stringify({
    candidates: [{ content: { parts: [{ text: JSON.stringify({ phase: "asking", next_question: "（スタブ）" }) }] } }]
  }), { status: 200, headers: { "Content-Type": "application/json" } });
}

async function call(ip, env) {
  const req = new Request("https://worker.example/", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Origin": "http://localhost:8791", "CF-Connecting-IP": ip },
    body: JSON.stringify({ messages: [{ role: "user", content: "母のもの忘れが気になります" }] })
  });
  const res = await worker.fetch(req, env);
  return res.status;
}

test("RATE_LIMIT_PER_DAY を設定すると、その回数で429になる", async () => {
  stub();
  const env = { GEMINI_API_KEY: "test-key", RATE_LIMIT_PER_DAY: "2" };
  const ip = "192.0.2.201";
  assert.strictEqual(await call(ip, env), 200);
  assert.strictEqual(await call(ip, env), 200);
  assert.strictEqual(await call(ip, env), 429);
});

test("RATE_LIMIT_PER_DAY が未設定なら既定の上限（50）", async () => {
  stub();
  const env = { GEMINI_API_KEY: "test-key" };
  const ip = "192.0.2.202";
  for (let i = 0; i < 50; i++) assert.strictEqual(await call(ip, env), 200);
  assert.strictEqual(await call(ip, env), 429);
});
