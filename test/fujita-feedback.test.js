/**
 * 藤田先生の意見（2026-09-29）を受けた問診の変更が、Gemini へ送るシステムプロンプトと
 * 出力スキーマに入っているかを確かめるテスト（feature/fujita-feedback）。
 *
 *   node --test test/fujita-feedback.test.js
 *
 * AIの実際の振る舞いはこのテストでは確かめられない（評価セットの層2で確認する）。
 * Gemini API 呼び出しは globalThis.fetch を差し替えてスタブする（ネットワークアクセスなし）。
 */
import test from "node:test";
import assert from "node:assert";
import worker from "../worker/worker.js";

const ASKING = { phase: "asking", next_question: "（スタブ）" };

async function upstreamBodyFor(messages) {
  let body = null;
  globalThis.fetch = async (url, init) => {
    body = JSON.parse(init.body);
    return new Response(JSON.stringify({
      candidates: [{ content: { parts: [{ text: JSON.stringify(ASKING) }] } }]
    }), { status: 200, headers: { "Content-Type": "application/json" } });
  };
  const req = new Request("https://worker.example/", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Origin": "http://localhost:8791",
      "CF-Connecting-IP": "198.51.100." + Math.floor(Math.random() * 250)
    },
    body: JSON.stringify({ messages })
  });
  await worker.fetch(req, { GEMINI_API_KEY: "test-key" });
  return body;
}

async function systemPrompt() {
  const body = await upstreamBodyFor([{ role: "user", content: "母のもの忘れが気になります" }]);
  return body.systemInstruction.parts[0].text;
}

test("段階問診: 第2段階＝記憶、第3段階＝作業に分かれている", async () => {
  const p = await systemPrompt();
  assert.match(p, /第2段階「記憶」/);
  assert.match(p, /第3段階「作業」/);
  assert.match(p, /書類/, "作業の例に書類・手続きが入っている");
});

test("段階問診: 着衣・入浴などは「必要なときだけ」で、通常の段階に入っていない", async () => {
  const p = await systemPrompt();
  assert.match(p, /必要なときだけ確認する項目: 着衣/);
  assert.doesNotMatch(p, /第3段階: 季節に合った服選び/);
  assert.doesNotMatch(p, /第4段階/);
});

test("confidence: 着衣・入浴等を確認していないときは FAST 5 以上と推定しない", async () => {
  const p = await systemPrompt();
  assert.match(p, /FAST 5 以上と推定しない/);
});

test("受け止め方・希望を1問尋ね、メモに残す", async () => {
  const p = await systemPrompt();
  assert.match(p, /受け止め方と希望の確認/);
  assert.match(p, /・受け止め方・希望/);
  assert.match(p, /「様子見でよい」とは言わない/);
});

test("家族経路で行動の変化を1問尋ねる", async () => {
  const p = await systemPrompt();
  assert.match(p, /行動の変化の確認（家族経路のみ・1問）/);
});

test("暴力: urgent・violence とし、救急にはしない。110・119を案内する", async () => {
  const body = await upstreamBodyFor([{ role: "user", content: "父が最近手を上げるようになりました" }]);
  const p = body.systemInstruction.parts[0].text;
  assert.match(p, /inserted_risk:"violence"/);
  assert.match(p, /110番（警察）/);
  const risk = body.generationConfig.responseSchema.properties.result.properties.inserted_risk;
  assert.ok(risk.enum.includes("violence"), "responseSchema に violence がある");
});

test("救急以外の差し込み（暴力・歩行の変化など）でも、結論の前に受け止め方・希望を尋ねる", async () => {
  const p = await systemPrompt();
  assert.match(p, /救急案内（emergency）にしない結論（②行動・心理症状、③歩行の変化、⑤身体的な暴力 など）に進むときは/);
  assert.match(p, /差し込み質問（危険兆候の常時監視）で救急案内以外の結論に進む場合も/);
  // いま身の危険が迫っている暴力では、希望を尋ねずにすぐ結論する
  assert.match(p, /いま身の危険が迫っている/);
  // 以前の「確認せずに結論を出してよい」（希望の質問を飛ばす根拠になっていた）は残っていない
  assert.doesNotMatch(p, /既に十分な情報がある場合は確認せずに結論を出してよい/);
});
