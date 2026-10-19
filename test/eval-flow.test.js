/**
 * 多段問診の評価（層3）の仕組みそのもののテスト（AIは呼ばない）。
 *   node --test test/eval-flow.test.js
 * - 質問文の話題分類が、プロンプトとモックの質問例を正しく振り分けるか
 * - 判定が、良い会話を合格・悪い会話を不合格にできるか
 */
import test from "node:test";
import assert from "node:assert";
import lib from "../eval_flow_lib.js";
import fs from "node:fs";

const scenarios = JSON.parse(fs.readFileSync(new URL("../評価シナリオ_v3_多段問診.json", import.meta.url), "utf8")).scenarios;
const S = (id) => scenarios.find(s => s.id === id);

test("質問文の話題分類", () => {
  const cases = [
    ["本日お答えいただいているのはご本人様でしょうか？それともご家族や身近な方でしょうか？", "respondent"],
    ["ありがとうございます。まず、いつ頃から気になり始められましたか？", "onset"],
    ["差し支えなければ、その方のおよそのご年齢を教えていただけますか？", "age"],
    ["差し支えなければ、どなたかと同居されていますか？", "living"],
    ["もの忘れについて教えてください。最近、同じことを何度も聞いたり、鍵や財布をよく探したりすることはありますか？", "memory"],
    ["毎日の家事や手続きについてはいかがでしょう。料理の品数や手順に変化はありますか？（例：レパートリーが減った、銀行からの書類を開けずに置いている など）", "task"],
    ["最近、ご様子の変化で困っていることはありますか？（例：大きな声を出す、手が出る、一人で外に出て行ってしまう など）", "behavior"],
    ["いま、どのような手助けがあるとよいと思われますか？（例：まず話を聞いてほしい／病院で詳しく調べたい／介護のことを知りたい／今はまだ様子を見たい）", "wish"],
    ["いまのご自身の状況について、どのようにしたいとお考えですか？（例：念のため調べておきたい／まず話を聞いてほしい／今はまだ様子を見たい）", "wish"],
    ["お洋服についてはいかがでしょう。季節に合った服を選べていますか？", "clothing"],
    ["少し立ち入ったことをお伺いしますが、入浴やトイレはお一人でできていますか？", "adl"],
    ["1つ確認させてください。ここ数日の変化とのことですが、意識がぼんやりする・発熱・手足の動かしにくさ・ろれつが回りにくい、といった様子はありますか？", "danger"],
    ["歩き方について1つ確認させてください。すり足や小刻みな歩き方、尿もれ（トイレが間に合わない）などはみられますか？", "danger"],
    ["その行動はどのくらいの頻度でありますか？", "freq"],
    ["例えばどのような場面でしたか？", "detail"],
  ];
  for (const [q, topic] of cases) assert.strictEqual(lib.classifyQuestion(q), topic, q);
});

test("1ターン1質問の数え方（括弧内の例示は数えない）", () => {
  assert.strictEqual(lib.countQuestionMarks("ご本人様でしょうか？ご家族でしょうか？"), 2);
  assert.strictEqual(lib.countQuestionMarks("料理の品数に変化はありますか？（例：減った？）"), 1);
});

const QUESTIONS = {
  onset: "いつ頃から気になり始められましたか？",
  age: "およそのご年齢を教えていただけますか？",
  living: "どなたかと同居されていますか？",
  memory: "最近、同じことを何度も聞くことはありますか？",
  task: "料理の品数や手順に変化はありますか？",
  behavior: "最近、ご様子の変化で困っていることはありますか？（例：大きな声を出す、手が出る など）",
  wish: "いま、どのような手助けがあるとよいと思われますか？",
  clothing: "季節に合った服を選べていますか？",
  freq: "その行動はどのくらいの頻度でありますか？",
};

function fakeAi(order, result) {
  let i = 0;
  return async (messages, forceDone) => {
    if (forceDone || i >= order.length) return { ok: true, json: { phase: "done", result } };
    return { ok: true, json: { phase: "asking", next_question: QUESTIONS[order[i++]] } };
  };
}
const goodResult = {
  urgency: "routine", urgency_reason: "急を要する変化は見られません。", category: "monowasure", category_label: "もの忘れ外来",
  reason: "もの忘れについて相談できる窓口です。", stage_band: "early", inserted_risk: "none",
  note_for_doctor: "・回答者: ご家族\n・受け止め方・希望: 病院で詳しく調べてほしいです。", advice: "下の地図から相談しやすい医療機関を探してみてください。",
};
const fails = (checks) => checks.filter(c => c.status === "fail").map(c => c.key);

test("良い会話（S02）はすべて合格", async () => {
  const sc = S("S02");
  const run = await lib.runScenario(sc, fakeAi(["onset", "age", "living", "memory", "task", "behavior", "wish"], goodResult));
  assert.deepStrictEqual(fails(lib.evaluateRun(sc, run)), []);
  assert.strictEqual(run.turns[3].answer, sc.answers.memory, "話題に合った答えを返す");
});

test("悪い会話は不合格を出す（服選びを聞く・作業→記憶の順・中等度・用語の漏れ）", async () => {
  const sc = S("S02");
  const bad = Object.assign({}, goodResult, { stage_band: "moderate", advice: "中等度の可能性があるため、すぐに受診してください。" });
  const run = await lib.runScenario(sc, fakeAi(["onset", "task", "memory", "clothing", "behavior", "wish"], bad));
  const f = fails(lib.evaluateRun(sc, run));
  for (const k of ["not_ask:clothing", "order:memory<task", "stage_band", "no_leak"]) assert.ok(f.includes(k), k);
});

test("本人には行動の変化を聞かない（S09）", async () => {
  const sc = S("S09");
  const run = await lib.runScenario(sc, fakeAi(["onset", "memory", "behavior", "wish"], goodResult));
  assert.ok(fails(lib.evaluateRun(sc, run)).includes("behavior_self"));
});

test("8問を超えて聞こうとしたら、強制整理で終える", async () => {
  const sc = S("S12");
  const many = ["onset", "age", "living", "memory", "task", "behavior", "wish", "onset", "age", "living"];
  const run = await lib.runScenario(sc, fakeAi(many, Object.assign({}, goodResult, { stage_band: "unknown", category: "kakaritsuke" })));
  assert.strictEqual(run.turns.length, 8);
  assert.ok(!run.error);
});

test("暴力のシナリオは「110」を次の一歩に含めることを確認する", async () => {
  const sc = S("S06");
  const r = Object.assign({}, goodResult, { urgency: "urgent", category: "senmonkikan", inserted_risk: "violence", advice: "安全を最優先に。身の危険があるときは110番か119番へ。" });
  const run = await lib.runScenario(sc, fakeAi(["freq", "onset", "wish"], r));
  assert.deepStrictEqual(fails(lib.evaluateRun(sc, run)), []);
});

test("シナリオの形式（必須項目とID重複）", () => {
  const ids = new Set();
  for (const s of scenarios) {
    assert.ok(s.id && s.first && s.respondent && s.expect, s.id);
    assert.ok(!ids.has(s.id), "重複: " + s.id); ids.add(s.id);
  }
  assert.strictEqual(scenarios.length, 14);
});

test("評価セットv3は、v2から T07/T13/T14/T16 の進行度の想定だけを変えている", () => {
  const read = (name) => fs.readFileSync(new URL("../" + name, import.meta.url), "utf8").replace(/^﻿/, "")
    .split(/\r?\n/).filter(Boolean).map(l => l.split(","));
  const v2 = read("トリアージ評価セット_v2_20件.csv"), v3 = read("トリアージ評価セット_v3_20件.csv");
  const hdr = v2[0], iAim = hdr.indexOf("ねらい・確認したい点");
  assert.deepStrictEqual(v3[0], hdr);
  assert.strictEqual(v3.length, v2.length);
  const changed = [];
  v2.slice(1).forEach((a, k) => {
    const b = v3[k + 1];
    a.forEach((cell, j) => {
      if (j === iAim) return; // 変更理由の追記だけを許す
      if (cell !== b[j]) changed.push(`${a[0]}:${hdr[j]}:${cell}→${b[j]}`);
    });
  });
  assert.deepStrictEqual(changed, ["T07", "T13", "T14", "T16"].map(id => `${id}:暫定_進行度:moderate→unknown`));
});

test("実際のAIの質問（2026-10-19 検証用Worker）を正しく分類する", () => {
  const cases = [
    // 前置きや質問文に「同じこと」「もの忘れ」が混ざっていても、時期を尋ねていれば「いつから」
    ["お母様のご様子についてのご相談ですね。同じことを何度も聞かれるようになったのは、いつ頃から気になり始められましたか？（例：数週間前、数か月前、1年以上前 など）", "onset"],
    ["お父様のことについてですね。そのもの忘れは、いつ頃から気になり始められましたか？", "onset"],
    ["お財布を探されたり同じお話が続くと、ご家族もご心配ですね。そうしたご様子は、およそいつ頃から気になり始められましたでしょうか？", "onset"],
    // 前置きの「料理」「支払い」に引きずられない
    ["お料理やお支払いは問題なく続けられているのですね。続いてお伺いしますが、最近、お母様のご様子の変化で困っていることはありますか？（例：大きな声を出す、手が出る、一人で外に出て行ってしまう など）", "behavior"],
    ["お母様のご様子で、最近困っておられることや気になる変化はございますか？（例：大きな声を出す、手が出る、一人で外に出て行ってしまう など）", "behavior"],
    ["そうしたご様子がないとお聞きして少し安心いたしました。いま、ご家族としてどのような手助けがあるとよいと思われますでしょうか？（例：病院で詳しく調べたい／介護サービスのことを知りたい／まず話を聞いてほしい など）", "wish"],
    ["半年ほど前からなのですね。教えていただきありがとうございます。最近、お母様がお料理をされる際の品数や手順などに、以前と変わった様子は見られますか？", "task"],
    ["少し立ち入ったことをお伺いしますが、季節や天候に合った服をご自身で選んで着ることはできていらっしゃいますか？", "clothing"],
  ];
  for (const [q, topic] of cases) assert.strictEqual(lib.classifyQuestion(q), topic, q);
});

test("待っても回復しないエラー（月の支出上限など）を見分ける", () => {
  assert.ok(lib.isFatalError("Your project has exceeded its monthly spending cap. Please go to AI Studio"));
  assert.ok(lib.isFatalError("本日の利用上限に達しました。明日以降にお試しください。"));
  assert.ok(!lib.isFatalError("This model is currently experiencing high demand."));
});

test("通信・APIのエラーで途切れた回は採点しない（AIの誤りとして数えない）", async () => {
  const sc = S("S05");
  const send = async (messages) => messages.length < 3
    ? { ok: true, json: { phase: "asking", next_question: "いつ頃から気になり始められましたか？" } }
    : { ok: false, fatal: true, error: "HTTP 502: Your project has exceeded its monthly spending cap." };
  const run = await lib.runScenario(sc, send);
  assert.ok(run.unmeasured && run.fatal);
  assert.deepStrictEqual(lib.evaluateRun(sc, run), []);
});

test("AIが結論を出せなかった回は、測定できた回として不合格にする", async () => {
  const sc = S("S01");
  const run = await lib.runScenario(sc, async () => ({ ok: true, json: { phase: "???" } }));
  assert.ok(!run.unmeasured);
  assert.ok(fails(lib.evaluateRun(sc, run)).includes("completed"));
});
