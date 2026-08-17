/**
 * 京都市 認知症 相談ナビ — 危険兆候の語彙判定（共通モジュール）
 *
 * 目的:
 *   「ふらふらする」のような表現が意識障害に近いものとして扱われ、過剰に緊急側へ
 *   振れる問題への対策。従来の「単純な文字列一致で即救急バナー」をやめ、
 *   語彙を2段階に分けたうえで、否定・過去・仮定の文脈を簡易に判定する。
 *
 * 2段階の語彙:
 *   - emergency（緊急語）: それ自体で緊急性が高い表現（意識がない／反応がない／
 *     けいれん／呼びかけに応じない 等）。検知したら即座に救急バナーを表示してよい。
 *   - caution（要確認語）: 緊急かどうかが文脈次第の表現（ふらふら／転ぶ／急に／熱／
 *     頭を打った 等）。バナーは出さず、AIに確認質問を促すフラグを立てるにとどめる。
 *
 * 文脈による抑制（簡易）:
 *   - 否定  : 「熱はありません」「転んだことはありません」→ 発火させない
 *   - 過去  : 「以前倒れたことがありますが、1年前の話です」→ 現在の緊急として扱わない
 *   - 仮定/不安: 「倒れるかもしれないのが怖い」→ 現在の緊急として扱わない
 *   語そのものが否定形で意味を成す表現（「意識がない」等）は negatable:false とし、
 *   否定の抑制を適用しない（否定処理でかえって見落とすのを防ぐため）。
 *
 * 程度の表現:
 *   「少し」「たまに」「ときどき」等が近くにある場合は degree:"mild" を付ける。
 *   抑制はせず、AI側に「重症度を上げすぎない」ヒントとして渡す。
 *
 * 組み合わせ判定:
 *   単独では要確認語でも、組み合わせで緊急となるものは COMBOS で緊急に格上げする
 *   （例: 頭部打撲＋打撲後の変化）。
 *
 * 使い方:
 *   ブラウザ  : <script src="triage.js"> → window.KyotoTriage
 *   Node/Worker: require("./triage.js") / import triage from "../triage.js"
 *
 * 注意: 正規表現に後読み（lookbehind）は使わない。古いiOS Safariで
 *   SyntaxError になりページ全体が動かなくなるため。
 */
(function (root, factory) {
  "use strict";
  var api = factory();
  if (typeof module === "object" && module.exports) { module.exports = api; }
  if (root) { root.KyotoTriage = api; }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  // 文脈判定の走査幅（文字数）。改行はまたがない（別の発言・別の話題とみなす）。
  const SCOPE_AHEAD = 18;   // 語の直後（否定・過去はここで拾えることが多い）
  const SCOPE_BEHIND = 14;  // 語の直前（「以前」「少し」等）
  const HEDGE_AHEAD = 12;   // 仮定・不安はより近接した位置のみ見る

  // ---- 否定 ----
  // 「危ない」「少ない」など、否定ではない「〜ない」を先に取り除いてから判定する。
  const NOT_NEGATION = /危ない|あぶない|少ない|すくない|汚ない|きたない|情けない|勿体ない|もったいない|仕方ない|しかたない/g;
  const NEGATION_RE = new RegExp([
    "ありません", "ございません", "ありませんでした",
    "ません",              // 見られません / 変わりません
    "なくな(っ|り|る)",    // なくなった / なくなりました / なくなる
    "ない",                // 上の NOT_NEGATION を除去済みなので概ね否定
    "無い", "無し", "なし",
    "いいえ",
    // 症状を問う確認質問への「否定の答え」でよく使われる言い方
    "普通", "いつもどおり", "いつも通り", "大丈夫", "問題な", "変わりな"
  ].join("|"));

  // ---- 過去（現在の緊急ではない） ----
  // 「以前より」「昔と比べ」は現在の変化を語る表現なので過去扱いしない。
  const NOT_PAST = /以前より|以前と比べ|以前に比べ|昔より|昔と比べ|前より|前と比べ/g;
  const PAST_RE = new RegExp([
    "[0-9０-９]+\\s*(年|か月|ヶ月|カ月|かげつ)\\s*(前|ほど前|くらい前|ぐらい前)",
    "以前", "昔", "かつて", "過去に", "数年前", "何年も前", "若い頃", "当時",
    "前の話", "昔の話", "だいぶ前", "ずっと前"
  ].join("|"));

  // ---- 仮定・不安（起きていない出来事への心配） ----
  // 「よく転ぶので心配です」（実際に起きている）は抑制しないよう、
  // 「〜のが心配」「〜かもしれない」等、非現実を示す形だけを対象にする。
  const HEDGE_RE = new RegExp([
    "かもしれ", "かも知れ",
    "のでは(ない|と)", "んじゃないか", "ないかと(心配|不安|思)",
    "たらどうし", "たら怖", "たら困",
    "そうで(怖|不安|心配)", "しそうで",
    "恐れがあ", "のが(怖|心配|不安)", "のを(心配|不安)",
    "しないか(心配|不安)", "になったら", "起きたら"
  ].join("|"));

  // ---- 程度（重症度を上げすぎないためのヒント） ----
  const DEGREE_MILD_RE = new RegExp([
    "少し", "すこし", "ちょっと", "多少", "やや", "わずか", "少々",
    "たまに", "時々", "ときどき", "まれに", "稀に", "たまーに", "軽い", "軽度"
  ].join("|"));

  /**
   * 語彙表。
   *   kind      : "emergency"（緊急語） / "caution"（要確認語）
   *   negatable : false のとき否定による抑制を適用しない
   *               （「意識がない」のように語そのものが否定形で成立する表現）
   *   label     : 利用者向けではなく、AIへのヒント・ログ用の短いラベル
   */
  const TERMS = [
    // ===== 緊急語（それ自体で緊急性が高い） =====
    {
      id: "consciousness", kind: "emergency", label: "意識の障害", negatable: false,
      re: /意識が(ない|ありません|なくな|遠のく|遠くなる|はっきりしない|戻らない)|意識を失|意識不明|意識障害|気を失/
    },
    {
      id: "drowsy", kind: "emergency", label: "意識がもうろうとしている", negatable: true,
      re: /もうろう|朦朧|意識が(もうろう|朦朧)|昏睡|うとうとして起きない|眠り込んで起きない/
    },
    {
      id: "unresponsive", kind: "emergency", label: "呼びかけに反応しない", negatable: false,
      re: /反応が(ない|ありません|薄い)|反応しない|呼びかけ(に|ても)(応じない|反応しない|返事がない|反応がない)|呼んでも(反応|返事)が(ない|ありません)|揺すっても(起きない|反応がない)|起こしても起きない|目を覚まさない/
    },
    {
      id: "seizure", kind: "emergency", label: "けいれん", negatable: true,
      re: /けいれん|痙攣|ひきつけ|白目をむ|泡を吹/
    },
    {
      id: "paralysis", kind: "emergency", label: "麻痺", negatable: true,
      re: /麻痺|まひ|片麻痺/
    },
    {
      // 「しびれ」だけは緊急語に入れない（高齢の方には日常的な訴えで、
      // 単独では緊急とは限らないため。要確認語 numbness として扱う）
      id: "limb-weakness", kind: "emergency", label: "手足が動かない", negatable: false,
      re: /(手|足|手足|半身|片側|右半身|左半身|体|からだ)が(動かな|動かせな|上がらな)|力が入らな|(口|顔)が(ゆがん|歪ん)/
    },
    {
      id: "speech-slurred", kind: "emergency", label: "ろれつが回らない", negatable: false,
      re: /ろれつが(回らない|まわらない|回りにく|おかしい)|呂律が(回らない|まわらない)|言葉が出(ない|なくな)|しゃべれな|言葉がもつれ/
    },
    // 「ろれつ」「麻痺」などの語だけを緊急語にはしない。確認質問がこれらの語を含むため、
    // 利用者が「ろれつも普通です」のように否定の答えで語をなぞることがあり、
    // 単語一致だと否定の答えで緊急が発火してしまう。緊急とするのは
    // 「ろれつが回らない」のように症状として述べている形（speech-slurred）に限る。
    {
      id: "breathing-stopped", kind: "emergency", label: "呼吸の異常", negatable: false,
      re: /(息|呼吸)をして(い)?(ない|ません)|息が(止ま|できな|できません)|呼吸が(止ま|ない|ありません)/
    },
    {
      id: "breathing", kind: "emergency", label: "息苦しさ", negatable: true,
      re: /息が(苦し|荒い)|呼吸が(苦し|おかし|浅い)/
    },
    {
      id: "chest-pain", kind: "emergency", label: "胸の痛み", negatable: true,
      re: /胸が(痛|苦し)|胸の(痛み|圧迫)/
    },

    // ===== 要確認語（緊急かどうかは文脈次第） =====
    {
      id: "gait", kind: "caution", label: "歩行の不安定さ", negatable: true,
      re: /ふらふら|フラフラ|ふらつ|フラつ|よろけ|よろつ|すり足|すりあし|小刻み|歩きにく|歩行が(不安定|おかしい)|足元が(おぼつか|ふらつ)|つまず/
    },
    {
      id: "fall", kind: "caution", label: "転倒", negatable: true,
      re: /転ぶ|転ん|転び|転倒|倒れ|尻もち|しりもち/
    },
    {
      id: "head-impact", kind: "caution", label: "頭部の打撲", negatable: true,
      re: /頭を(打|ぶつけ|強く)|頭部(を)?打撲|頭部外傷|後頭部を/
    },
    {
      id: "acute", kind: "caution", label: "急な変化", negatable: true,
      re: /急に|急激|突然|きゅうに|いきなり|ここ(数日|1週間|一週間|２、?３日)|数日前から|昨日から|今朝から|一昨日から/
    },
    {
      // 「熱」単独も拾う（「熱が少しあります」等）。否定は文脈判定側で処理する。
      // 「熱心」「熱意」など発熱と無関係な語は除外する。
      id: "fever", kind: "caution", label: "発熱", negatable: true,
      re: /発熱|高熱|微熱|熱っぽ|体温が|熱(?!心|意|烈|情|狂|中でき)/
    },
    {
      id: "numbness", kind: "caution", label: "しびれ", negatable: true,
      re: /(手|足|手足|半身|顔|口|指)が?(しびれ|痺れ)/
    },
    {
      id: "behavior-change", kind: "caution", label: "普段と違う様子", negatable: true,
      re: /様子がおかしい|様子が(変|違)|いつもと(違|様子が違)|ぐったり|反応が(鈍|にぶ)い|ぼんやり|ぼーっと|ボーッと|ボーっと/
    },
    {
      id: "vomit", kind: "caution", label: "嘔吐", negatable: true,
      re: /嘔吐|吐い(た|て)|もどし(た|て)/
    }
  ];

  /**
   * 組み合わせで緊急に格上げする規則。
   * 単独では要確認語でも、同時に見られる場合は緊急として扱う。
   * （近接・順序は見ない。会話全体での共起で判定する簡易実装）
   */
  const COMBOS = [
    {
      id: "head-impact-change", label: "頭部打撲後の変化",
      all: ["head-impact", "behavior-change"]
    },
    {
      id: "head-impact-vomit", label: "頭部打撲後の嘔吐",
      all: ["head-impact", "vomit"]
    }
  ];

  /** 走査幅ぶんの前後の文字列を取り出す（改行はまたがない）。 */
  function scopeAround(text, start, end) {
    let from = Math.max(0, start - SCOPE_BEHIND);
    const nlBefore = text.lastIndexOf("\n", Math.max(start - 1, 0));
    if (nlBefore >= 0 && nlBefore >= from) from = nlBefore + 1;

    let to = Math.min(text.length, end + SCOPE_AHEAD);
    const nlAfter = text.indexOf("\n", end);
    if (nlAfter >= 0 && nlAfter < to) to = nlAfter;

    return {
      before: text.slice(from, start),
      after: text.slice(end, to)
    };
  }

  function hasNegation(s) {
    return NEGATION_RE.test(String(s).replace(NOT_NEGATION, ""));
  }
  function hasPast(s) {
    return PAST_RE.test(String(s).replace(NOT_PAST, ""));
  }
  function hasHedge(s) {
    return HEDGE_RE.test(String(s));
  }

  /**
   * 1語について、テキスト中のすべての出現位置を調べる。
   * 1か所でも「抑制されない出現」があれば発火（hit）とする。
   * すべての出現が抑制された場合は、その理由を返す。
   */
  function evaluateTerm(text, term) {
    const re = new RegExp(term.re.source, "g");
    let m;
    let found = false;
    let reason = null;
    let degree = null;

    while ((m = re.exec(text)) !== null) {
      found = true;
      if (m[0].length === 0) { re.lastIndex += 1; continue; } // 無限ループ防止
      const scope = scopeAround(text, m.index, m.index + m[0].length);
      const near = scope.before + scope.after;
      const hedgeWindow = scope.after.slice(0, HEDGE_AHEAD);

      if (term.negatable !== false && hasNegation(scope.after)) {
        reason = reason || "negation";
        continue;
      }
      if (hasPast(near)) {
        reason = reason || "past";
        continue;
      }
      if (hasHedge(hedgeWindow) || hasHedge(scope.before)) {
        reason = reason || "hedge";
        continue;
      }
      // 抑制されない出現。程度の表現が近くにあれば記録する。
      if (DEGREE_MILD_RE.test(near)) degree = "mild";
      return { hit: true, degree: degree };
    }
    return { hit: false, suppressed: found, reason: reason };
  }

  /**
   * テキストを分類する。
   * @param {string} text 判定対象（1発言でも、会話全体を改行で連結したものでもよい）
   * @returns {{
   *   emergency: Array<{id:string,label:string,via:string}>,
   *   caution:   Array<{id:string,label:string,degree:(string|null)}>,
   *   suppressed:Array<{id:string,label:string,reason:string}>,
   *   mild: boolean,
   *   emergencyTags: string[],
   *   cautionTags: string[]
   * }}
   */
  function classify(text) {
    const src = String(text || "");
    const emergency = [];
    const caution = [];
    const suppressed = [];
    const hitIds = Object.create(null);
    let mild = false;

    TERMS.forEach(function (term) {
      const r = evaluateTerm(src, term);
      if (r.hit) {
        hitIds[term.id] = true;
        if (r.degree === "mild") mild = true;
        if (term.kind === "emergency") {
          emergency.push({ id: term.id, label: term.label, via: "term" });
        } else {
          caution.push({ id: term.id, label: term.label, degree: r.degree || null });
        }
      } else if (r.suppressed) {
        suppressed.push({ id: term.id, label: term.label, reason: r.reason || "unknown" });
      }
    });

    // 組み合わせによる緊急への格上げ（該当した要確認語は caution からは外さない）
    COMBOS.forEach(function (combo) {
      if (combo.all.every(function (id) { return hitIds[id]; })) {
        emergency.push({ id: combo.id, label: combo.label, via: "combo" });
      }
    });

    return {
      emergency: emergency,
      caution: caution,
      suppressed: suppressed,
      mild: mild,
      emergencyTags: emergency.map(function (e) { return e.id; }),
      cautionTags: caution.map(function (c) { return c.id; })
    };
  }

  /** 緊急語（または緊急の組み合わせ）に該当するか。救急バナー表示の条件。 */
  function hasEmergency(text) {
    return classify(text).emergency.length > 0;
  }

  return {
    classify: classify,
    hasEmergency: hasEmergency,
    TERMS: TERMS,
    COMBOS: COMBOS,
    // 既知のタグ一覧（Worker側でフロントから来たヒントを検証するのに使う）
    EMERGENCY_TAGS: TERMS.filter(function (t) { return t.kind === "emergency"; })
      .map(function (t) { return t.id; })
      .concat(COMBOS.map(function (c) { return c.id; })),
    CAUTION_TAGS: TERMS.filter(function (t) { return t.kind === "caution"; })
      .map(function (t) { return t.id; })
  };
});
