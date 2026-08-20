/**
 * トリアージ改善の効果測定【層2】— 本番Worker経由のAI判定の評価
 *
 *   node eval_triage_layer2.js            … 20件を判定して eval_layer2_result.md を出力
 *   node eval_triage_layer2.js --dry-run  … API を呼ばずに送信内容だけ確認する
 *
 * 何を測るか:
 *   本番Worker（Gemini 3.7 Flash）が返す result.urgency / category / stage_band を、
 *   評価セットの暫定ラベルと突き合わせる。
 *
 * 【重要】この評価は実際の多段問診とは異なる近似である:
 *   API呼び出し数を抑えるため、各ケースを「相談文1メッセージ＋force_done」で
 *   整理結果まで一気に進める簡易モードで測定している。この経路では Worker の
 *   次の2つの仕組みが働かない（どちらも force_done のとき無効になる実装のため）:
 *     - 要確認語を伝えるシステム補足（buildTriageNote）
 *     - 確認質問を強制するサーバ側ガード（enforceConfirmationBeforeEmergency）
 *   つまりここで測っているのは「プロンプトだけによるAIの一発判断」であり、
 *   実際に利用者が体験する多段問診より不利な条件での測定になる。
 *   利用者が受け取る結果に近い数字は、層1の即時バナー判定と統合した
 *   「総合成績」の節を参照すること。
 *
 * プライバシー: 送信するのは評価セットの架空の相談文のみ（実際の相談内容ではない）。
 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const triage = require("./triage.js");

const WORKER_URL = "https://kyoto-ninchisho-consult.iwatas.workers.dev";
const CSV_PATH = path.join(__dirname, "トリアージ評価セット_v2_20件.csv");
const OUT_PATH = path.join(__dirname, "eval_layer2_result.md");
const RAW_PATH = path.join(__dirname, "eval_layer2_raw.json");

const SLEEP_MS = 3000;        // 無料枠のレート制限に配慮した待機
const RETRY_WAIT_MS = 30000;  // 429（レート制限）のときの待機
// gemini-3.7-flash は 503（This model is currently experiencing high demand）を
// 高頻度で返すことがある（2026-08-19 の実測では大半のリクエストが初回503）。
// 一時的な負荷なので、長めのバックオフで粘り強く再試行する。
const BUSY_WAIT_MS = [15000, 30000, 60000, 90000, 120000];
const MAX_RETRY = 6;
const TIMEOUT_MS = 120000;    // 思考レベル medium のため長めに取る

const DRY_RUN = process.argv.includes("--dry-run");
// 既に取得済みの生データからレポートだけ作り直す（API呼び出しなし）
const REPORT_ONLY = process.argv.includes("--report-only");

/* ===== CSV（引用符つきフィールド・BOM対応の最小実装） ===== */
function parseCsv(text) {
  const src = text.replace(/^﻿/, "");
  const rows = [];
  let row = [], field = "", inQuotes = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (inQuotes) {
      if (c === '"') { if (src[i + 1] === '"') { field += '"'; i++; } else inQuotes = false; }
      else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n") { row.push(field); rows.push(row); row = []; field = ""; }
    else if (c !== "\r") field += c;
  }
  if (field !== "" || row.length) { row.push(field); rows.push(row); }
  const header = rows.shift().map(h => h.trim());
  return rows.filter(r => r.some(v => v.trim() !== ""))
    .map(r => Object.fromEntries(header.map((h, i) => [h, (r[i] || "").trim()])));
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

/* ===== Worker 呼び出し（429 / 503 リトライつき） ===== */
let transientCount = 0;   // 一時エラー（503/429/通信）による再試行の総回数

async function callWorker(text, signs) {
  const body = {
    messages: [{ role: "user", content: text }],
    force_done: true,
    // 実際のフロントと同じ形でヒントも送る（force_done のときWorkerは使わないが、
    // リクエストの形を本番と揃えておく）
    triage: { caution: signs.cautionTags, mild: signs.mild }
  };

  for (let attempt = 1; attempt <= MAX_RETRY; attempt++) {
    if (attempt > 1) transientCount++;
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
    try {
      const res = await fetch(WORKER_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Origin": "https://iwatas-hub.github.io"
        },
        body: JSON.stringify(body),
        signal: ac.signal
      });
      clearTimeout(timer);
      const json = await res.json().catch(() => null);

      if (res.ok) return { ok: true, json, attempts: attempt };

      const detail = json && (json.detail || json.error) || `HTTP ${res.status}`;
      const upstream = json && json.upstream_status;
      const isRateLimited = res.status === 429 || upstream === 429;
      if (isRateLimited && attempt < MAX_RETRY) {
        console.log(`    429（レート制限）。${RETRY_WAIT_MS / 1000}秒待って再試行 (${attempt}/${MAX_RETRY})`);
        await sleep(RETRY_WAIT_MS);
        continue;
      }
      if (res.status >= 500 && attempt < MAX_RETRY) {
        const wait = BUSY_WAIT_MS[Math.min(attempt - 1, BUSY_WAIT_MS.length - 1)];
        console.log(`    upstream ${upstream || res.status}: ${String(detail).slice(0, 55)} … ${wait / 1000}秒待って再試行 (${attempt}/${MAX_RETRY})`);
        await sleep(wait);
        continue;
      }
      return { ok: false, error: `HTTP ${res.status}: ${detail}`, attempts: attempt };
    } catch (e) {
      clearTimeout(timer);
      if (attempt < MAX_RETRY) {
        const wait = BUSY_WAIT_MS[Math.min(attempt - 1, BUSY_WAIT_MS.length - 1)];
        console.log(`    通信エラー(${e.name})。${wait / 1000}秒待って再試行 (${attempt}/${MAX_RETRY})`);
        await sleep(wait);
        continue;
      }
      return { ok: false, error: `${e.name}: ${e.message}`, attempts: attempt };
    }
  }
  return { ok: false, error: "リトライ上限に達しました", attempts: MAX_RETRY };
}

/* ===== 実行 ===== */
const GROUPS = ["真の緊急", "過検知トラップ", "中間帯較正", "通常帯", "情報不足"];
const URGENCIES = ["emergency", "urgent", "routine"];

async function main() {
  const rows = parseCsv(fs.readFileSync(CSV_PATH, "utf8"));
  const results = [];

  if (REPORT_ONLY) {
    const saved = JSON.parse(fs.readFileSync(RAW_PATH, "utf8"));
    // 層1の判定だけ現在のコードで取り直す（AI応答は保存済みのものを使う）
    saved.forEach(r => {
      const signs = triage.classify(r.text);
      r.layer1 = {
        banner: signs.emergency.length > 0,
        emergency: signs.emergency.map(e => `${e.label}(${e.id})${e.via === "combo" ? "[組合せ]" : ""}`),
        caution: signs.caution.map(c => `${c.label}(${c.id})`),
        suppressed: signs.suppressed.map(x => `${x.label}(${x.id})←${x.reason}`)
      };
    });
    writeReport(saved);
    return;
  }

  // 再開: 前回の実行で成功したケースは再リクエストしない。
  // 503 が多発する時間帯でも、失敗したケースだけを何度でも追試できるようにする
  // （API呼び出し・無料枠の消費を無駄にしないため）。
  let previous = {};
  if (!DRY_RUN && fs.existsSync(RAW_PATH)) {
    try {
      JSON.parse(fs.readFileSync(RAW_PATH, "utf8"))
        .filter(r => r.status === "ok")
        .forEach(r => { previous[r.id] = r; });
      const n = Object.keys(previous).length;
      if (n) console.log(`前回の測定結果を再利用します: ${n}件（残り ${rows.length - n}件を取得）\n`);
    } catch (e) { console.log("（前回結果の読み込みに失敗したため全件取得します）"); }
  }

  console.log(`層2評価: ${rows.length}件を Worker 経由で判定します（簡易モード: 1メッセージ＋force_done）`);
  console.log(`エンドポイント: ${WORKER_URL}\n`);

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const text = row["相談文（入力例）"];
    const signs = triage.classify(text);          // 層1の判定（突き合わせ用）
    console.log(`[${i + 1}/${rows.length}] ${row["ID"]} ${text}`);

    let rec = {
      id: row["ID"],
      group: GROUPS.includes(row["分類"]) ? row["分類"] : "その他",
      respondent: row["回答者"],
      text,
      aim: row["ねらい・確認したい点"],
      expected: {
        urgency: row["暫定_緊急度"],
        category: row["暫定_カテゴリ"],
        stage_band: row["暫定_進行度"]
      },
      layer1: {
        banner: signs.emergency.length > 0,
        emergency: signs.emergency.map(e => `${e.label}(${e.id})${e.via === "combo" ? "[組合せ]" : ""}`),
        caution: signs.caution.map(c => `${c.label}(${c.id})`),
        suppressed: signs.suppressed.map(s => `${s.label}(${s.id})←${s.reason}`)
      }
    };

    if (DRY_RUN) {
      rec.status = "dry-run";
      results.push(rec);
      continue;
    }

    if (previous[rec.id]) {
      // 前回成功したケース: 層1の判定だけ現在のコードで取り直し、AI応答は再利用する
      const prev = previous[rec.id];
      rec.status = "ok";
      rec.predicted = prev.predicted;
      rec.reused = true;
      console.log(`    → 前回の測定結果を再利用（urgency=${prev.predicted.urgency}）`);
      results.push(rec);
      continue;
    }

    const r = await callWorker(text, signs);
    if (!r.ok) {
      rec.status = "測定不能";
      rec.error = r.error;
      console.log(`    → 測定不能: ${r.error}`);
    } else if (!r.json || r.json.phase !== "done" || !r.json.result) {
      rec.status = "測定不能";
      rec.error = `期待した形の応答ではありません (phase=${r.json && r.json.phase})`;
      rec.rawPhase = r.json && r.json.phase;
      rec.rawQuestion = r.json && r.json.next_question;
      console.log(`    → 測定不能: ${rec.error}`);
    } else {
      const res = r.json.result;
      rec.status = "ok";
      rec.predicted = {
        urgency: res.urgency,
        category: res.category,
        category_label: res.category_label,
        stage_band: res.stage_band,
        stage_fast: res.stage_estimate && res.stage_estimate.fast,
        confidence: res.stage_estimate && res.stage_estimate.confidence,
        inserted_risk: res.inserted_risk,
        urgency_reason: res.urgency_reason,
        reason: res.reason
      };
      const mark = (a, b) => a === b ? "○" : "×";
      console.log(`    → urgency=${res.urgency} ${mark(res.urgency, rec.expected.urgency)}` +
        `  category=${res.category} ${mark(res.category, rec.expected.category)}` +
        `  stage=${res.stage_band} ${mark(res.stage_band, rec.expected.stage_band)}`);
    }
    results.push(rec);
    // 中断されても測定済みの結果を失わないよう、1件ごとに保存する（再開に使う）
    fs.writeFileSync(RAW_PATH, JSON.stringify(results, null, 2), "utf8");
    if (i < rows.length - 1) await sleep(SLEEP_MS);
  }

  if (DRY_RUN) {
    console.log("\n--dry-run のため API 呼び出しと出力はスキップしました");
    return;
  }

  fs.writeFileSync(RAW_PATH, JSON.stringify(results, null, 2), "utf8");
  writeReport(results);
}

/* ===== 集計・レポート ===== */
function writeReport(results) {
  const measured = results.filter(r => r.status === "ok");
  const unmeasurable = results.filter(r => r.status !== "ok");

  const hit = (r, key) => r.predicted && r.predicted[key] === r.expected[key];
  const pct = (a, b) => b === 0 ? "—" : (a / b * 100).toFixed(1) + "%";
  const list = a => a && a.length ? a.join(" / ") : "—";

  // 層1と層2の統合: 利用者が実際に受け取るのは
  //   「層1が緊急語を検知したら即バナー（AIの応答を待たない）」＋「AIの結論」
  // なので、体感の緊急度は両者の OR になる。
  const combinedUrgency = r =>
    (r.layer1.banner || (r.predicted && r.predicted.urgency === "emergency"))
      ? "emergency"
      : (r.predicted ? r.predicted.urgency : null);

  const tally = (rs, fn) => rs.reduce((n, r) => n + (fn(r) ? 1 : 0), 0);

  const byGroup = {};
  results.forEach(r => {
    byGroup[r.group] = byGroup[r.group] || { n: 0, measured: 0, u: 0, c: 0, s: 0, comb: 0 };
    const g = byGroup[r.group];
    g.n++;
    if (r.status === "ok") {
      g.measured++;
      if (hit(r, "urgency")) g.u++;
      if (hit(r, "category")) g.c++;
      if (hit(r, "stage_band")) g.s++;
      if (combinedUrgency(r) === r.expected.urgency) g.comb++;
    }
  });

  const uOk = tally(measured, r => hit(r, "urgency"));
  const cOk = tally(measured, r => hit(r, "category"));
  const sOk = tally(measured, r => hit(r, "stage_band"));
  const combOk = tally(measured, r => combinedUrgency(r) === r.expected.urgency);

  // 重点確認
  const trueEmg = results.filter(r => r.group === "真の緊急");
  const traps = results.filter(r => r.group === "過検知トラップ");
  const trueEmgHit = tally(trueEmg, r => r.predicted && r.predicted.urgency === "emergency");
  const trueEmgCombined = tally(trueEmg, r => combinedUrgency(r) === "emergency");
  const trapOverFire = traps.filter(r => r.predicted && r.predicted.urgency === "emergency");
  const trapCombinedOver = traps.filter(r => combinedUrgency(r) === "emergency");

  const L = [];
  L.push("# トリアージ評価【層2】結果 — Worker経由のAI判定");
  L.push("");
  L.push(`- 評価対象: 本番Worker \`${WORKER_URL}\`（モデル: gemini-3.7-flash）`);
  L.push(`- 評価セット: \`トリアージ評価セット_v2_20件.csv\`（${results.length}件）`);
  L.push(`- 実行日時: ${new Date().toISOString().slice(0, 16).replace("T", " ")} (UTC)`);
  L.push(`- 測定できたケース: ${measured.length} / ${results.length}` +
    (unmeasurable.length ? `（測定不能 ${unmeasurable.length}件）` : ""));
  const reused = results.filter(r => r.reused).length;
  if (reused) L.push(`- うち前回実行から再利用: ${reused} 件（503多発のため複数回に分けて取得）`);
  L.push(`- 一時エラーによる再試行: ${transientCount} 回` +
    (transientCount ? "（gemini-3.7-flash が 503「high demand」を断続的に返すため。再試行で回復）" : ""));
  L.push("");
  L.push("## ⚠ この測定は実際の多段問診とは異なる近似です");
  L.push("");
  L.push("API呼び出し数を抑えるため、各ケースを **「相談文1メッセージ＋`force_done`」で");
  L.push("整理結果まで一気に進める簡易モード** で測定しています。実際の利用では、AIが");
  L.push("最大8問の確認質問を挟みながら判断します。");
  L.push("");
  L.push("さらにこの経路では、Worker の次の2つの仕組みが**働きません**");
  L.push("（どちらも `force_done` のとき無効になる実装のため）:");
  L.push("");
  L.push("| 仕組み | 役割 | 簡易モードでの状態 |");
  L.push("|---|---|---|");
  L.push("| `buildTriageNote` | 要確認語を検知してAIに確認質問を促すシステム補足 | 送られない |");
  L.push("| `enforceConfirmationBeforeEmergency` | 確認質問を挟まない emergency を確認質問へ差し替える | 働かない |");
  L.push("");
  L.push("つまりここで測っているのは **「システムプロンプトだけによるAIの一発判断」** であり、");
  L.push("実際の利用条件より不利な、安全マージンを外した状態での測定です。");
  L.push("利用者が実際に受け取る結果に近い数字は「総合成績（層1＋層2）」の節を参照してください。");
  L.push("");
  L.push("## 重点確認");
  L.push("");
  L.push(`### 1. 「真の緊急」3件を emergency と判定できたか（見落としは重大）`);
  L.push("");
  L.push(`**AI単独: ${trueEmgHit} / ${trueEmg.length}**　／　**層1＋層2の統合: ${trueEmgCombined} / ${trueEmg.length}**`);
  L.push("");
  L.push("| ID | 相談文 | AIのurgency | 層1バナー | 統合結果 | 判定 |");
  L.push("|---|---|---|---|---|---|");
  trueEmg.forEach(r => {
    const u = r.predicted ? r.predicted.urgency : "（測定不能）";
    L.push(`| ${r.id} | ${r.text} | ${u} | ${r.layer1.banner ? "出る" : "出ない"} | ${combinedUrgency(r) || "—"} | ${combinedUrgency(r) === "emergency" ? "○" : "**× 見落とし**"} |`);
  });
  L.push("");
  L.push(`### 2. 「過検知トラップ」8件を emergency にしていないか（今回の主訴）`);
  L.push("");
  L.push(`**AI単独の過検知: ${trapOverFire.length} / ${traps.length}**　／　**統合後の過検知: ${trapCombinedOver.length} / ${traps.length}**`);
  L.push("");
  L.push("| ID | 相談文 | AIのurgency | 層1バナー | 統合結果 | 判定 |");
  L.push("|---|---|---|---|---|---|");
  traps.forEach(r => {
    const u = r.predicted ? r.predicted.urgency : "（測定不能）";
    L.push(`| ${r.id} | ${r.text} | ${u} | ${r.layer1.banner ? "出る" : "出ない"} | ${combinedUrgency(r) || "—"} | ${combinedUrgency(r) === "emergency" ? "**× 過検知**" : "○"} |`);
  });
  L.push("");
  L.push("## 全体成績（AI単独）");
  L.push("");
  L.push("| 項目 | 一致 | 母数 | 一致率 |");
  L.push("|---|---|---|---|");
  L.push(`| urgency（緊急度） | ${uOk} | ${measured.length} | ${pct(uOk, measured.length)} |`);
  L.push(`| category（相談先） | ${cOk} | ${measured.length} | ${pct(cOk, measured.length)} |`);
  L.push(`| stage_band（進行度） | ${sOk} | ${measured.length} | ${pct(sOk, measured.length)} |`);
  L.push("");
  L.push("## グループ別成績");
  L.push("");
  L.push("| 分類 | 件数 | 測定 | urgency | category | stage_band |");
  L.push("|---|---|---|---|---|---|");
  GROUPS.filter(g => byGroup[g]).forEach(g => {
    const s = byGroup[g];
    L.push(`| ${g} | ${s.n} | ${s.measured} | ${s.u}/${s.measured}（${pct(s.u, s.measured)}） | ${s.c}/${s.measured}（${pct(s.c, s.measured)}） | ${s.s}/${s.measured}（${pct(s.s, s.measured)}） |`);
  });
  L.push("");
  L.push("## urgency の混同行列（AI単独）");
  L.push("");
  L.push("行 = 暫定ラベル（正解）／ 列 = AIの予測");
  L.push("");
  L.push("| 暫定 \\ 予測 | " + URGENCIES.join(" | ") + " | 計 |");
  L.push("|---|" + URGENCIES.map(() => "---|").join("") + "---|");
  URGENCIES.forEach(exp => {
    const cells = URGENCIES.map(pred =>
      tally(measured, r => r.expected.urgency === exp && r.predicted.urgency === pred));
    const rowTotal = cells.reduce((a, b) => a + b, 0);
    L.push(`| **${exp}** | ${cells.map((n, i) => URGENCIES[i] === exp ? `**${n}**` : String(n)).join(" | ")} | ${rowTotal} |`);
  });
  L.push("");
  L.push("## 総合成績（層1＋層2）");
  L.push("");
  L.push("利用者が実際に受け取るのは、**層1の即時救急バナー**（AIの応答を待たずに表示）と");
  L.push("**AIの結論**の両方です。どちらか一方でも緊急を示せば利用者は救急案内を目にするため、");
  L.push("体感の緊急度は両者の OR として算出します。");
  L.push("");
  L.push("```");
  L.push("統合urgency = (層1が緊急語を検知 または AIがemergency) ? emergency : AIのurgency");
  L.push("```");
  L.push("");
  L.push(`**統合後の urgency 一致率: ${combOk} / ${measured.length}（${pct(combOk, measured.length)}）**`);
  L.push("");
  L.push("| 分類 | 件数 | AI単独 | 層1＋層2統合 |");
  L.push("|---|---|---|---|");
  GROUPS.filter(g => byGroup[g]).forEach(g => {
    const s = byGroup[g];
    L.push(`| ${g} | ${s.measured} | ${s.u}/${s.measured}（${pct(s.u, s.measured)}） | ${s.comb}/${s.measured}（${pct(s.comb, s.measured)}） |`);
  });
  L.push("");
  L.push("| 安全上の要点 | AI単独 | 層1＋層2統合 |");
  L.push("|---|---|---|");
  L.push(`| 真の緊急の見落とし | ${trueEmg.length - trueEmgHit} 件 | ${trueEmg.length - trueEmgCombined} 件 |`);
  L.push(`| 過検知トラップでの誤発火 | ${trapOverFire.length} 件 | ${trapCombinedOver.length} 件 |`);
  L.push("");

  /* category / stage_band の不一致の内訳。
     簡易モードでは1メッセージしか渡していないため、AIが【情報不足時のフェイルセーフ】
     （＝無理に推定せず kakaritsuke / unknown に倒す）を正しく発動させると、
     多段問診を前提にした暫定ラベルとは一致しなくなる。これを機械的に切り分ける。 */
  const catMiss = measured.filter(r => !hit(r, "category"));
  const catMissFailsafe = catMiss.filter(r =>
    r.predicted.category === "kakaritsuke" && r.expected.category !== "kakaritsuke");
  const stageMiss = measured.filter(r => !hit(r, "stage_band"));
  const stageMissUnknown = stageMiss.filter(r =>
    r.predicted.stage_band === "unknown" && r.expected.stage_band !== "unknown");

  L.push("## 不一致の内訳（簡易モードの影響の切り分け）");
  L.push("");
  L.push("1メッセージしか渡していないため、AIが【情報不足時のフェイルセーフ】");
  L.push("（無理に推定せず `kakaritsuke` / `unknown` へ慎重に倒す）を正しく発動させると、");
  L.push("多段問診を前提にした暫定ラベルとは一致しなくなります。その切り分けです。");
  L.push("");
  L.push("| 内訳 | 件数 |");
  L.push("|---|---|");
  L.push(`| category 不一致（合計） | ${catMiss.length} |`);
  L.push(`| うち「情報不足→kakaritsuke」への後退 | ${catMissFailsafe.length} |`);
  L.push(`| うちそれ以外（判断の相違） | ${catMiss.length - catMissFailsafe.length} |`);
  L.push(`| stage_band 不一致（合計） | ${stageMiss.length} |`);
  L.push(`| うち「情報不足→unknown」への後退 | ${stageMissUnknown.length} |`);
  L.push(`| うちそれ以外（推定の相違） | ${stageMiss.length - stageMissUnknown.length} |`);
  L.push("");
  const catAdj = cOk + catMissFailsafe.length;
  const stageAdj = sOk + stageMissUnknown.length;
  L.push(`フェイルセーフによる後退を「簡易モードの制約であって誤りではない」と扱った場合、`);
  L.push(`category は ${catAdj}/${measured.length}（${pct(catAdj, measured.length)}）、`);
  L.push(`stage_band は ${stageAdj}/${measured.length}（${pct(stageAdj, measured.length)}）に相当します。`);
  L.push("**この補正値は多段問診での実力を保証するものではありません**（層3として多段問診で");
  L.push("測り直す必要があります）。安全上の要点である urgency は補正なしで評価しています。");
  L.push("");

  const mismatches = measured.filter(r =>
    !hit(r, "urgency") || !hit(r, "category") || !hit(r, "stage_band"));
  L.push("## 不一致ケース");
  L.push("");
  if (!mismatches.length) {
    L.push("なし（urgency / category / stage_band すべて一致）。");
  } else {
    mismatches.forEach(r => {
      const flag = k => hit(r, k) ? "○" : "×";
      L.push(`### ${r.id}（${r.group}）`);
      L.push("");
      L.push(`> ${r.text}`);
      L.push("");
      L.push("| 項目 | 暫定ラベル | AIの予測 | |");
      L.push("|---|---|---|---|");
      L.push(`| urgency | ${r.expected.urgency} | ${r.predicted.urgency} | ${flag("urgency")} |`);
      L.push(`| category | ${r.expected.category} | ${r.predicted.category} | ${flag("category")} |`);
      L.push(`| stage_band | ${r.expected.stage_band} | ${r.predicted.stage_band} | ${flag("stage_band")} |`);
      L.push("");
      L.push(`- AIの緊急度の理由: ${r.predicted.urgency_reason}`);
      L.push(`- AIの相談先の理由: ${r.predicted.reason}`);
      L.push(`- AIが立てたリスク: ${r.predicted.inserted_risk} / 進行度推定: FAST ${r.predicted.stage_fast}（確からしさ ${r.predicted.confidence}）`);
      L.push(`- 層1: バナー${r.layer1.banner ? "出る" : "出ない"} / 緊急語=${list(r.layer1.emergency)} / 要確認語=${list(r.layer1.caution)} / 抑制=${list(r.layer1.suppressed)}`);
      L.push(`- ねらい: ${r.aim}`);
      L.push("");
    });
  }

  if (unmeasurable.length) {
    L.push("## 測定不能ケース");
    L.push("");
    L.push("| ID | 相談文 | 理由 |");
    L.push("|---|---|---|");
    unmeasurable.forEach(r => L.push(`| ${r.id} | ${r.text} | ${r.error || r.status} |`));
    L.push("");
  }

  L.push("## 全ケースの結果");
  L.push("");
  L.push("| ID | 分類 | 相談文 | urgency（暫定→AI） | category（暫定→AI） | stage（暫定→AI） | 層1バナー | 統合 |");
  L.push("|---|---|---|---|---|---|---|---|");
  results.forEach(r => {
    const p = r.predicted;
    const cell = k => p ? `${r.expected[k]} → ${p[k]} ${hit(r, k) ? "○" : "×"}` : `${r.expected[k]} → （測定不能）`;
    L.push(`| ${r.id} | ${r.group} | ${r.text.replace(/\|/g, "\\|")} | ${cell("urgency")} | ${cell("category")} | ${cell("stage_band")} | ${r.layer1.banner ? "出る" : "—"} | ${combinedUrgency(r) || "—"} |`);
  });
  L.push("");
  L.push("---");
  L.push("");
  L.push(`生データ: \`${path.basename(RAW_PATH)}\`（AIの全応答フィールドを含む）`);
  L.push("");

  fs.writeFileSync(OUT_PATH, L.join("\n"), "utf8");

  console.log(`\n===== 集計 =====`);
  console.log(`測定 ${measured.length}/${results.length}  urgency ${uOk}/${measured.length} (${pct(uOk, measured.length)})  category ${cOk}/${measured.length} (${pct(cOk, measured.length)})  stage ${sOk}/${measured.length} (${pct(sOk, measured.length)})`);
  console.log(`真の緊急: AI単独 ${trueEmgHit}/${trueEmg.length}、統合 ${trueEmgCombined}/${trueEmg.length}`);
  console.log(`過検知トラップの誤発火: AI単独 ${trapOverFire.length}/${traps.length}、統合 ${trapCombinedOver.length}/${traps.length}`);
  console.log(`統合urgency 一致率: ${combOk}/${measured.length} (${pct(combOk, measured.length)})`);
  console.log(`\n→ ${path.basename(OUT_PATH)} / ${path.basename(RAW_PATH)} を出力しました`);
}

main().catch(e => { console.error("失敗:", e); process.exit(1); });
