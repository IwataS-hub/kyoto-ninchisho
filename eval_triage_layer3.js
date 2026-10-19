/**
 * 多段問診の評価【層3】— 架空の回答者がAIの質問に答えながら、相談を最後まで進める
 *
 *   node eval_triage_layer3.js                 … 14シナリオを1回ずつ実行（検証用Worker）
 *   node eval_triage_layer3.js --runs 2        … 各シナリオを2回ずつ（AIのゆらぎを見る）
 *   node eval_triage_layer3.js --only S06,S07  … 指定したシナリオだけ
 *   node eval_triage_layer3.js --dry-run       … APIを呼ばずに、シナリオと質問の分類を確認
 *   node eval_triage_layer3.js --report-only   … 保存済みの生データからレポートだけ作り直す
 *   node eval_triage_layer3.js --fresh         … 保存済みの結果を使わず、最初から回し直す
 *
 * 途中で止まった場合は、同じコマンドをもう一度実行すると、終わった回は飛ばして続きから回す
 * （回答者の規則が変わっていない場合のみ。eval_flow_lib.js の HARNESS_VERSION）。
 * 月の支出上限・1日の上限など、待っても回復しないエラーでは、再試行せずにその場で中断する。
 *
 * 評価先は既定で検証用Worker。本番と比べるときは EVAL_WORKER_URL と EVAL_TAG を指定する:
 *   EVAL_WORKER_URL=https://kyoto-ninchisho-consult.iwatas.workers.dev EVAL_TAG=prod node eval_triage_layer3.js
 *   （本番は1日50リクエスト/IPの上限があるため、--only で数件ずつ）
 *
 * 出力: eval_layer3_result[_TAG].md / eval_layer3_raw[_TAG].json
 * 判定の中身は eval_flow_lib.js、シナリオは 評価シナリオ_v3_多段問診.json。
 * プライバシー: 送信するのはシナリオの架空の相談文と回答のみ。
 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const triage = require("./triage.js");
const lib = require("./eval_flow_lib.js");

const STAGING_URL = "https://kyoto-ninchisho-consult-staging.iwatas.workers.dev";
const WORKER_URL = process.env.EVAL_WORKER_URL || STAGING_URL;
const TAG = process.env.EVAL_TAG ? "_" + process.env.EVAL_TAG.replace(/[^\w-]/g, "") : "";
const SC_PATH = path.join(__dirname, "評価シナリオ_v3_多段問診.json");
const OUT_PATH = path.join(__dirname, `eval_layer3_result${TAG}.md`);
const RAW_PATH = path.join(__dirname, `eval_layer3_raw${TAG}.json`);

const argv = process.argv.slice(2);
const argVal = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : null; };
const RUNS = Math.max(1, Number(argVal("--runs") || 1));
const ONLY = (argVal("--only") || "").split(",").map(s => s.trim()).filter(Boolean);
const DRY_RUN = argv.includes("--dry-run");
const REPORT_ONLY = argv.includes("--report-only");
const FRESH = argv.includes("--fresh");

const SLEEP_MS = Number(process.env.EVAL_SLEEP_MS || 2000);
const RETRY_WAIT_MS = 30000;
const BUSY_WAIT_MS = [15000, 30000, 60000, 90000, 120000];
const MAX_RETRY = 6;
const TIMEOUT_MS = 120000;
const sleep = ms => new Promise(r => setTimeout(r, ms));

let transientCount = 0;

/** consult.html と同じ形でWorkerに送る（要確認語のヒントも付ける） */
async function send(messages, forceDone) {
  const signs = triage.classify(messages.filter(m => m.role === "user").map(m => m.content).join("\n"));
  const body = { messages, force_done: !!forceDone, triage: { caution: signs.cautionTags, mild: signs.mild } };
  for (let attempt = 1; attempt <= MAX_RETRY; attempt++) {
    if (attempt > 1) transientCount++;
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
    try {
      const res = await fetch(WORKER_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Origin": "https://iwatas-hub.github.io" },
        body: JSON.stringify(body), signal: ac.signal,
      });
      clearTimeout(timer);
      const json = await res.json().catch(() => null);
      await sleep(SLEEP_MS);
      if (res.ok) return { ok: true, json };
      const detail = (json && (json.detail || json.error)) || `HTTP ${res.status}`;
      const upstream = json && json.upstream_status;
      if (lib.isFatalError(detail)) {
        // 月の支出上限・1日の上限・APIキーの問題は、待っても回復しない
        return { ok: false, fatal: true, error: `HTTP ${res.status}: ${detail}` };
      }
      if ((res.status === 429 || upstream === 429) && attempt < MAX_RETRY) {
        console.log(`    429（レート制限）: ${String(detail).slice(0, 60)} … ${RETRY_WAIT_MS / 1000}秒待って再試行`);
        await sleep(RETRY_WAIT_MS); continue;
      }
      if (res.status >= 500 && attempt < MAX_RETRY) {
        const wait = BUSY_WAIT_MS[Math.min(attempt - 1, BUSY_WAIT_MS.length - 1)];
        console.log(`    upstream ${upstream || res.status} … ${wait / 1000}秒待って再試行 (${attempt}/${MAX_RETRY})`);
        await sleep(wait); continue;
      }
      return { ok: false, error: `HTTP ${res.status}: ${detail}` };
    } catch (e) {
      clearTimeout(timer);
      if (attempt < MAX_RETRY) {
        const wait = BUSY_WAIT_MS[Math.min(attempt - 1, BUSY_WAIT_MS.length - 1)];
        console.log(`    通信エラー(${e.name}) … ${wait / 1000}秒待って再試行`);
        await sleep(wait); continue;
      }
      return { ok: false, error: `${e.name}: ${e.message}` };
    }
  }
  return { ok: false, error: "リトライ上限に達しました" };
}

/* ===== レポート ===== */
function buildReport(data) {
  const { scenarios, runs, meta } = data;
  const L = [];
  const bySc = id => runs.filter(r => r.id === id);
  L.push("# 多段問診の評価【層3】結果", "");
  L.push(`- 評価対象: \`${meta.worker}\`（モデル: gemini-3.7-flash）`);
  L.push(`- シナリオ: \`${path.basename(SC_PATH)}\`（${meta.version}）`);
  L.push(`- 実行日時: ${meta.date} (UTC)`);
  L.push(`- 実行回数: 各シナリオ ${meta.runs} 回（計 ${runs.length} 回${meta.reused ? `、うち前回の結果を再利用 ${meta.reused} 回` : ""}）、Workerへのリクエスト ${runs.reduce((a, r) => a + (r.reused ? 0 : r.calls), 0)} 回、一時エラーによる再試行 ${meta.transient} 回`);
  L.push(`- 回答者の規則: v${meta.harness || 1}`, "");
  L.push("## この評価で分かること・分からないこと", "");
  L.push("- 回答者は「質問文をキーワードで話題に分類し、シナリオの答えを返す」単純な規則で動く。実際の利用者の言い回しのばらつきは再現していない。");
  L.push("- シナリオの想定（期待する緊急度・相談先など）はチームの暫定で、医師の確認はまだ。");
  L.push("- AIの応答は毎回少しずつ変わる。1回の結果だけで判断せず、回数を増やして傾向を見る。", "");

  const measured = runs.filter(r => !r.unmeasured);
  const unmeasured = runs.filter(r => r.unmeasured);
  if (unmeasured.length) {
    L.push("## 測定できなかった回（通信・APIのエラー。採点に含めない）", "");
    L.push("| シナリオ | 回 | エラー |", "|---|---|---|");
    unmeasured.forEach(r => L.push(`| ${r.id} | ${r.run} | ${String(r.error).slice(0, 120)} |`));
    L.push("", "同じコマンドをもう一度実行すると、この回だけを回し直します。", "");
  }
  if (meta.notRun && meta.notRun.length) {
    L.push(`中断したため未実行: ${meta.notRun.join("、")}`, "");
  }

  // checks summary（測定できた回だけ）
  const agg = {};
  measured.forEach(r => r.checks.forEach(c => {
    const g = agg[c.label] || (agg[c.label] = { pass: 0, fail: 0 });
    if (c.status === "pass") g.pass++; else if (c.status === "fail") g.fail++;
  }));
  const all = measured.flatMap(r => r.checks).filter(c => c.status !== "na");
  const passN = all.filter(c => c.status === "pass").length;
  L.push("## 全体", "");
  L.push(`**測定できた ${measured.length} / ${runs.length} 回で、判定 ${passN} / ${all.length} 件が合格（${(passN / Math.max(1, all.length) * 100).toFixed(1)}%）**`, "");
  L.push("| シナリオ | 内容 | 合格した回 | 不合格だった判定 |", "|---|---|---|---|");
  scenarios.forEach(sc => {
    const rs = bySc(sc.id).filter(r => !r.unmeasured);
    if (!rs.length) { L.push(`| ${sc.id} | ${sc.title} | 測定できず | — |`); return; }
    const okRuns = rs.filter(r => r.checks.every(c => c.status !== "fail")).length;
    const fails = [...new Set(rs.flatMap(r => r.checks.filter(c => c.status === "fail").map(c => c.label)))];
    L.push(`| ${sc.id} | ${sc.title} | ${okRuns} / ${rs.length} | ${fails.join("、") || "—"} |`);
  });
  L.push("");
  L.push("## 判定ごとの合格率", "");
  L.push("| 判定 | 合格 | 不合格 |", "|---|---|---|");
  Object.entries(agg).forEach(([label, g]) => { if (g.pass + g.fail) L.push(`| ${label} | ${g.pass} | ${g.fail} |`); });
  L.push("");

  const unknown = runs.flatMap(r => r.turns.filter(t => t.topic === "unknown").map(t => `${r.id}: ${t.question}`));
  if (unknown.length) {
    L.push("## 分類できなかった質問（回答者は「特にありません」と答えた）", "");
    unknown.forEach(u => L.push("- " + u));
    L.push("");
  }

  L.push("## 会話の記録", "");
  runs.forEach(r => {
    const sc = scenarios.find(s => s.id === r.id);
    L.push(`### ${r.id}（${r.run}回目）${sc.title}`, "");
    L.push(`> ${sc.first}`, "");
    r.turns.forEach((t, i) => {
      L.push(`${i + 1}. **[${lib.topicLabel(t.topic)}]** ${t.question}`);
      L.push(`    - 回答: ${t.answer}`);
    });
    if (r.result) {
      const x = r.result;
      L.push("", `- 結論: 緊急度 ${x.urgency} ／ 相談先 ${x.category}（${x.category_label}）／ 進行度 ${x.stage_band} ／ リスク ${x.inserted_risk}`);
      L.push(`- 次の一歩: ${x.advice}`);
      L.push("- 医療機関へのメモ:", "", "```", String(x.note_for_doctor || ""), "```");
    } else {
      L.push("", `- エラー: ${r.error}`);
    }
    if (r.unmeasured) { L.push("- 測定できず（採点に含めない）", ""); return; }
    const fails = r.checks.filter(c => c.status === "fail");
    L.push(fails.length ? `- 不合格: ${fails.map(c => c.label + (c.detail ? `（${c.detail}）` : "")).join("、")}` : "- 不合格: なし", "");
  });
  return L.join("\n");
}

async function main() {
  const doc = JSON.parse(fs.readFileSync(SC_PATH, "utf8"));
  let scenarios = doc.scenarios;
  if (ONLY.length) scenarios = scenarios.filter(s => ONLY.includes(s.id));

  if (REPORT_ONLY) {
    const data = JSON.parse(fs.readFileSync(RAW_PATH, "utf8"));
    fs.writeFileSync(OUT_PATH, buildReport(data), "utf8");
    console.log(`→ ${path.basename(OUT_PATH)} を作り直しました`);
    return;
  }

  console.log(`層3評価: ${scenarios.length}シナリオ × ${RUNS}回（エンドポイント: ${WORKER_URL}）`);
  if (DRY_RUN) {
    scenarios.forEach(s => console.log(`  ${s.id} [${s.respondent}] ${s.title}\n     最初の発言: ${s.first}`));
    console.log("\n（--dry-run のためAPIは呼びません）");
    return;
  }

  // 再開: 前回の結果のうち、測定できた回は再利用する（回答者の規則が同じ場合のみ）
  const previous = {};
  if (!FRESH && fs.existsSync(RAW_PATH)) {
    try {
      const saved = JSON.parse(fs.readFileSync(RAW_PATH, "utf8"));
      if ((saved.meta && saved.meta.harness) === lib.HARNESS_VERSION) {
        saved.runs.filter(r => !r.unmeasured).forEach(r => { previous[`${r.id}#${r.run}`] = r; });
        const n = Object.keys(previous).length;
        if (n) console.log(`前回の結果を再利用します: ${n}回（最初から回すときは --fresh）`);
      } else {
        console.log("回答者の規則が前回と違うため、前回の結果は使わずに回します");
      }
    } catch (e) { console.log("（前回の結果を読めなかったため、最初から回します）"); }
  }

  const runs = [];
  const notRun = [];
  let stopped = null;
  for (const sc of scenarios) {
    for (let k = 1; k <= RUNS; k++) {
      if (stopped) { notRun.push(`${sc.id}#${k}`); continue; }
      const prev = previous[`${sc.id}#${k}`];
      if (prev) {
        // 会話はそのまま使い、判定だけ現在のシナリオの想定でやり直す
        const checks = lib.evaluateRun(sc, prev);
        runs.push(Object.assign({}, prev, { checks, reused: true }));
        console.log(`  ${sc.id} ${k}回目 … 前回の結果を再利用`);
        continue;
      }
      process.stdout.write(`  ${sc.id} ${k}回目 … `);
      const run = await lib.runScenario(sc, send);
      const checks = lib.evaluateRun(sc, run);
      const fails = checks.filter(c => c.status === "fail");
      if (run.unmeasured) console.log(`測定できず: ${String(run.error).slice(0, 100)}`);
      else console.log(run.error ? `エラー: ${run.error}` : `${run.turns.length}問 → ${run.result.urgency}/${run.result.category}/${run.result.stage_band}` + (fails.length ? `（不合格 ${fails.length}）` : "（すべて合格）"));
      runs.push(Object.assign({ id: sc.id, run: k }, run, { checks }));
      if (run.fatal) stopped = run.error;
    }
  }
  const data = {
    meta: { worker: WORKER_URL, version: doc.version, harness: lib.HARNESS_VERSION, date: new Date().toISOString().slice(0, 16).replace("T", " "), runs: RUNS, transient: transientCount, reused: runs.filter(r => r.reused).length, notRun },
    scenarios, runs,
  };
  fs.writeFileSync(RAW_PATH, JSON.stringify(data, null, 2), "utf8");
  fs.writeFileSync(OUT_PATH, buildReport(data), "utf8");
  if (stopped) {
    console.log(`\n待っても回復しないエラーのため中断しました: ${String(stopped).slice(0, 160)}`);
    console.log("上限などを見直したあと、同じコマンドをもう一度実行すると続きから回します。");
  }
  console.log(`\n→ ${path.basename(OUT_PATH)} / ${path.basename(RAW_PATH)} を出力しました`);
}

if (require.main === module) main().catch(e => { console.error(e); process.exit(1); });
module.exports = { buildReport };
