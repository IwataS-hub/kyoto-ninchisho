/**
 * トリアージ改善の効果測定【層1】— APIを使わない語彙判定の評価
 *
 *   node eval_triage_layer1.js
 *     → eval_layer1_result.md を出力
 *
 * 何を測るか:
 *   triage.js（フロント・Worker共通の語彙判定）だけを対象に、
 *   「即時救急バナーが出るか」＝ classify().emergency.length > 0 を予測値とし、
 *   評価セットの 暫定_緊急度 が "emergency" のケースを正解として突き合わせる。
 *
 * 測れないもの（層2の担当）:
 *   AIの最終的な緊急度・カテゴリ・進行度の判定。ここで見るのは
 *   「AIに渡る前にフロントが即断してしまう部分」だけである。
 *
 * 注意: このスクリプトは判定ロジックを一切変更しない（読むだけ）。
 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const triage = require("./triage.js");

const CSV_PATH = path.join(__dirname, "トリアージ評価セット_v2_20件.csv");
const OUT_PATH = path.join(__dirname, "eval_layer1_result.md");

/* ===== CSV読み込み（引用符つきフィールド・BOM対応の最小実装） ===== */
function parseCsv(text) {
  const src = text.replace(/^﻿/, "");
  const rows = [];
  let row = [], field = "", inQuotes = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (inQuotes) {
      if (c === '"') {
        if (src[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n") { row.push(field); rows.push(row); row = []; field = ""; }
    else if (c !== "\r") field += c;
  }
  if (field !== "" || row.length) { row.push(field); rows.push(row); }
  const header = rows.shift().map(h => h.trim());
  return rows
    .filter(r => r.some(v => v.trim() !== ""))
    .map(r => Object.fromEntries(header.map((h, i) => [h, (r[i] || "").trim()])));
}

/* ===== 期待値: 即時救急バナーを出すべきか ===== */
// 「真の緊急」= バナーが出るべき（出なければ見落とし＝重大）
// 「過検知トラップ」およびその他 = バナーが出てはいけない（出れば過検知＝今回の主訴）
function expectBanner(row) {
  return row["暫定_緊急度"] === "emergency";
}

/* ===== グループ分け ===== */
const GROUPS = ["真の緊急", "過検知トラップ", "中間帯較正", "通常帯", "情報不足"];
function groupOf(row) {
  return GROUPS.includes(row["分類"]) ? row["分類"] : "その他";
}

/* ===== 1件の判定 ===== */
function evaluateRow(row) {
  const text = row["相談文（入力例）"];
  const r = triage.classify(text);

  const emergencyByTerm = r.emergency.filter(e => e.via === "term");
  const emergencyByCombo = r.emergency.filter(e => e.via === "combo");
  const predictedBanner = r.emergency.length > 0;
  const expected = expectBanner(row);

  return {
    id: row["ID"],
    group: groupOf(row),
    respondent: row["回答者"],
    text,
    aim: row["ねらい・確認したい点"],
    expectedUrgency: row["暫定_緊急度"],
    expectedBanner: expected,
    predictedBanner,
    correct: predictedBanner === expected,
    // 判定の内訳
    emergencyTerms: emergencyByTerm.map(e => `${e.label}(${e.id})`),
    comboUpgrades: emergencyByCombo.map(e => `${e.label}(${e.id})`),
    cautionTags: r.caution.map(c => `${c.label}(${c.id})${c.degree === "mild" ? "[程度:軽]" : ""}`),
    suppressed: r.suppressed.map(s => `${s.label}(${s.id})←${s.reason}`),
    mild: r.mild,
    // 誤りの種類
    errorType: predictedBanner === expected ? null : (expected ? "見落とし" : "過検知")
  };
}

/* ===== 実行 ===== */
const rows = parseCsv(fs.readFileSync(CSV_PATH, "utf8"));
const results = rows.map(evaluateRow);

const total = results.length;
const correct = results.filter(r => r.correct).length;
const misses = results.filter(r => r.errorType === "見落とし");
const overFires = results.filter(r => r.errorType === "過検知");

// 混同行列（バナー出す/出さない）
const tp = results.filter(r => r.expectedBanner && r.predictedBanner).length;
const fn = results.filter(r => r.expectedBanner && !r.predictedBanner).length;
const fp = results.filter(r => !r.expectedBanner && r.predictedBanner).length;
const tn = results.filter(r => !r.expectedBanner && !r.predictedBanner).length;

const byGroup = {};
results.forEach(r => {
  byGroup[r.group] = byGroup[r.group] || { n: 0, ok: 0, miss: 0, over: 0 };
  byGroup[r.group].n++;
  if (r.correct) byGroup[r.group].ok++;
  if (r.errorType === "見落とし") byGroup[r.group].miss++;
  if (r.errorType === "過検知") byGroup[r.group].over++;
});

const pct = (a, b) => b === 0 ? "—" : (a / b * 100).toFixed(1) + "%";
const yn = b => b ? "出る" : "出ない";
const list = a => a.length ? a.join(" / ") : "—";

/* ===== Markdown出力 ===== */
const L = [];
L.push("# トリアージ評価【層1】結果 — 語彙判定（APIなし）");
L.push("");
L.push(`- 評価対象: \`triage.js\` の \`classify()\`（フロント・Worker共通の語彙判定）`);
L.push(`- 評価セット: \`トリアージ評価セット_v2_20件.csv\`（${total}件）`);
L.push(`- 予測値: **即時救急バナーが出るか** = \`classify().emergency.length > 0\``);
L.push(`- 正解値: CSVの \`暫定_緊急度\` が \`emergency\` のケース（＝バナーが出るべき）`);
L.push(`- 実行日時: ${new Date().toISOString().slice(0, 16).replace("T", " ")} (UTC)`);
L.push("");
L.push("> この層で測れるのは「AIに渡る前にフロントが即断してしまう部分」だけです。");
L.push("> 最終的な緊急度・カテゴリ・進行度の判定精度は層2（Worker経由のAI判定）で測ります。");
L.push("");
L.push("## 全体成績");
L.push("");
L.push(`**正答 ${correct} / ${total}（${pct(correct, total)}）**`);
L.push("");
L.push("| | バナーが出るべき | 出てはいけない |");
L.push("|---|---|---|");
L.push(`| **バナーが出た** | ${tp}（正解） | ${fp}（**過検知**） |`);
L.push(`| **出なかった** | ${fn}（**見落とし**） | ${tn}（正解） |`);
L.push("");
L.push(`- 見落とし（重大）: **${misses.length}件**`);
L.push(`- 過検知（今回の主訴）: **${overFires.length}件**`);
L.push("");
L.push("## グループ別成績");
L.push("");
L.push("| 分類 | 件数 | 正答 | 正答率 | 見落とし | 過検知 |");
L.push("|---|---|---|---|---|---|");
GROUPS.filter(g => byGroup[g]).forEach(g => {
  const s = byGroup[g];
  L.push(`| ${g} | ${s.n} | ${s.ok} | ${pct(s.ok, s.n)} | ${s.miss} | ${s.over} |`);
});
L.push("");

if (misses.length || overFires.length) {
  L.push("## 誤ったケース");
  L.push("");
  [...misses, ...overFires].forEach(r => {
    L.push(`### ${r.id}（${r.group}・${r.errorType}）`);
    L.push("");
    L.push(`> ${r.text}`);
    L.push("");
    L.push(`- 期待: バナーが${yn(r.expectedBanner)} / 実際: バナーが${yn(r.predictedBanner)}`);
    L.push(`- 発火した緊急語: ${list(r.emergencyTerms)}`);
    L.push(`- 組み合わせによる格上げ: ${list(r.comboUpgrades)}`);
    L.push(`- 要確認語: ${list(r.cautionTags)}`);
    L.push(`- 抑制（否定・過去・仮定）: ${list(r.suppressed)}`);
    L.push(`- ねらい: ${r.aim}`);
    L.push("");
  });
} else {
  L.push("## 誤ったケース");
  L.push("");
  L.push("なし。");
  L.push("");
}

L.push("## 全ケースの判定内訳");
L.push("");
L.push("| ID | 分類 | 相談文 | 期待 | 実際 | 判定 | 緊急語 | 組み合わせ | 要確認語 | 抑制 |");
L.push("|---|---|---|---|---|---|---|---|---|---|");
results.forEach(r => {
  L.push([
    r.id, r.group, r.text.replace(/\|/g, "\\|"),
    yn(r.expectedBanner), yn(r.predictedBanner),
    r.correct ? "○" : `× ${r.errorType}`,
    list(r.emergencyTerms), list(r.comboUpgrades), list(r.cautionTags), list(r.suppressed)
  ].join(" | ").replace(/^/, "| ") + " |");
});
L.push("");
L.push("## 抑制（否定・過去・仮定）の発動状況");
L.push("");
const suppressedRows = results.filter(r => r.suppressed.length > 0);
if (suppressedRows.length) {
  L.push("| ID | 相談文 | 抑制された語と理由 |");
  L.push("|---|---|---|");
  suppressedRows.forEach(r => L.push(`| ${r.id} | ${r.text} | ${list(r.suppressed)} |`));
} else {
  L.push("発動なし。");
}
L.push("");
L.push("## 程度の表現（「少し」「たまに」等）を検知したケース");
L.push("");
const mildRows = results.filter(r => r.mild);
if (mildRows.length) {
  mildRows.forEach(r => L.push(`- **${r.id}**: ${r.text}`));
} else {
  L.push("なし。");
}
L.push("");

fs.writeFileSync(OUT_PATH, L.join("\n"), "utf8");

/* ===== コンソールにも要約を出す ===== */
console.log(`正答 ${correct}/${total} (${pct(correct, total)})  見落とし ${misses.length}  過検知 ${overFires.length}`);
GROUPS.filter(g => byGroup[g]).forEach(g => {
  const s = byGroup[g];
  console.log(`  ${g}: ${s.ok}/${s.n}  見落とし${s.miss} 過検知${s.over}`);
});
if (misses.length) {
  console.log("\n[見落とし]");
  misses.forEach(r => console.log(`  ${r.id}: ${r.text}\n    要確認語=${list(r.cautionTags)} 抑制=${list(r.suppressed)}`));
}
if (overFires.length) {
  console.log("\n[過検知]");
  overFires.forEach(r => console.log(`  ${r.id}: ${r.text}\n    緊急語=${list(r.emergencyTerms)} 組合せ=${list(r.comboUpgrades)} 抑制=${list(r.suppressed)}`));
}
console.log(`\n→ ${path.basename(OUT_PATH)} を出力しました`);
