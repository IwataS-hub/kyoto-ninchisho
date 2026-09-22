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

  /* ===== 活用形の機械展開 =====
     評価セットで「ろれつが回りません」「手足が動かしにくく」が緊急語として
     検出されなかった（層1で見落とし2件）。原因は正規表現をプレーン形の否定
     （〜ない）だけで書いていたこと。個別に列挙すると同じ穴を繰り返すため、
     動詞の語幹から活用形を機械的に展開する。

     語幹の3系統:
       mizen  「〜ない」に続く形（未然形）      例: 回ら / 動か / 応じ / し
       renyou 「〜ません」「〜にくい」に続く形  例: 回り / 動き / 動かし / 応じ / し
       te     「〜ていません」に続く形（テ形の語幹）例: 回っ / 動い / 応じ / し
     新しい緊急語を足すときは、リテラルを並べるのではなく VERBS に語幹を足して
     negated() で展開すること。 */
  const VERBS = {
    mawaru:    { mizen: ["回ら", "まわら"], renyou: ["回り", "まわり"], te: ["回っ", "まわっ"] },
    ugoku:     { mizen: ["動か"], renyou: ["動き"], te: ["動い"] },
    ugokasu:   { mizen: ["動かさ"], renyou: ["動かし"], te: ["動かし"] },
    ugokaseru: { mizen: ["動かせ"], renyou: ["動かせ"], te: ["動かせ"] },
    agaru:     { mizen: ["上がら", "あがら"], renyou: ["上がり", "あがり"], te: ["上がっ", "あがっ"] },
    hairu:     { mizen: ["入ら"], renyou: ["入り"], te: ["入っ"] },
    oujiru:    { mizen: ["応じ"], renyou: ["応じ"], te: ["応じ"] },
    suru:      { mizen: ["し"], renyou: ["し"], te: ["し"] },
    okiru:     { mizen: ["起き"], renyou: ["起き"], te: ["起き"] },
    samasu:    { mizen: ["覚まさ", "さまさ"], renyou: ["覚まし", "さまし"], te: ["覚まし", "さまし"] },
    modoru:    { mizen: ["戻ら"], renyou: ["戻り"], te: ["戻っ"] },
    deru:      { mizen: ["出"], renyou: ["出"], te: ["出"] },
    dekiru:    { mizen: ["でき", "出来"], renyou: ["でき", "出来"], te: ["でき", "出来"] },
    shaberu:   { mizen: ["しゃべれ", "喋れ", "話せ"], renyou: ["しゃべれ", "喋れ", "話せ"], te: ["しゃべれ", "喋れ", "話せ"] }
  };

  /** 動詞の語幹から「否定・困難」を表す活用形をすべて展開する（正規表現の断片を返す）。 */
  function negated(stems) {
    const alts = [];
    const push = a => { if (alts.indexOf(a) === -1) alts.push(a); };
    (stems.mizen || []).forEach(function (s) {
      push(s + "ない");     // 回らない
      push(s + "なく");     // 回らなくなった
      push(s + "なかっ");   // 回らなかった
      push(s + "ず");       // 回らず
    });
    (stems.renyou || []).forEach(function (s) {
      push(s + "ません");   // 回りません
      push(s + "にく");     // 回りにくい / 動かしにくく
      push(s + "づら");     // 回りづらい
      push(s + "ずら");     // 表記ゆれ
    });
    (stems.te || []).forEach(function (s) {
      push(s + "ていません");
      push(s + "ていない");
      push(s + "てません");
      push(s + "てない");
    });
    return alts.join("|");
  }

  /** 正規表現の断片を | でつないで RegExp にする（読みやすさのため） */
  function alt() {
    return new RegExp(Array.prototype.slice.call(arguments).join("|"));
  }

  // 症状の主語に付く助詞。「ろれつも普通です」のような否定の答えで発火しないよう、
  // 助詞だけを緩くし、述語は必ず否定・困難の活用形を要求する。
  const P = "(が|は|も)?";

  /**
   * 語彙表。
   *   kind      : "emergency"（緊急語） / "caution"（要確認語）
   *   negatable : false のとき否定による抑制を適用しない
   *               （「意識がない」のように語そのものが否定形で成立する表現）
   *   label     : 利用者向けではなく、AIへのヒント・ログ用の短いラベル
   */
  const TERMS = [
    // ===== 緊急語（それ自体で緊急性が高い） =====
    // 述語は negated() で活用形（〜ない / 〜ません / 〜にくい / 〜ていません）を
    // 機械展開している。いずれも語そのものが否定形で成立するため negatable:false。
    {
      id: "consciousness", kind: "emergency", label: "意識の障害", negatable: false,
      re: alt(
        "意識" + P + "(ない|ありません|なくな|遠のく|遠くなる)",
        "意識" + P + "(" + negated(VERBS.modoru) + ")",
        "意識" + P + "はっきり(" + negated(VERBS.suru) + ")",
        "意識を失", "意識不明", "意識障害", "気を失"
      )
    },
    {
      id: "drowsy", kind: "emergency", label: "意識がもうろうとしている", negatable: true,
      re: alt(
        "もうろう", "朦朧", "昏睡",
        "(うとうとして|眠り込んで)(" + negated(VERBS.okiru) + ")"
      )
    },
    {
      id: "unresponsive", kind: "emergency", label: "呼びかけに反応しない", negatable: false,
      re: alt(
        // 「反応が鈍い」は程度の表現なので要確認語（behavior-change）側で扱う。
        // ここで拾うのは反応の「有無」を示す言い方だけ。
        "反応" + P + "(ない|ありません|なくな|薄い)",
        "反応" + P + "(" + negated(VERBS.suru) + ")",
        "(呼びかけ|呼び掛け)(に|ても|には|をしても)?(" + negated(VERBS.oujiru) + ")",
        "(呼んで|呼びかけて|声をかけて|大声で呼んで)も(反応|返事)" + P + "(ない|ありません|なくな)",
        "(揺すって|ゆすって|起こして|叩いて)も(" + negated(VERBS.okiru) + ")",
        "目を(" + negated(VERBS.samasu) + ")"
      )
    },
    {
      id: "seizure", kind: "emergency", label: "けいれん", negatable: true,
      re: /けいれん|痙攣|ひきつけ|引きつけ|白目をむ|白目を剥|泡を吹/
    },
    {
      id: "paralysis", kind: "emergency", label: "麻痺", negatable: true,
      re: /麻痺|まひ|片麻痺|半身不随/
    },
    {
      // 「しびれ」だけは緊急語に入れない（高齢の方には日常的な訴えで、
      // 単独では緊急とは限らないため。要確認語 numbness として扱う）
      id: "limb-weakness", kind: "emergency", label: "手足が動かない", negatable: false,
      re: alt(
        "(手|足|手足|半身|片側|右半身|左半身|体|からだ|腕|脚|指)" + P +
          "(" + negated(VERBS.ugoku) + "|" + negated(VERBS.ugokasu) + "|" +
          negated(VERBS.ugokaseru) + "|" + negated(VERBS.agaru) + ")",
        "力" + P + "(" + negated(VERBS.hairu) + ")",
        "(口|顔|表情)" + P + "(ゆがん|歪ん|ゆがみ|歪み)"
      )
    },
    {
      id: "speech-slurred", kind: "emergency", label: "ろれつが回らない", negatable: false,
      re: alt(
        "(ろれつ|呂律|舌)" + P + "(" + negated(VERBS.mawaru) + ")",
        "(ろれつ|呂律)" + P + "(おかしい|変です|変になっ)",
        "言葉" + P + "(" + negated(VERBS.deru) + ")",
        "(" + negated(VERBS.shaberu) + ")",
        "言葉が(もつれ|つっかえ)"
      )
    },
    {
      id: "breathing-stopped", kind: "emergency", label: "呼吸の異常", negatable: false,
      re: alt(
        "(息|呼吸)(を|が)?して(い)?(ない|ません)",
        "息" + P + "(" + negated(VERBS.dekiru) + ")",
        "(息|呼吸)" + P + "(止ま|とま)",
        "呼吸" + P + "(ない|ありません)"
      )
    },
    {
      id: "breathing", kind: "emergency", label: "息苦しさ", negatable: true,
      re: /息が(苦し|荒い)|呼吸が(苦し|おかし|浅い)|息切れがひど/
    },
    {
      id: "chest-pain", kind: "emergency", label: "胸の痛み", negatable: true,
      re: /胸が(痛|苦し)|胸の(痛み|圧迫)|胸を押さえ/
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
      // 形容詞は語幹で拾う（「鈍い」だけでなく「鈍くなった」「鈍かった」も含めるため）
      re: /様子がおかしい|様子が(変|違)|いつもと(違|様子が違)|ぐったり|反応が(鈍|にぶ)|ぼんやり|ぼーっと|ボーッと|ボーっと|元気が(ない|なくな|ありません)/
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
      // 「急に反応が鈍くなった」「数日前から急にぼんやり」＝ 急性の意識変化（せん妄等）で緊急。
      // 「反応が鈍い」「ぼんやり」を単独で緊急語にすると、認知症の進行に伴う
      // ゆるやかな変化（「だんだん反応が鈍くなった」）まで緊急に振れてしまうため、
      // 急性発症を示す語との組み合わせのときだけ緊急に格上げする。
      id: "acute-behavior-change", label: "急な発症＋普段と違う様子",
      all: ["acute", "behavior-change"]
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
