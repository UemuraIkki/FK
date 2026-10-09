# Flight Lab

回転数、回転軸、初速、蹴り上げ角度、風、ボールの質量・直径などを調整する日本語のWebアプリです。ブラウザだけで計算し、外部の計算APIやAPIキーは使いません。

```bash
python3 -m http.server 8765 --bind 127.0.0.1 --directory dist
# http://127.0.0.1:8765/ を開く
node test-physics.mjs
```

## 操作

- 初速は10〜50 m/s、蹴り上げ角度は0〜90°、回転数は−24〜24回転/s、左右の打ち出し角は−90〜90°で設定できます。数値入力とスライダーは同じ範囲で連動します。
- 微回転ブレ球（0.3回転/s）、無回転、カーブ、ドライブ、バックスピンをプリセットで選択できます。プリセットは蹴り方を変更し、風やボールの設定は保持します。「リセット」で全設定を初期値に戻します。
- 各パラメータはスライダーと数値入力の両方で設定できます。範囲内の値は入力中に反映され、終点・最高到達点・空力係数を再計算します。数値入力ではスライダーの刻みより細かい値も指定できます。「後流パターン」は整数で指定します。空欄や範囲外の値は計算に反映されず、Enterまたはフォーカスを外すと入力内容を確認します。Escapeで直前の有効な値に戻せます。
- 正の回転数と回転軸0°で右へ曲がります。軸+90°はバックスピン、−90°はトップスピンです。負の回転数では向きが逆転します。
- 3D表示はドラッグまたは矢印キーで回転、ホイールで拡大できます。上面・側面・ゴール正面にも切り替えられます。
- 再生、停止、再生位置、再生速度を操作できます。スマートフォンでは「パラメータを調整」で設定パネルを開きます。
- ゴール幅7.32 m、高さ2.44 mを基準に表示します。球の大きさも考慮して枠内かどうかを判定しますが、ポストとの衝突は計算しません。

## 計算モデル

`physics.js`は既存Python版の飛行モデルをJavaScriptに移植し、マグヌス力を追加したものです。固定刻み1/600秒のRK4を使い、地面または指定距離を最初に横切る時点で終了します。空間座標はxが前方、yが右、zが上です。すべてSI単位で計算します。

空気相対速度を`v_rel`、角速度を`omega`、半径を`R`とすると、回転による力の向きは`omega × v_rel`、無次元回転数は`S = R |omega × v_rel| / |v_rel|²`です。回転揚力係数には、このデモで仮定した`Cm = 0.6 S / (0.3 + S)`を使用します。後流の横力振幅には別の全回転スピンパラメータ `Sw = π D |f| / |v_rel|` を使い、`retention = exp(-ln(2) (Sw / S_half)²)`で減衰させます。`S_half = π × 0.22 × wakeHalfSpin / 25`で、`wakeHalfSpin`は25 m/s・直径22 cmにおいて横力振幅が無回転時の半分になる回転数（回転/s）です。既定値は1.8、設定範囲は0.2〜4.0です。ゼロ回転でも微回転でも同じ連続式を使います。飛行中は風を含む空気相対速度で更新します。全回転を後流減衰に使うのは経験的な仮定で、マグヌス力が0となる流れ方向の回転でも後流振幅は減衰します。これらの係数は実験に合わせたものではありません。回転軸・回転速度は飛行中一定とし、逆マグヌス効果や回転による抗力係数の直接変化は扱いません。

「ブレの半減回転数」は、回転によってブレが抑えられる速さを調整するパラメータです。0回転では常に減衰なし、基準条件で半減回転数と同じ回転数なら50%になります。「回転で残るブレ成分」は初期条件での後流横力の振幅比で、マグヌス力との比や軌道の曲がり量ではありません。後流の揺らぎが0ならOFFと表示します。

[Mizotaほか（2013）](https://pmc.ncbi.nlm.nih.gov/articles/PMC3660809/)では低回転球の不規則な飛行と三次元の縦渦の変動が調べられています。これは完全な無回転だけに限った現象ではありません。上記の減衰式と半減回転数は、この実験から同定した値ではなく、傾向を比較するための経験モデルです。実球のブレの大きさは速度や表面形状などにも依存し、ゼロ回転に近づくほど必ず増加するとは限りません。2次元のカルマン渦列と球の後流は区別します。

球の回転が揚力を生む物理的な説明は[NASAの解説](https://www1.grc.nasa.gov/beginners-guide-to-aeronautics/lift-of-a-soccer-ball/)を参照してください。本アプリの係数式がNASAの検証モデルであることを意味しません。

`calibration.json`には、既存の400×200セル、Re=86.4のLBM計算から求めたフーリエ係数と、Python版の初期パターンに対応するOU過程の標本を保存しています。初期設定の無回転軌道はPython版のRK45結果と終点で0.1 mm以内に一致することをテストします。これは移植の整合性確認であり、実球に対する予測精度ではありません。

`wake.bin`は実際に保存したLBM渦度データを縮小・量子化した参照アニメーションです。48フレーム、100×50セル、符号付き8ビット整数で、値/40が`omega D/U`、−128は障害物近傍のマスクを表します。スライダーの値を変更しても、このCFDは再計算しません。高Reの抗力危機と3次元後流変動は経験モデルです。CFDの周期近似のR²は揚力0.976、抗力0.084で、抗力変動の再現には限界があります。

対応ブラウザではWebMCPの`get_flight_simulation`と`configure_flight_simulation`を登録します。非対応ブラウザでも通常の操作には影響しません。

検証に使用したChromeではWebMCPの登録APIが提供されていなかったため、WebMCP経由の動作確認は未実施です。通常のスライダー操作、プリセット、再生、視点切り替え、CFD表示、モバイルの設定パネルはブラウザで確認しました。

## 3D CFD flow tab (2026-10)

`flow.html` receives a validated kick configuration and the playback fraction in
its URL fragment. It integrates the existing trajectory model, interpolates the
chosen flight velocity, subtracts the wind, and transforms angular velocity into
a local right-handed frame. Local +x points downstream, +z is the projection of
world up normal to the incoming air (a fallback is used for nearly vertical flow).
The selected velocity and rotation are **held fixed** during each CFD run. This is
a local condition study, not a two-way coupled moving-ball calculation.

`lbm-gpu.js` solves the actual 3D discrete kinetic equations on WebGPU:

- D3Q19, second-order equilibrium, pull streaming, second-order Hermite
  regularization of the nonequilibrium stress.
- Smagorinsky SGS closure with Cs = 0.16, filter width = one cell:
  `tau_eff = (tau0 + sqrt(tau0² + 18 Cs² sqrt(2 Pi:Pi) / rho)) / 2`.
- Staircase smooth sphere, halfway moving-wall bounce-back with
  `u_wall = omega × r`. Momentum exchange is accumulated in the diagnostics data.
- Uniform equilibrium inlet and transverse far field, zero-gradient outlet.
  Domain is 10D by 5D by 5D, sphere center 2.5D from the inlet.
- A one-time, localized 0.1% initial velocity perturbation; no imposed wake
  force or fabricated vortex pattern.
- A common population positivity factor scales only the regularized
  nonequilibrium term, preserving its zero mass and momentum. The fraction of
  limited cells is displayed. Invalid density, non-finite data or excessive
  lattice Mach number stops the run; failed results are never cached.

The SI/lattice conversion in `flow-state.js` preserves molecular Re:

```
dx = D / D_lattice
U_lattice = 0.025 U / (U + |omega| D/2)
dt = U_lattice dx / U
nu_lattice = nu dt / dx²
tau0 = 0.5 + 3 nu_lattice
omega_lattice = omega dt
```

Physical kinematic viscosity is fixed at 1.5e-5 m²/s. SGS viscosity is added to
molecular viscosity; it is not represented as a change to the requested Re.
Default sphere resolution is 16 cells (12/20 alternatives). **This is a coarse
LES of a smooth sphere**: seams, boundary-layer transition and drag crisis are
not resolved or validated. Raising Re in the equations does not establish
accuracy at that Re. Domain, grid and time convergence are not established.
Do not use this implementation as a validated soccer-ball force predictor.

The three displayed planes contain GPU-computed density and velocity. Vorticity
is a central derivative of in-plane velocity, nondimensionalized by D/U. Cells
adjacent to a solid have no displayed derivative. Pressure uses
`Cp = 2 (rho_lattice - 1) / (3 U_lattice²)`. Color scales stay fixed through time.
The playback time is **CFD development time**, independent of flight time.

GPU acceleration and an in-tab cache of the last two completed, exact-condition
runs avoid repeat computation. There is no fitted CFD field surrogate. Changes
to condition or quality mark the old result stale, and calculation can be
cancelled. `断面CSV` exports the selected computed slice and its metadata.
WebGPU availability and device/memory failures are reported explicitly.

### CFD verification

Run `node --test test-cfd.mjs` for input transfer, frame orientation, signed wind,
physical/lattice scaling at parameter extremes, and quadrature isotropy.
Open `cfd-validation.html` to run the **same GPU solver** against uniform-flow
preservation and analytical shear-wave decay along all three Cartesian axes.
The separate rotating-wall check reverses sphere rotation at Re = 200 and checks
positive drag and reversal of the momentum-exchange side force. These are
implementation tests, not experimental validation of soccer aerodynamics.

Implementation sources:
- Latt & Chopard: https://arxiv.org/abs/physics/0506157
- SGS relaxation derivation: https://docs.aerosim.io/nassu/theory/LES/subgrid.smag.html

## コード構成

ブラウザで直接ES Modulesを読み込む構成です。ビルド工程や実行時の追加パッケージは不要です。

| ファイル | 役割 |
| --- | --- |
| `dist/app.js` | 軌道画面の設定入力、再生、画面間の連携 |
| `dist/physics.js` | SI単位の飛行モデルとRK4積分。DOMから独立 |
| `dist/flight-view.js` | 軌道、空力係数、参照後流のCanvas描画 |
| `dist/flow.js` | CFD画面の操作と状態表示 |
| `dist/flow-state.js` | 設定リンク、軌道の補間、局所座標、格子単位への変換 |
| `dist/flow-runner.js` | 計算開始・中止・進捗・キャッシュ・GPU資源の解放 |
| `dist/flow-field.js` | 断面の取り出し、流速・渦度・圧力への変換、CSV生成 |
| `dist/flow-view.js` | CFD断面と軌道プレビューのCanvas描画 |
| `dist/lbm-gpu.js` | WebGPUのバッファ、パイプライン、計算呼び出し |
| `dist/lbm-shaders.js` | D3Q19の定数とWGSL計算式 |
| `dist/canvas.js` | 両画面で共有するCanvasの解像度調整 |
| `dist/cfd-validation.js` | ブラウザ上の数値検証画面 |

描画関数には、その時点の計算結果と表示条件を明示的に渡します。断面の計算とCSV出力は同じ関数を使います。`FlowRunner`は画面要素を参照せず、計算失敗・中止時にもGPU資源を解放します。実行中の設定はコピーして保持し、画面での変更と分離しています。

### 開発時の確認

```bash
node test-physics.mjs
node --test test-cfd.mjs test-flow.mjs
```

`test-flow.mjs`は3断面の渦度を解析的な速度場と比較し、SI単位とCSVの整合性を確認します。実行管理のテストでは模擬ソルバーを使い、完了・中止・初期化失敗・計算失敗・多重開始・キャッシュを検証します。実GPUでの数値検証は、従来どおり`cfd-validation.html`から実行できます。

コードの整形規則は`.prettierrc.json`で管理します。整形する場合のみ、次のコマンドを使えます。

```bash
npm exec --yes --package=prettier@3.6.2 -- prettier --write 'dist/*.js' 'test-*.mjs'
```
