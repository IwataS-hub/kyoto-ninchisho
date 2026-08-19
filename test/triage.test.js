/**
 * triage.js（危険兆候の語彙判定）のテスト。
 *
 *   node --test test/
 *
 * 重症度判定が「実際の状態」と乖離しないことを、語彙レベルで固定する。
 * 依存パッケージなし（Node標準の node:test / node:assert のみ）。
 */
"use strict";

const test = require("node:test");
const assert = require("node:assert");
const triage = require("../triage.js");

function tags(text) {
  const r = triage.classify(text);
  return { emg: r.emergencyTags, cau: r.cautionTags, mild: r.mild, sup: r.suppressed };
}

/* ===== 課題で指定された検証ケース ===== */

test("「少しふらふらすることがあります」→ 緊急語ではなく要確認語（歩行）", () => {
  const r = tags("少しふらふらすることがあります");
  assert.deepStrictEqual(r.emg, [], "救急バナーは出さない");
  assert.ok(r.cau.includes("gait"), "歩行の要確認語として拾う");
  assert.strictEqual(r.mild, true, "「少し」を程度の表現として拾う");
});

test("「意識がもうろうとしています」→ 緊急語", () => {
  const r = tags("意識がもうろうとしています");
  assert.ok(r.emg.includes("drowsy"), "意識障害として即座に緊急");
});

test("「よく転ぶようになり、すり足で歩きます」→ 緊急ではなく要確認語（転倒・歩行）", () => {
  const r = tags("よく転ぶようになり、すり足で歩きます");
  assert.deepStrictEqual(r.emg, [], "救急バナーは出さない");
  assert.ok(r.cau.includes("fall"));
  assert.ok(r.cau.includes("gait"));
});

test("「転んで頭を打ってから様子がおかしい」→ 組み合わせで緊急", () => {
  const r = tags("転んで頭を打ってから様子がおかしい");
  assert.ok(r.emg.includes("head-impact-change"), "頭部打撲＋打撲後の変化で緊急に格上げ");
});

test("「熱はありません」→ 発熱として検知しない（否定処理）", () => {
  const r = tags("熱はありません");
  assert.ok(!r.cau.includes("fever"), "否定された発熱は拾わない");
  assert.ok(r.sup.some(s => s.id === "fever" && s.reason === "negation"), "否定として抑制される");
});

test("「以前倒れたことがありますが、1年前の話です」→ 現在の緊急として扱わない", () => {
  const r = tags("以前倒れたことがありますが、1年前の話です");
  assert.deepStrictEqual(r.emg, []);
  assert.ok(!r.cau.includes("fall"), "過去の出来事は現在の転倒として拾わない");
  assert.ok(r.sup.some(s => s.id === "fall" && s.reason === "past"));
});

/* ===== 緊急語（従来どおり即バナー） ===== */

test("明確な緊急語はそのまま緊急", () => {
  assert.ok(triage.hasEmergency("意識がありません"));
  assert.ok(triage.hasEmergency("呼びかけに応じない状態です"));
  assert.ok(triage.hasEmergency("けいれんしています"));
  assert.ok(triage.hasEmergency("反応がありません"));
  assert.ok(triage.hasEmergency("急に手足が動かなくなりました"));
  assert.ok(triage.hasEmergency("ろれつが回らないです"));
  assert.ok(triage.hasEmergency("息をしていません"));
});

test("否定形で意味が成立する緊急語は否定処理で打ち消されない", () => {
  // 「意識がない」「意識がなくなった」は否定表現を含むが、それ自体が緊急
  assert.ok(triage.hasEmergency("意識がない状態です"), "意識がない");
  assert.ok(triage.hasEmergency("意識がなくなったようです"), "意識がなくなった");
  assert.ok(triage.hasEmergency("呼んでも反応がありません"), "反応がありません");
});

/* ===== 活用形の網羅 =====
   層1の評価で「ろれつが回りません」「手足が動かしにくく」が緊急語として
   検出されず、真の緊急を2件見落とした。原因はテストをプレーン形（〜ない）でしか
   書いていなかったこと。丁寧形（〜ません）・難易形（〜にくい/〜づらい）・
   テ形の否定（〜ていません）を必ず含める。 */

test("活用形の網羅: ろれつが回らない", () => {
  ["ろれつが回らないです", "ろれつが回りません", "ろれつが回っていません",
   "ろれつが回ってない", "ろれつが回りにくいです", "ろれつが回りづらそうです",
   "ろれつが回らなくなりました", "呂律がまわりません", "呂律が回らず心配です"].forEach(text => {
    assert.ok(triage.hasEmergency(text), `緊急として検出されるべき: ${text}`);
  });
});

test("活用形の網羅: 手足が動かない", () => {
  ["手足が動かないです", "手足が動きません", "手足が動かしにくいそうです",
   "手足が動かしづらいと言います", "片方の手足が動かしにくく困っています",
   "手足が動かせません", "手が動かなくなりました", "腕が上がりません",
   "足に力が入りません", "口がゆがんでいます"].forEach(text => {
    assert.ok(triage.hasEmergency(text), `緊急として検出されるべき: ${text}`);
  });
});

test("活用形の網羅: 呼びかけに応じない・反応がない", () => {
  ["呼びかけに応じないです", "呼びかけに応じません", "呼びかけに応じていません",
   "反応がないです", "反応がありません", "反応しません", "反応していません",
   "反応がなくなりました", "呼んでも返事がありません",
   "揺すっても起きません", "目を覚ましません"].forEach(text => {
    assert.ok(triage.hasEmergency(text), `緊急として検出されるべき: ${text}`);
  });
});

test("活用形の網羅: 意識・呼吸", () => {
  ["意識がありません", "意識が戻りません", "意識がはっきりしません",
   "意識がなくなりました", "息をしていません", "息ができません",
   "呼吸が止まっています"].forEach(text => {
    assert.ok(triage.hasEmergency(text), `緊急として検出されるべき: ${text}`);
  });
});

test("活用形を広げても、肯定形（症状なし）では発火しない", () => {
  ["ろれつは回っています", "手足は動きます", "意識ははっきりしています",
   "呼びかけへの反応はいつもどおりです", "息はできています",
   "ろれつも普通です"].forEach(text => {
    assert.deepStrictEqual(tags(text).emg, [], `緊急にしない: ${text}`);
  });
});

/* ===== 急性発症＋普段と違う様子の組み合わせ ===== */

test("「急に」＋「反応が鈍い/ぼんやり」は組み合わせで緊急", () => {
  ["数日前から急にぼんやりして、呼びかけても反応が鈍いです",
   "急に反応が鈍くなりました",
   "昨日から急にぐったりしています"].forEach(text => {
    assert.ok(tags(text).emg.includes("acute-behavior-change"), `緊急に格上げされるべき: ${text}`);
  });
});

test("「反応が鈍い」は単独では緊急にしない（緩やかな進行と区別する）", () => {
  // 病気の進行に伴うゆるやかな変化は緊急ではない
  ["反応が鈍いです",
   "認知症が進んで、だんだん反応が鈍くなってきました",
   "この半年でゆっくりとぼんやりすることが増えました"].forEach(text => {
    assert.deepStrictEqual(tags(text).emg, [], `緊急にしない: ${text}`);
    assert.ok(tags(text).cau.includes("behavior-change"), `要確認語としては拾う: ${text}`);
  });
});

test("組み合わせ格上げが過検知トラップに影響しない", () => {
  // T07: 「急に」はあるが behavior-change に当たる語がない
  const t07 = tags("急に怒りっぽくなった気がします。ここ半年でだんだんと。");
  assert.deepStrictEqual(t07.emg, []);
  assert.ok(t07.cau.includes("acute"));
  // T08: 「ぼんやり」はあるが「日中は普通です」で抑制され、急性発症の語もない
  const t08 = tags("たまに夜ぼんやりテレビを見ています。日中は普通です。");
  assert.deepStrictEqual(t08.emg, []);
  assert.ok(!t08.cau.includes("behavior-change"), "否定で抑制される");
});

/* ===== 要確認語（バナーは出さない） ===== */

test("要確認語は単独では緊急にならない", () => {
  ["急に怒りっぽくなりました",
   "熱が少しあります",
   "頭を打ったことがあります",
   "最近ぼんやりしています",
   "よくつまずきます"].forEach(text => {
    assert.deepStrictEqual(tags(text).emg, [], `緊急にしない: ${text}`);
    assert.ok(tags(text).cau.length > 0, `要確認語としては拾う: ${text}`);
  });
});

test("「急に」は単独では緊急にせず、随伴症状と組み合わせて緊急になる", () => {
  assert.deepStrictEqual(tags("急に元気がなくなりました").emg, []);
  assert.ok(tags("急に意識がもうろうとしています").emg.includes("drowsy"));
});

test("頭部打撲は単独では要確認、打撲後の嘔吐があれば緊急", () => {
  assert.deepStrictEqual(tags("先週、頭をぶつけました").emg, []);
  assert.ok(tags("頭を打ってから吐いています").emg.includes("head-impact-vomit"));
});

/* ===== 否定・過去・仮定の抑制 ===== */

test("否定処理: さまざまな否定表現", () => {
  assert.ok(!tags("転んだことはありません").cau.includes("fall"));
  assert.ok(!tags("けいれんは見られません").emg.includes("seizure"));
  assert.ok(!tags("発熱はなくなりました").cau.includes("fever"));
  assert.ok(!tags("ふらつきはないです").cau.includes("gait"));
});

test("否定処理: 「危ない」「少ない」の「ない」を否定と誤判定しない", () => {
  assert.ok(tags("転びそうで危ないです").cau.includes("fall") ||
            tags("よく転ぶので危ないです").cau.includes("fall"));
  assert.ok(tags("よく転ぶので危ないです").cau.includes("fall"));
});

test("過去の出来事は現在の緊急として扱わない", () => {
  assert.ok(!tags("昔けいれんを起こしたことがあります").emg.includes("seizure"));
  assert.ok(!tags("3年前に頭を打ちました").cau.includes("head-impact"));
});

test("「以前より」は比較の表現なので過去扱いしない", () => {
  assert.ok(tags("以前より転ぶようになりました").cau.includes("fall"),
    "現在進行中の変化として拾う");
});

test("仮定・不安の表現は現在の緊急として扱わない", () => {
  assert.ok(!tags("転ぶかもしれないので心配です").cau.includes("fall"));
  assert.ok(!tags("倒れるのが怖いです").cau.includes("fall"));
  assert.ok(!tags("けいれんを起こすのではないかと不安です").emg.includes("seizure"));
});

test("実際に起きている出来事は「心配」が付いても抑制しない", () => {
  assert.ok(tags("よく転ぶので心配です").cau.includes("fall"),
    "「〜ので心配」は実際に起きている出来事");
  assert.ok(tags("熱が出ていて心配です").cau.includes("fever"));
});

/* ===== 確認質問への否定の答え =====
   確認質問には「ろれつ」「麻痺」等の語が含まれるため、利用者が否定の答えで
   その語をなぞることがある。これで緊急が発火しないことを固定する。 */

test("確認質問を否定する答えで緊急が発火しない", () => {
  const denials = [
    "いいえ、熱もありませんし、ろれつも普通です",
    "いいえ、意識ははっきりしていて、手足の麻痺もありません",
    "呼びかけへの反応はいつもどおりです",
    "特に変わりないです。歩き方も普通です"
  ];
  denials.forEach(text => {
    assert.deepStrictEqual(tags(text).emg, [], `緊急にしない: ${text}`);
  });
});

test("「ろれつ」は症状として述べられたときだけ緊急", () => {
  assert.ok(triage.hasEmergency("ろれつが回らないようです"));
  assert.deepStrictEqual(tags("ろれつは回っています").emg, []);
});

/* ===== 程度の表現 ===== */

test("程度の表現を検知する（重症度を上げすぎないヒント）", () => {
  assert.strictEqual(tags("たまにふらつきます").mild, true);
  assert.strictEqual(tags("ときどき転びます").mild, true);
  assert.strictEqual(tags("毎日何度も転びます").mild, false);
});

/* ===== 会話全体での判定 ===== */

test("複数発言をまたいだ組み合わせでも緊急に格上げされる", () => {
  const text = "転んで頭を打ちました\n昨日から様子がおかしいです";
  assert.ok(tags(text).emg.includes("head-impact-change"));
});

test("否定の走査は改行をまたがない", () => {
  // 別発言の「ありません」で前の発言の語を打ち消さない
  const text = "熱があります\n特に他はありません";
  assert.ok(tags(text).cau.includes("fever"));
});

/* ===== 入力の頑健性 ===== */

test("空文字・null でも例外にならない", () => {
  assert.deepStrictEqual(triage.classify("").emergency, []);
  assert.deepStrictEqual(triage.classify(null).emergency, []);
  assert.deepStrictEqual(triage.classify(undefined).caution, []);
});

test("タグ一覧が公開されている（Worker側の検証用）", () => {
  assert.ok(triage.EMERGENCY_TAGS.includes("consciousness"));
  assert.ok(triage.EMERGENCY_TAGS.includes("head-impact-change"));
  assert.ok(triage.CAUTION_TAGS.includes("gait"));
  assert.ok(!triage.CAUTION_TAGS.includes("consciousness"));
});
