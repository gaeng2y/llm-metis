# Jev Control

[English](README.md) · [한국어](README.ko.md) · [日本語](README.ja.md) · [简体中文](README.zh-CN.md)

**1回の Jev リクエストで Codex のツールと推論の強度（reasoning effort）を選ぶ、実験的なローカルゲートウェイ**です。パッケージ名は `jev-control`、コマンド名は `jev-codex` です。Codex で選択したモデルは変更しません。

```text
Codex → HTTP gateway → DecisionEngine → Jev (tool + effort)
                    → 独立した信頼度判定 → 既存の upstream → HTTP/SSE
                    → メタデータ・使用量 → ローカルダッシュボード
```

Node.js 22.15 以降と、インストール済みの Codex CLI が必要です。外部のランタイム依存関係はありません。当初の設計、参照コミット、実装順序、リスクは[設計提案](docs/architecture.md)、実施済みの確認とその限界は[検証記録](docs/validation.md)を参照してください。これらの文書は英語です。

## はじめに

```sh
npm install
npm run build
cp .env.example .env
chmod 600 .env
# .env に Jev のプロバイダーと対応する API キーを設定します。
npm run codex
```

ゲートウェイをバックグラウンドで起動し、Codex を実行します。ランチャーは現在の作業ディレクトリにある `.env` を読み込みます。認証情報がない場合や Jev が失敗した場合は、元のモデルリクエストを転送します。キーが未設定の場合、ダッシュボードには `Credentials: missing` と `jev_credentials_missing` が表示されます。

コマンドを PATH から利用するには、このチェックアウト内で `npm link` を実行します。グローバル登録をしなくても、以下のコマンドはすべて `node bin/jev-codex.mjs …` として実行できます。

```sh
jev-codex --start
jev-codex --status
jev-codex --dashboard
jev-codex --routing off
jev-codex --tool-routing on
jev-codex --effort-routing off
jev-codex --stop

# Codex のオプションとコマンドは -- の後に渡します。
jev-codex -- --model gpt-6-astra
jev-codex -- exec --model gpt-6-astra 'ここにタスクを記述してください'
```

ルーティングコマンドとダッシュボードの変更は、稼働中のゲートウェイが処理する次のリクエストから適用されます。再起動すると環境設定に戻ります。環境変数、認証情報、upstream URL を変更した後は、`--stop`、`--start` の順に実行してください。同じ状態ディレクトリを使うターミナルは1つのゲートウェイを共有します。独立した実験には、`JEV_STATE_DIR` と `JEV_PORT` の両方に異なる値を指定します。

## 認証と設定

CLI は `-c model_provider=…` とプロバイダー設定を、自身が起動する Codex プロセスにのみ渡します。`~/.codex/config.toml` やログインファイルは変更しません。モデルの認証と認証情報の更新は Codex が担当し、ゲートウェイは `Authorization` と `ChatGPT-Account-Id` を upstream に転送します。Jev の認証情報は、別途送信する評価リクエストにのみ使用します。

読み取り可能な Codex の `auth.json` が ChatGPT ログインを示す場合、デフォルトの upstream は `https://chatgpt.com/backend-api/codex` です。それ以外は `https://api.openai.com/v1` になります。**キーチェーンのみで認証情報を管理するログインや、カスタムプロバイダーでは `UPSTREAM_BASE_URL` を明示してください。** 稼働中のゲートウェイはログイン方式の変更に自動追従しません。

ランチャーは HTTP/SSE を使うため、その実行に限って `supports_websockets=false` を設定します。未対応の WebSocket 接続は拒否します。この CLI は、Codex デスクトップアプリの既存タスクを自動的に接続するものではありません。

| 環境変数 | デフォルト / 説明 |
|---|---|
| `JEV_PROVIDER` | キーが設定されたプロバイダーを typesafe → openrouter → vercel の順に選択。該当なしの場合は typesafe |
| `TYPESAFE_API_KEY` | TypeSafe の認証情報。デフォルトモデルは `jev-latest` |
| `OPENROUTER_API_KEY` | OpenRouter の認証情報。デフォルトモデルは `typesafe/jev-1.13` |
| `AI_GATEWAY_API_KEY` | Vercel AI Gateway の認証情報。デフォルトモデルは `typesafe-ai/jev` |
| `JEV_MODEL`, `JEV_URL` | プロバイダーのモデルと評価エンドポイントを明示的に上書き |
| `JEV_TOOL_MIN_CONFIDENCE` | `0.85` |
| `JEV_EFFORT_MIN_CONFIDENCE` | `0.85` |
| `JEV_TIMEOUT_MS` | `2000`。判断全体の待機期限。再試行なし |
| `JEV_ROUTING` | `on`。起動時に両方の判断を有効化または無効化 |
| `JEV_TOOL_ROUTING`, `JEV_EFFORT_ROUTING` | どちらも `on` |
| `JEV_DIRECT_CALLS` | `off`。制限付きの関数呼び出し合成を明示的に有効化 |
| `JEV_PORT` | `8791`。常に `127.0.0.1` のみにバインド |
| `UPSTREAM_BASE_URL` | 上記のログイン方式に応じて選択。URL 内の認証情報とクエリパラメーターは禁止 |
| `JEV_STATE_DIR` | `~/.local/state/jev-control`。ローカルトークンを含む instance ファイルの権限は 0600 |
| `JEV_CODEX_BIN` | `codex`。別の Codex 実行ファイルのパスで上書き可能 |

## 判断ポリシー

- ツールと effort のしきい値は独立しています。一方だけが十分な信頼度を持つ場合、その部分だけを変更します。どちらも不確実なら、元のバイト列をそのまま転送します。
- 呼び出し元が指定した `tool_choice=none`、`required`、特定ツール、allowed-tools の設定は維持します。effort は独立して評価できます。
- `forced` は対応する function/custom ツールの `tool_choice` を設定します。`none` は次の応答でのツール使用を無効にし、`passthrough` はツール設定を変更しません。
- `direct` には明示的な有効化と `store:false` が必要です。有限の選択肢からなる関数引数を検証し、Responses の関数呼び出しを合成します。**ゲートウェイ自体はツールを実行しません。** 自由記述の引数や未対応の JSON Schema 制約がある場合、引数の生成はメインモデルに任せます。JSON と SSE の両方に対応し、この経路では effort を適用しません。
- ツールの抽出は `additional_tools` と namespace に対応しています。hosted ツールと、デフォルトの `functions` namespace 以外のツールは候補として扱いますが、強制指定はしません。ツールが120個を超えると、2回目の Jev 呼び出しを追加せずにツールルーティングをスキップします。
- `previous_response_id`、`conversation`、opaque item reference によってサーバー側の履歴が見えないリクエストは、評価せず転送します。`configuration_update` がある場合は effort の書き換えをスキップします。`/responses/compact` も変更せず転送します。
- Jev のエラー、タイムアウト、不正な回答は元のリクエストへのフォールバックになります。upstream が書き換え後のリクエストを HTTP 400/422 で拒否した場合、元のリクエストで1回だけ再試行します。成功した応答や開始済みのストリームは再試行しません。

## データと測定

Jev には、直近の公開された会話コンテキスト、公開要約、長さを制限したツール結果の抜粋、利用可能なツール定義を渡します。画像と暗号化された reasoning 項目は除外します。**ゲートウェイはローカルで動作しますが、判断のための推論は選択した外部プロバイダーで行われます。**

プロンプト、引数、認証ヘッダー、API キーはログに記録しません。ダッシュボードは、リクエスト時点の実験モード、提案・適用されたツールと effort、信頼度、Jev のプロバイダー・モデル・遅延・使用量、upstream のトークン・キャッシュ・推論使用量、モデルと全体の遅延、結果の状態をメモリ内に保持します。生のプロンプトやプロバイダーのエラー本文は保持しません。

- 保持するのは最新2,000件のリクエストと200件のラッパーセッションです。再起動すると消去されます。
- モデル遅延は upstream リクエストの送信からストリーム終了までです。元のリクエストを再試行した場合は、両方の試行時間を含みます。
- 使用量が不明な場合はゼロではなく `—` と表示します。`*` は、一部のリクエストのみが使用量を報告したことを示します。
- direct 呼び出しの upstream トークン使用量はゼロです。Jev の使用量は別途記録します。プロバイダーの料金を検証していないため、ドル換算のコストは計算しません。
- タスク所要時間は、`jev-codex` が起動した Codex プロセスの全実行時間です。対話セッションではユーザーの待ち時間も含みます。比較には `jev-codex -- exec …` で1回につき1タスクを実行してください。セッション中にモードを変えると、タスク単位の比較の信頼性が下がります。
- ダッシュボードのトークンは URL fragment で渡した後、アドレスから削除します。制御 API とモデルプロキシの両方に、別途ローカルトークンが必要です。外部の Origin/Host ヘッダーは拒否します。

4つのモードを比較する際は、モデル、初期 effort、リポジトリの開始状態、タスクを揃え、各結果の品質も確認してください。

| モード | Tool | Effort |
|---|---|---|
| baseline | off | off |
| tool-only | on | off |
| effort-only | off | on |
| tool+effort | on | on |

baseline もゲートウェイを経由しますが、両方の判断を無効にします。HIGH を自動設定するのではなく、指定された effort を維持します。HIGH を基準にする場合は、Codex に `-c model_reasoning_effort=high` を渡してください。別途 Codex を直接実行すると、プロキシ自体のオーバーヘッドも切り分けられます。

## 検証と対応範囲

```sh
npm run typecheck
npm test
# 任意: 一時 HOME、ダミーのキー、ローカルプロバイダーでインストール済み Codex CLI を確認します。
npm run test:codex
```

テストには Node 標準のテストランナーと、ローカルの模擬プロバイダー・upstream を使います。実際の認証情報や有料推論なしで、信頼度の組み合わせ、エラー・タイムアウト時の復帰、ツールなし、呼び出し元の設定維持、認証の転送、圧縮された元リクエストの再送、SSE、プロバイダー別の型付き質問リクエスト、CLI のライフサイクル、通常設定が変更されないことを検証します。ループバックで待ち受け可能な環境が必要です。

実際の Jev 応答、ChatGPT サブスクリプションのバックエンドでの受け付け、トークン削減、長時間セッションのキャッシュ効率には、別途ライブ検証が必要です。HTTP での effort 書き換えは、[Astra-Ares](https://github.com/miuuyy/Astra-Ares) のネイティブチェックポイントと prefix 保持と同等ではありません。Lease、Codex パッチ、Laya エンジン、モデルルーティング、ツールファミリーのルーティング、MCP グルーピングは未実装です。将来、`DecisionEngine` の実装を差し替えられます。

参考: [jev-gateway](https://github.com/vinilana/jev-gateway)、[Astra-Ares](https://github.com/miuuyy/Astra-Ares)、[Codex プロバイダー設定](https://learn.chatgpt.com/docs/config-file/config-reference)。これは独立した実装です。参照リポジトリを依存関係として追加したり、コードベース全体をコピーしたりはしていません。
