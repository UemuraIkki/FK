# コントリビューションガイド

本プロジェクト（FK）における開発手順、テスト実行方法、および変更時の確認事項を定めます。

## 開発環境の前提

継続的インテグレーション（CI: `.github/workflows/ci.yml`）の検証対象環境は以下の2ジョブです。

- Python 3.12（`python-test` ジョブ）
- Node.js 22（`web-test` ジョブ）

## 環境構築と実行手順

### リポジトリのクローン

```bash
git clone https://github.com/UemuraIkki/FK.git
cd FK
```

### Python環境（`knuckleball.py`）

```bash
# 仮想環境の作成と有効化（リポジトリルート FK/ で実行）
python3 -m venv .venv
source .venv/bin/activate

# 依存パッケージの導入（リポジトリルート FK/ で実行）
python -m pip install -r requirements.txt

# 動作確認（高速プリセット実行）（リポジトリルート FK/ で実行）
python knuckleball.py --quick
```

### Web環境（Flight Lab）

本Webアプリケーションはブラウザが直接静的モジュールを読み込む構成のため、ビルド工程および追加のパッケージ導入（`npm install`）は不要です。

```bash
# ローカルHTTPサーバーの起動（ポート8765）（リポジトリルート FK/ で実行）
npm run serve
# または直接 Python サーバーを起動
# python3 -m http.server 8765 --bind 127.0.0.1 --directory web/dist

# ブラウザで http://127.0.0.1:8765/ を開く
```
※ 3D CFDタブの実行には、WebGPU対応ブラウザおよび安全なコンテキスト（HTTPSまたはlocalhost/127.0.0.1）が必要です。

## テストの実行

コード変更時は、PythonおよびNode.jsの自動テストを必ず実行してください。

```bash
# Python単体テスト（7項目）（リポジトリルート FK/ で実行）
python -m unittest -v

# Webロジック・数値処理テスト（31項目）（リポジトリルート FK/ で実行）
npm test
# または個別に実行
# node web/test-physics.mjs
# node --test web/test-cfd.mjs web/test-flow.mjs web/test-flight-view.mjs
```

### WebGPU実機での検証

CIで実行されるNode.jsテストとは別に、WebGPUシェーダーおよびデバイスパイプラインの動作確認はブラウザで行います。サーバーを起動した状態で `http://127.0.0.1:8765/cfd-validation.html` を開き、全項目がパスすることを確認してください。

## 変更時の確認事項（チェックリスト）

プルリクエストを作成する前に、以下の項目を確認してください。

1. **自動テストの通過**: `python -m unittest -v` および Node.js テスト（`npm test`）の全ケースが成功すること。
2. **モデル前提の整合性確認**:
   - Python版（初期ボール中心高さ 0.35 m 固定、2次元LBM層流後流＋経験的3次元無回転飛翔）と、Web版（初期底面 0 m 基準、スピン＋RK4飛翔モデル、独立したWebGPU固定条件非定常粗格子LES）は設計目的と計算モデルの前提が異なります。コードを変更する際は、それぞれのモデル前提および既存テスト（`test_knuckleball.py`、`test-physics.mjs` 等）との整合性を確認すること。
3. **参照データおよび構成の整合性確認**:
   - `web/dist` の静的ファイル群や参照データ（`calibration.json`、`wake.bin`）を変更・再構成する際は、依存するテストや動作要件との整合性を確認すること。
4. **文書と記述の厳密性**:
   - 検証可能な事実のみを記述すること。未検証の高レイノルズ数での空力精度、抗力危機の完全な解像、またはサロゲートモデルの万能性を主張しないこと。
   - ローカル環境の絶対パス（`/path/to/...` など）や秘密情報をコミットに含めないこと。
