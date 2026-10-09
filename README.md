# FK: サッカーボール後流と飛翔シミュレーション

FKは、無回転サッカーボール（ブレ球）の空気力学的後流と3次元飛翔挙動を数値的に探求・可視化するプロジェクトです。本リポジトリには、単一スクリプトで完結するPython数値シミュレーションと、ブラウザ上で動作する対話型Webアプリケーション（Flight LabおよびWebGPU 3D CFD）の2つの独立した実装が含まれています。

GitHubリポジトリ: [https://github.com/UemuraIkki/FK](https://github.com/UemuraIkki/FK)

## プロジェクト構成と物理モデルの区別

本プロジェクトは目的と対象に応じた2つの実装から構成されており、それぞれの初期条件および計算モデルは明確に区別されています。

| 項目 | Python版 (`knuckleball.py`) | Web版 Flight Lab (`web/`) |
| --- | --- | --- |
| **主目的** | バッチ処理による2次元後流計算・同定・3次元軌道積分と動画出力 | ブラウザ上での対話的パラメータ調整・軌道表示およびWebGPU固定条件3D CFD |
| **流体計算** | 2次元円柱 D2Q9 BGK（低レイノルズ数 $\text{Re}=86.4$） | 固定条件の非定常3D流れ D3Q19 WebGPU（平滑球、粗格子LES） |
| **飛翔計算** | 3次元RK45（SciPy、無回転、経験的抗力危機＋低周波剥離揺らぎ） | 3次元固定刻みRK4（スピン、マグヌス力、スピン依存後流減衰） |
| **初期高度** | **ボール中心高さ 0.35 m 固定**（底面地上高 0.24 m） | **ボール底面 0 m 基準**（中心高さ＝半径＋蹴り出し高さ） |
| **スピン** | なし（無回転ブレ球固定、マグヌス力なし） | あり（$-24 \sim +24$ 回転/s、回転軸可変） |
| **連成形態** | 流体計算から後流周波数を抽出して飛翔に適用（非連成） | 飛翔軌道から特定時刻の対気速度・回転を切り出して固定条件で非定常3D流れを計算（双方向連成なし） |
| **実行環境** | Python 3.12（NumPy, SciPy, Matplotlib, Pillow） | 静的ES Modules（ビルド不要、ブラウザ直接実行） |

### 1. Pythonシミュレーション（`knuckleball.py`）

外部データを必要としない単一ファイルの自己完結スクリプトです。固定された非対称縫合線を持つ円柱周りの層流後流を2次元格子ボルツマン法（LBM）で解き、得られた抗力・揚力から渦放出周波数を同定します。その周期変動に3次元球体のロジスティック抗力危機モデルと低周波のオルンシュタイン＝ウーレンベック過程による剥離揺らぎを組み合わせ、無回転球の3次元軌道を積分します。詳細な数理モデルと検証基準は [docs/python.md](docs/python.md) にまとめています。

### 2. Web版 Flight Lab（`web/dist/`）

ブラウザのみで動作する対話型シミュレーションです。ボールの底面地上高（初期値 0 m）、初速、蹴り上げ角度、スピン量、風向・風速などを動的に調整しながら、固定刻みRK4による3次元軌道をリアルタイムに描画します。

`web/dist` ディレクトリはビルド成果物ではなく静的なソースコードであり、トランスパイルやバンドル作業を行わずに直接ブラウザへ読み込まれます。同ディレクトリ内の `calibration.json`（後流同定データ）および `wake.bin`（2次元渦度参照データ）は実行に必要な静的資産です。

さらに `flow.html` では、WebGPUを用いたD3Q19格子ボルツマン法（スマゴリンスキーLES）により、飛行中の選択時刻の条件（対気速度・回転）を固定して非定常3D気流場を粗格子で解きます（移動する球体との双方向連成計算ではありません）。詳細な仕様と制約は [web/README.md](web/README.md) を参照してください。

## クイックスタート

本プロジェクトのCI（継続的インテグレーション: `.github/workflows/ci.yml`）は、Python 3.12（`python-test` ジョブ）および Node.js 22（`web-test` ジョブ）の2つのジョブで構成されています。

```bash
# リポジトリのクローンと移動
git clone https://github.com/UemuraIkki/FK.git
cd FK
```

### Pythonシミュレーションの実行

`requirements.txt` に記載された依存パッケージ（NumPy, SciPy, Matplotlib, Pillow）を導入して実行します。

```bash
# 仮想環境の作成とパッケージ導入（リポジトリルート FK/ で実行）
python3 -m venv .venv
source .venv/bin/activate
python -m pip install -r requirements.txt

# 高速プリセットでの実行（240x120セル、48,000ステップ）（リポジトリルート FK/ で実行）
python knuckleball.py --quick

# ヘッドレス実行でGIF動画を出力（Pillowを使用）（リポジトリルート FK/ で実行）
python knuckleball.py --quick --no-show --save output/knuckleball.gif

# MP4動画の出力（PATH上にffmpegが必要）（リポジトリルート FK/ で実行）
python knuckleball.py --no-show --save output/knuckleball.mp4

# 単体テストの実行（数値不変量7項目）（リポジトリルート FK/ で実行）
python -m unittest -v
```

### Webアプリケーションの実行

リポジトリルートの `package.json` にスクリプトが定義されており、追加のパッケージ導入（`npm install`）不要でローカルサーバーを起動できます。

```bash
# 静的HTTPサーバーの起動（リポジトリルート FK/ で実行）
npm run serve
# または直接 Python サーバーを起動
# python3 -m http.server 8765 --bind 127.0.0.1 --directory web/dist
```

サーバー起動後、ブラウザで `http://127.0.0.1:8765/` を開いてください。
※ 3D CFDタブの実行には、WebGPU対応ブラウザおよび安全なコンテキスト（HTTPSまたはlocalhost/127.0.0.1）が必要です。

### テストと検証

```bash
# Python単体テスト（リポジトリルート FK/ で実行）
python -m unittest -v

# Webロジック・数値処理テスト（リポジトリルート FK/ で実行）
npm test
# または個別に実行
# node web/test-physics.mjs
# node --test web/test-cfd.mjs web/test-flow.mjs web/test-flight-view.mjs
```

> **検証範囲に関する注意**: 自動CIテストでは、軌道積分の数値精度、格子換算、座標系変換、および模擬ソルバーによるライフサイクル管理を検査します。一方、3D CFDタブ（WebGPU）のシェーダー実行および実機描画パイプラインは、ブラウザから `http://127.0.0.1:8765/cfd-validation.html` を開いて別途確認します。

## モデルの限界と解像範囲

本プロジェクトのシミュレーションは教育および可視化を目的とした近似モデルであり、実球の空力特性に対する厳密な実験検証モデルではありません。

1. **レイノルズ数と次元の不一致**: Python版のLBM計算は2次元・低レイノルズ数（$\text{Re}=86.4$）であり、3次元乱流遷移や後流の3次元縦渦構造を解像していません。球の抗力危機と不規則横力は経験的数式による補完です。
2. **粗格子LESの性質**: Web版のWebGPU 3D CFDは平滑球を対象とする粗格子LES（球直径16セル）であり、縫合線の微細形状や境界層遷移は解像されていません。数式上のレイノルズ数を高めても、高レイノルズ数の乱流現象が物理的に正しく再現されるわけではありません。
3. **非連成計算**: いずれの実装も、飛行中の球体の運動と流体計算が互いに影響を及ぼし合う双方向連成（Moving-boundary CFD）は行っていません。

## ドキュメント一覧

- [docs/python.md](docs/python.md): Pythonシミュレーションの数理モデル、境界条件、単位換算、およびCLI詳細仕様
- [web/README.md](web/README.md): Web Flight LabのUI操作、RK4飛行モデル、WebGPU D3Q19数値解法、および検証手順
- [CONTRIBUTING.md](CONTRIBUTING.md): 開発・テスト手順およびコード変更時の確認チェックリスト

## 参考文献

- [Zou and He: LBM pressure/velocity boundary conditions and bounce-back](https://arxiv.org/abs/comp-gas/9611001)
- [Latt et al.: accuracy and stability of velocity boundaries](https://doi.org/10.1103/PhysRevE.77.056703)
- [Asai et al.: soccer-ball critical Reynolds numbers and roughness effects](https://www.jstage.jst.go.jp/article/jjpehss/52/1/52_3/_article/-char/en)
- [Mizota et al.: measured irregular soccer-ball flight and 3D wake behavior](https://doi.org/10.1038/srep01871)
