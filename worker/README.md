# 相談ナビ用 Cloudflare Worker（Gemini APIプロキシ）

`consult.html`（AI相談ページ）から呼び出される最小プロキシです。

## 役割

- **APIキーの秘匿**: Gemini APIキーはこのWorkerの環境変数（secret）にのみ置き、
  フロントエンドやリポジトリには一切含めません。
- **安全制約の固定**: 「診断しない・薬剤を提案しない・最大8問・緊急時は打ち切り」等の
  システムプロンプトをWorker側に持つため、フロント改ざんでは制約を外せません。
- **進行度評価型問診エンジン**（北川設計書）: 本人/家族の確認 → 4段階問診 →
  内部でのFASTステージ相当の推定（利用者向け文章への記載はプロンプトで禁止）と
  危険兆候（せん妄/BPSD/歩行変化/頭部打撲）の差し込み質問を実装しています。
- **緊急度判定の二段階化**: リポジトリ直下の `triage.js`（フロントと共通の語彙表）を
  import し、緊急語／要確認語をサーバ側でも独立に判定します。
  要確認語しか無いのにAIが `emergency` を返した場合は、結論を破棄して確認質問1問に
  差し替えます（`enforceConfirmationBeforeEmergency`）。緊急語に該当する場合と
  質問上限（`force_done`）のときは従来どおり結論をそのまま通すため、
  緊急の見落としにはならず、判断が1問ぶん遅れるだけになります。
- **出力形式の強制**: Gemini の `responseSchema` で応答JSONの形を強制します。
- **プライバシー**: 相談本文はGemini APIへの転送にのみ使い、保存やログ出力は行いません。
- **CORS**: `https://iwatas-hub.github.io` と `http://localhost` / `http://127.0.0.1` のみ許可。
- **簡易レート制限**: 同一IPあたり1日50リクエスト（アイソレート内メモリの簡易実装。
  厳密化する場合は Workers KV / Durable Objects へ — コード内TODO参照）。

## 使用モデル

`gemini-3.7-flash`（安定版・`generateContent` / 構造化出力対応）。

| 項目 | gemini-3.1-flash-lite（旧） | gemini-3.7-flash（現行） |
|---|---|---|
| 入力 | $0.25 / 1M tokens | $0.75 / 1M tokens（2026-12-31まで。以降 $1.50） |
| 出力 | $1.50 / 1M tokens | $3.75 / 1M tokens（2026-12-31まで。以降 $7.50） |
| 思考レベル既定 | minimal | medium（low / medium / high から選択可） |
| 無料枠 | あり | あり |

- **変更理由**: flash-lite は思考レベル既定が minimal で、「ふらふらする」（歩行の不安定さ）と
  「意識がもうろう」（意識の障害）のような日本語の機微を取り違えやすく、緊急度が過剰に
  振れる原因になっていたため。
- **コストの目安**: システムプロンプトが約9,300文字（≒7kトークン）あり、これが毎回の
  入力の大半を占めます。1相談＝質問8問＝8リクエストとして、
  入力 約60kトークン・出力 約6kトークン（思考トークン込み）で **約 $0.07（10円前後）**。
  flash-lite ではおおむね $0.02（3円）程度だったため **3〜4倍** になります。
  1日50リクエスト/IPの簡易レート制限がかかっているため、1IPが上限まで使っても
  **1日 $0.45 程度**が上限です。
  なお同一のシステムプロンプトが毎回先頭に来るため、Gemini の暗黙的キャッシュが
  効けば入力ぶんの実費はこれより下がります。
- **レート制限**: Gemini APIの無料枠の具体的なRPM/RPDはドキュメントに固定表が無く、
  プロジェクトごとに [AI Studio のレート制限画面](https://aistudio.google.com/rate-limit)
  で確認する必要があります（Flash系は無料枠が残っていますが、Proは2026-04-01より有料のみ）。
  429（quota exceeded）が出る場合はWorkerがエラー本文の要点をフロントまで返すため、
  画面の「詳細:」表示で判別できます。
- **temperature を送らない**: Gemini 3系では `temperature` / `top_p` / `top_k` を
  既定値のまま使うことが推奨されている（低い温度は応答の劣化・ループの原因になる）ため、
  `generationConfig` から外しています。
- **モデルの実在確認**: 手元でAPIキーを使って確認する場合は次のコマンドで
  `gemini-3.7-flash` が `generateContent` 対応として並ぶことを確認できます。

```sh
curl -s -H "x-goog-api-key: $GEMINI_API_KEY" "https://generativelanguage.googleapis.com/v1beta/models" | grep -A2 'gemini-3.7-flash'
```

## デプロイ手順

前提: Node.js がインストール済みであること（wrangler は npx で都度実行するので
グローバルインストール不要）。

```sh
cd worker

# 1. Cloudflareアカウントにログイン（ブラウザが開きます）
npx wrangler login

# 2. Gemini APIキーをsecretとして登録（プロンプトにキーを貼り付ける）
#    キーは https://aistudio.google.com/apikey で取得
npx wrangler secret put GEMINI_API_KEY

# 3. デプロイ
npx wrangler deploy
```

デプロイ完了時に表示されるURL（例: `https://kyoto-ninchisho-consult.<account>.workers.dev`）を
控えてください。

## フロントエンドの切り替え

`consult.html` の `<script>` 冒頭にある `CONFIG` を編集します:

```js
const CONFIG = {
  WORKER_URL: "https://kyoto-ninchisho-consult.<account>.workers.dev",  // ← デプロイ先URL
  MOCK: false                                                            // ← falseで本番AIに切替
};
```

`MOCK: true` のままなら Worker を呼ばず内蔵ダミー応答で動作します（開発・デモ用）。

## ローカルでの動作確認（任意）

```sh
cd worker
npx wrangler dev
# → http://localhost:8787 で起動。consult.html の WORKER_URL に設定すればローカル検証できる
#   （CORSは localhost を許可済み）
```

## API仕様

- `POST /` — リクエスト:
  `{"messages": [{"role": "user|assistant", "content": "..."}], "force_done": false, "triage": {"caution": ["gait"], "mild": true}}`
  - `triage`（任意）: フロント側の語彙判定で見つかった**要確認語のタグ名のみ**。
    既知のタグ以外は無視され、自由文字列は一切通しません（プロンプトインジェクション対策）。
    Worker側でも同じ `triage.js` で独立に判定するため、これはあくまで補助です。
- レスポンス: consult.html と共有しているJSON契約（`phase` / `next_question` / `result`）
- `result` には従来のフィールドに加え、進行度評価型問診エンジンの内部データが含まれる:
  - `respondent`: `"self" | "family"`（回答者種別）
  - `stage_estimate`: `{ "fast": "3|4|5|6-7|unknown", "confidence": "low|medium|high", "basis": "..." }`
  - `stage_band`: `"early" | "moderate" | "severe" | "unknown"`（fast 3-4=early / 5=moderate / 6-7=severe）
  - `inserted_risk`: `"none" | "delirium" | "bpsd" | "inph" | "head_injury"`
    （差し込み質問で確認したリスク）
  - `stage_note`: 進行度の目安（FAST・確からしさ・根拠・参考推定の注記）の記載欄。
    **進行度情報はこのフィールドにのみ入り**、`note_for_doctor` は事実の整理のみ
    （プロンプトで禁止＋フロント側でも保険の行解析で分離）。フロントは
    `note_for_doctor` を本体、`stage_note` を折りたたみに描画する
  - これらは**利用者向けUIに描画しない**内部データ（`stage_band` は地図リンクの
    `?stage=` にのみ使用。詳細はリポジトリ直下の README を参照）
- エラー時: `{"error": "..."}` を 4xx/5xx で返す

## テスト

依存パッケージ不要（Node標準の `node:test`）。リポジトリ直下で実行します。

```sh
node --test "test/*.test.js"
```

`test/worker-guard.test.js` は `globalThis.fetch` を差し替えてGemini APIをスタブするため、
APIキーもネットワークアクセスも不要です。`worker/package.json` は Node から
`worker.js` を ESM として読み込めるようにするためのものです（依存パッケージはありません）。

デプロイ前のバンドル確認（`../triage.js` の取り込みを含む）:

```sh
npx wrangler deploy --dry-run --outdir=/tmp/worker-dryrun
```
