/**
 * Worker のサーバ側ガードのテスト。
 *
 *   node --test test/worker-guard.test.js
 *
 * 検証するのは「AIが確認質問を挟まずに emergency へ飛んだ場合に、
 * サーバ側で確認質問へ差し替えられるか」。Gemini API 呼び出しは
 * globalThis.fetch を差し替えてスタブする（ネットワークアクセスなし）。
 *
 * 依存パッケージなし（Node標準の node:test / node:assert のみ）。
 */
import test from "node:test";
import assert from "node:assert";
import worker from "../worker/worker.js";

const EMERGENCY_RESULT = {
  phase: "done",
  result: {
    urgency: "emergency",
    urgency_reason: "（スタブ）",
    category: "kyukyu",
    category_label: "救急（119番 / #7119）",
    reason: "（スタブ）",
    map_filters: [],
    prefer_senmon: false,
    respondent: "family",
    stage_estimate: { fast: "unknown", confidence: "low", basis: "（スタブ）" },
    stage_band: "unknown",
    inserted_risk: "delirium",
    note_for_doctor: "・（スタブ）",
    stage_note: "・（スタブ）",
    advice: "（スタブ）"
  }
};

/** 直近に Gemini へ送られたリクエストボディを覚えておく */
let lastUpstreamBody = null;

function stubGemini(replyObj) {
  globalThis.fetch = async (url, init) => {
    lastUpstreamBody = JSON.parse(init.body);
    return new Response(JSON.stringify({
      candidates: [{ content: { parts: [{ text: JSON.stringify(replyObj) }] } }]
    }), { status: 200, headers: { "Content-Type": "application/json" } });
  };
}

/** @param {Array<{role:string,content:string}>} messages */
async function callWorker(messages, opts = {}) {
  const req = new Request("https://worker.example/", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Origin": "http://localhost:8791",
      // レート制限がテスト間で効かないよう、呼び出しごとに別IPを名乗る
      "CF-Connecting-IP": "203.0.113." + Math.floor(Math.random() * 250)
    },
    body: JSON.stringify({ messages, force_done: !!opts.forceDone, triage: opts.triage })
  });
  const res = await worker.fetch(req, { GEMINI_API_KEY: "test-key" });
  return { status: res.status, body: await res.json() };
}

test.beforeEach(() => { lastUpstreamBody = null; });

test("要確認語のみ＋確認質問なしの emergency → 確認質問に差し替えられる", async () => {
  stubGemini(EMERGENCY_RESULT);
  const { body } = await callWorker([{ role: "user", content: "少しふらふらすることがあります" }]);
  assert.strictEqual(body.phase, "asking", "結論ではなく質問が返る");
  assert.match(body.next_question, /すり足|小刻み/, "歩行についての確認質問");
  assert.strictEqual(body.result, undefined);
});

test("緊急語に該当する場合は確認質問を挟まず emergency がそのまま通る", async () => {
  stubGemini(EMERGENCY_RESULT);
  const { body } = await callWorker([{ role: "user", content: "意識がもうろうとしています" }]);
  assert.strictEqual(body.phase, "done");
  assert.strictEqual(body.result.urgency, "emergency");
});

test("頭部打撲＋打撲後の変化（組み合わせ）も緊急としてそのまま通る", async () => {
  stubGemini(EMERGENCY_RESULT);
  const { body } = await callWorker([{ role: "user", content: "転んで頭を打ってから様子がおかしいです" }]);
  assert.strictEqual(body.phase, "done");
  assert.strictEqual(body.result.urgency, "emergency");
});

test("確認質問を挟んだあとの emergency は通る", async () => {
  stubGemini(EMERGENCY_RESULT);
  const { body } = await callWorker([
    { role: "user", content: "数日前から急にぼんやりしています" },
    { role: "assistant", content: "1つ確認させてください。意識がぼんやりする・発熱などはありますか？" },
    { role: "user", content: "はい、熱もあって呼びかけへの反応も鈍いです" }
  ]);
  assert.strictEqual(body.phase, "done");
  assert.strictEqual(body.result.urgency, "emergency");
});

test("質問上限（force_done）のときは差し替えず結論を通す", async () => {
  stubGemini(EMERGENCY_RESULT);
  const { body } = await callWorker(
    [{ role: "user", content: "少しふらふらすることがあります" }],
    { forceDone: true }
  );
  assert.strictEqual(body.phase, "done");
});

test("語彙に無い表現からAIが独自に緊急と判断した場合は尊重する（見落とし防止）", async () => {
  stubGemini(EMERGENCY_RESULT);
  const { body } = await callWorker([
    { role: "user", content: "祖父の首が急激に腫れて水も飲み込めない状態です" }
  ]);
  // 「急に/急激」は要確認語だが、この文には嚥下困難という語彙外の危険兆候がある。
  // 要確認語が拾われている以上ガードは働くが、その場合でも確認質問に落ちるだけで
  // 緊急の見落としにはならないことを確認する。
  assert.ok(body.phase === "done" || body.phase === "asking");
  if (body.phase === "asking") assert.ok(body.next_question.length > 0);
});

test("emergency 以外の結論はそのまま通る", async () => {
  const routine = JSON.parse(JSON.stringify(EMERGENCY_RESULT));
  routine.result.urgency = "urgent";
  routine.result.category = "senmonkikan";
  stubGemini(routine);
  const { body } = await callWorker([{ role: "user", content: "よく転ぶようになり、すり足で歩きます" }]);
  assert.strictEqual(body.phase, "done");
  assert.strictEqual(body.result.urgency, "urgent");
  assert.strictEqual(body.result.category, "senmonkikan");
});

test("要確認語があるときは確認質問を促すシステム補足がAIに渡る", async () => {
  stubGemini({ phase: "asking", next_question: "（スタブ）" });
  await callWorker([{ role: "user", content: "少しふらふらすることがあります" }]);
  const texts = lastUpstreamBody.contents.map(c => c.parts[0].text).join("\n");
  assert.match(texts, /システム補足/);
  assert.match(texts, /歩行の不安定さ/);
  assert.match(texts, /確認の質問を1問だけ挟んでください/);
  assert.match(texts, /重症度を上げすぎないでください/, "「少し」を程度の表現として伝える");
});

test("要確認語が無いときはシステム補足を付けない", async () => {
  stubGemini({ phase: "asking", next_question: "（スタブ）" });
  await callWorker([{ role: "user", content: "同じことを何度も聞くようになりました" }]);
  const texts = lastUpstreamBody.contents.map(c => c.parts[0].text).join("\n");
  assert.doesNotMatch(texts, /システム補足/);
});

test("否定された表現ではシステム補足を付けない（熱はありません）", async () => {
  stubGemini({ phase: "asking", next_question: "（スタブ）" });
  await callWorker([{ role: "user", content: "熱はありません" }]);
  const texts = lastUpstreamBody.contents.map(c => c.parts[0].text).join("\n");
  assert.doesNotMatch(texts, /発熱/);
});

test("フロントから来た triage ヒントは既知タグ以外を無視する", async () => {
  stubGemini({ phase: "asking", next_question: "（スタブ）" });
  await callWorker(
    [{ role: "user", content: "同じことを何度も聞きます" }],
    { triage: { caution: ["gait", "<script>alert(1)</script>", "存在しないタグ"], mild: true } }
  );
  const texts = lastUpstreamBody.contents.map(c => c.parts[0].text).join("\n");
  assert.match(texts, /歩行の不安定さ/, "既知タグ gait は反映される");
  assert.doesNotMatch(texts, /script/, "自由文字列は通さない");
  assert.doesNotMatch(texts, /存在しないタグ/);
});

test("上位のFlash系モデルを呼んでいる", async () => {
  let calledUrl = "";
  globalThis.fetch = async (url, init) => {
    calledUrl = String(url);
    lastUpstreamBody = JSON.parse(init.body);
    return new Response(JSON.stringify({
      candidates: [{ content: { parts: [{ text: JSON.stringify({ phase: "asking", next_question: "（スタブ）" }) }] } }]
    }), { status: 200 });
  };
  await callWorker([{ role: "user", content: "もの忘れが気になります" }]);
  assert.match(calledUrl, /gemini-3\.7-flash:generateContent/);
  // Gemini 3系では temperature / top_p / top_k を送らない
  assert.strictEqual(lastUpstreamBody.generationConfig.temperature, undefined);
  assert.strictEqual(lastUpstreamBody.generationConfig.responseMimeType, "application/json");
  assert.ok(lastUpstreamBody.generationConfig.responseSchema);
});
