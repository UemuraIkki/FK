# Knuckleball: LBM wake and 3D flight

`knuckleball.py` is a self-contained NumPy/SciPy/Matplotlib simulation. It computes a seamed cylinder wake using D2Q9 BGK, extracts forces at every step, fits a Fourier wake surrogate, integrates a non-spinning soccer ball's flight with RK45, and produces an animated dashboard.

## Run

```bash
python3 -m venv .venv
source .venv/bin/activate
python -m pip install -r requirements.txt
python knuckleball.py --quick
```

The quick preset uses 240×120 cells and 48,000 steps, with the first 24,000 discarded for calibration. The default uses 400×200 cells and 60,000 steps. Both precompute the flow and fit before opening the animation; progress and estimated remaining time appear in the terminal. Runtime depends on the CPU and NumPy build.

```bash
# Headless simulation and GIF export
python knuckleball.py --quick --no-show --save output/knuckleball.gif

# Default resolution, MP4 export (install ffmpeg separately)
python knuckleball.py --no-show --save output/knuckleball.mp4

# More wake development and a longer calibration window
python knuckleball.py --steps 100000 --warmup 45000

# Numerical invariant tests
python -m unittest -v
```

`--output output/name` selects the prefix for the PNG dashboard, compressed NPZ arrays, JSON configuration/diagnostics, force CSV, and trajectory CSV. `--no-show` selects Matplotlib's Agg backend. GIF export needs Pillow; MP4 export checks for ffmpeg before starting the solver. `--help` lists controls, including launch speed/elevation, seam depth/angle, grid size, relaxation time, and empirical force gains. Angles for the seams are radians; launch elevation is degrees.

## What is resolved and what is modeled

The requested combination of a small grid, low Mach number, τ=0.53–0.6, and resolved Re≈10⁴–10⁵ is inconsistent. For BGK,

```text
nu_LB = (tau - 0.5)/3
Re_LB = U_LB D_LB / nu_LB
Ma_LB = sqrt(3) U_LB
```

The default is Re=86.4 and inlet Ma=0.0416. A units conversion cannot change Reynolds number. At τ=0.53 and U=0.024, resolving Re=100,000 would require a ball diameter of approximately 41,667 lattice cells. A 2D cylinder also cannot reproduce the turbulent boundary-layer transition and longitudinal vortices of a 3D soccer ball.

This implementation therefore uses two explicit components:

1. **Resolved 2D flow.** The actual BGK wake develops behind a stationary, asymmetrically perturbed circle. The inlet uses Zou–He velocity reconstruction followed by boundary-only second-moment regularization to control kinetic modes at small τ. It preserves the reconstructed density, momentum, and non-equilibrium stress; the interior collision remains plain BGK. The outlet extrapolates incoming populations with zero normal gradient, and the top and bottom are periodic. Cut links use halfway bounce-back, with obstacle force `F = sum_links 2 f_i_post_collision c_i`. Cylinder coefficients use `0.5 rho_LB U_LB² D_LB` per unit span. Seams are exaggerated to remain visible on the grid; the curved surface is rasterized, with a staircase location error. The force extraction itself is not randomized.
2. **Empirical high-Re flight.** A spectrum and least-squares fit identify the resolved lift frequency, three harmonics, and force amplitudes. Physical wake phase advances with `ds/dt = speed / ball_diameter`. A logistic sphere drag crisis, transition lag, seeded slow separation wandering, and a moving transverse force direction represent the unresolved 3D physics. Their gains and timescales are assumptions. The sphere drag mean is not the cylinder drag mean. The default physical critical Reynolds number is 300,000; `--critical-re` changes it independently of the CFD.

Sphere drag is `Cd = [(1-h) Cd_sub + h Cd_super] exp(g_drag delta_Cd_LB)`, where `dh/dt = (h_equilibrium(Re,t)-h)/transition_time`. The equilibrium fraction is a logistic function of Reynolds number with a slowly varying transition threshold. The fitted high-frequency lift and an additional slow wandering term determine the sphere side coefficient. Setting `--wander-strength 0` removes the empirical slow lift wandering; `--lift-gain 0` removes all transverse forcing. `BallConfig` exposes the remaining closure parameters.

The slow forcing is sampled once using an exact discrete Ornstein–Uhlenbeck update, then interpolated at RK45 evaluation times. No random numbers are drawn inside the ODE. The same seed therefore defines the same force realization regardless of solver stage/rejection history. The lateral force is perpendicular to instantaneous velocity and does no work. There is no imposed spin, Magnus term, or two-way coupling to a moving CFD obstacle.

The 30 m flight terminates at the target plane or when the bottom of the ball touches the ground. A second integration using the same drag model with no side force provides a reference. Lateral axes are enlarged and labeled; the coordinates are actual ODE output. A finite-mass ball responds with smooth changes of curvature rather than sharp corners.

## Units and interpretation

The geometric/time correspondence is `dx = D_ball/D_LB` and `dt = U_LB dx/V_reference`. It matches the diameter and convection time, but the corresponding CFD viscosity `nu_LB dx²/dt` is much larger than air's physical viscosity. Both values and both Reynolds numbers are recorded in JSON. The physical trajectory uses `rho=1.225 kg/m³`, `nu=1.5e-5 m²/s`, `D=0.22 m`, `m=0.43 kg`, and sphere area `pi D²/4`.

Flow and flight animations have separate, labeled clocks: the post-warmup training CFD record and the full trajectory each span the movie. The animation does not suggest simultaneous, moving-ball CFD. Vorticity is `dv/dx-du/dy`, displayed as `omega D/U`; the obstacle and its one-cell derivative stencil are masked. Quivers show velocity divided by inlet speed.

The code rejects nonfinite populations, density outside [0.8,1.2], or sampled local Mach ≥0.1, rather than silently stabilizing bad data. The local-Mach check runs every 100 steps. Short or weak shedding records cannot produce a fabricated surrogate; the fit either fails or emits a provisional-calibration warning with cycle count, lift R², and amplitude-stationarity information. Startup force spikes are saved but excluded from the fit and plotted calibration window.

These are educational simulations, not validated soccer-ball predictions. Periodic blockage, seam resolution, outlet distance, and force statistics need grid/domain/time-convergence studies before quantitative use. Predicting a particular ball's drag crisis and irregular flight requires suitable 3D transition/turbulence modeling or measured force data.

## Sources

- [Zou and He: LBM pressure/velocity boundary conditions and bounce-back](https://arxiv.org/abs/comp-gas/9611001).
- [Latt et al.: accuracy and stability of velocity boundaries](https://doi.org/10.1103/PhysRevE.77.056703).
- [Asai et al.: soccer-ball critical Reynolds numbers and roughness effects](https://www.jstage.jst.go.jp/article/jjpehss/52/1/52_3/_article/-char/en).
- [Mizota et al.: measured irregular soccer-ball flight and 3D wake behavior](https://doi.org/10.1038/srep01871).
