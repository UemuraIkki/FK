#!/usr/bin/env python3
"""Resolved 2-D cylinder wake + empirical, non-spinning 3-D soccer-ball flight.

Install: python -m pip install numpy scipy matplotlib pillow
Run:     python knuckleball.py --quick
Batch:   python knuckleball.py --quick --no-show --output output/demo
Movie:   python knuckleball.py --quick --save output/demo.gif --no-show
MP4 requires ffmpeg on PATH; GIF uses Pillow. No external data files are needed.

PHYSICAL SCOPE
--------------
D2Q9 BGK resolves a laminar, seamed cylinder wake, NOT a turbulent sphere's
drag crisis. nu_lattice=(tau-0.5)/3, Re=U_lattice*D_lattice/nu_lattice,
Ma=sqrt(3)*U_lattice. At the defaults Re=86.4 and Ma=0.0416. Re is
dimensionless and cannot be changed by a units conversion. Resolving Re=1e5
with tau=0.53 and U=0.024 would require a diameter of about 41,667 cells.

The fitted Fourier wake supplies its measured Strouhal number, harmonics,
and fluctuation amplitudes. A separate EMPIRICAL sphere drag curve, lagged
transition, and seeded low-frequency separation wandering supply the
unresolved high-Re, 3-D physics. These empirical parameters are illustrative,
not fitted soccer-ball measurements. No rotation or Magnus term is present.

Units: dx=D_ball/D_lattice [m/cell], dt=U_lattice*dx/V_reference [s/step].
This matches diameter and reference convection time, but maps the LBM
viscosity to nu_lattice*dx**2/dt, NOT the physical viscosity of air.
LBM force is per unit span; its coefficient uses D_lattice*1, not pi*D**2/4.
The trajectory instead uses sphere area pi*D_ball**2/4 and physical air nu.
Changing flight speed advances wake phase by ds/dt=|v|/D_ball; there is no
two-way moving-boundary CFD coupling. Animation panels use independent
clocks, explicitly labeled, to compare the training wake with the flight.

References:
  Zou & He, boundary conditions: https://arxiv.org/abs/comp-gas/9611001
  Latt et al., velocity boundaries: https://doi.org/10.1103/PhysRevE.77.056703
  Mizota et al., 3-D soccer-ball wakes: https://doi.org/10.1038/srep01871
  Asai et al., drag crisis: https://doi.org/10.5432/jjpehss.52.3
"""
from __future__ import annotations

import argparse
import json
import math
import time
import warnings
from dataclasses import asdict, dataclass
from pathlib import Path

import numpy as np
from scipy.integrate import solve_ivp
from scipy.optimize import minimize_scalar
from scipy.signal import detrend, periodogram
from scipy.special import expit


# Directions: rest, E, N, W, S, NE, NW, SW, SE. Arrays use [q, y, x].
C = np.array([[0, 0], [1, 0], [0, 1], [-1, 0], [0, -1],
              [1, 1], [-1, 1], [-1, -1], [1, -1]], dtype=int)
W = np.array([4 / 9] + [1 / 9] * 4 + [1 / 36] * 4)
OPPOSITE = np.array([0, 3, 4, 1, 2, 7, 8, 5, 6])


@dataclass
class FlowConfig:
    nx: int = 400
    ny: int = 200
    diameter: float = 36.0
    u0: float = 0.024
    tau: float = 0.53
    steps: int = 60000
    warmup: int = 24000
    frames: int = 160
    seam_depth: float = 0.035  # Fraction of nominal diameter; exaggerated to resolve.
    seam_angle: float = 0.17   # Radians; fixed, non-rotating geometry.
    seed: int = 7
    flow_stride: int = 2
    quiver_stride: int = 10

    @property
    def viscosity(self) -> float:
        return (self.tau - 0.5) / 3.0

    @property
    def reynolds(self) -> float:
        return self.u0 * self.diameter / self.viscosity

    def validate(self) -> None:
        scalars = [self.diameter, self.u0, self.tau, self.seam_depth, self.seam_angle]
        if not np.all(np.isfinite(scalars)):
            raise ValueError("Flow parameters must be finite.")
        if self.nx < 80 or self.ny < 48:
            raise ValueError("Use nx >= 80 and ny >= 48.")
        if not 0.53 <= self.tau <= 0.6:
            raise ValueError("This BGK demo requires 0.53 <= tau <= 0.6.")
        if not 0 < self.u0 <= 0.03:
            raise ValueError("Use 0 < u0 <= 0.03 to leave a low-Mach margin near the ball.")
        if not 12 <= self.diameter <= min(self.ny / 4, self.nx / 10):
            raise ValueError("Diameter must be >= 12, <= ny/4, and <= nx/10.")
        if not 0 <= self.seam_depth <= 0.08:
            raise ValueError("seam-depth is a diameter fraction in [0, 0.08].")
        if self.warmup < 0 or self.steps - self.warmup < 100:
            raise ValueError("Need at least 100 post-warmup steps.")
        if self.frames < 2 or min(self.flow_stride, self.quiver_stride) < 1:
            raise ValueError("Need at least two frames and positive sampling strides.")
        if self.seed < 0:
            raise ValueError("seed must be nonnegative.")
        if self.reynolds < 55:
            warnings.warn("Re < 55: the wake may not develop useful sustained shedding.")


@dataclass
class BallConfig:
    mass: float = 0.43          # kg
    diameter: float = 0.22      # m
    air_density: float = 1.225  # kg/m^3
    air_nu: float = 1.5e-5     # m^2/s, KINEMATIC viscosity
    speed: float = 25.0        # m/s
    elevation: float = 22.0    # degrees
    height: float = 0.35       # m, ball-center height
    distance: float = 30.0     # m, target plane
    max_time: float = 8.0       # s
    critical_re: float = 3.0e5
    transition_width: float = 3.0e4
    transition_time: float = 0.075
    crisis_jitter: float = 0.14
    cd_subcritical: float = 0.48
    cd_supercritical: float = 0.20
    drag_gain: float = 0.35
    lift_gain: float = 0.55
    wander_strength: float = 1.4
    wander_time: float = 0.20

    @property
    def area(self) -> float:
        return math.pi * self.diameter**2 / 4

    def validate(self) -> None:
        if not all(np.isfinite(value) for value in asdict(self).values()):
            raise ValueError("Ball parameters must be finite.")
        for key in ("mass", "diameter", "air_density", "air_nu", "speed", "distance",
                    "max_time", "critical_re", "transition_width", "transition_time",
                    "cd_subcritical", "cd_supercritical", "wander_time"):
            if getattr(self, key) <= 0:
                raise ValueError(f"{key} must be positive.")
        if not 0 <= self.elevation < 80 or self.height <= self.diameter / 2:
            raise ValueError("Use elevation in [0,80) and initial center height > radius.")
        if min(self.lift_gain, self.drag_gain, self.wander_strength) < 0:
            raise ValueError("Force gains and wander strength must be nonnegative.")
        if not 0 <= self.crisis_jitter < 1:
            raise ValueError("crisis_jitter must lie in [0,1).")


def equilibrium(rho: np.ndarray, ux: np.ndarray, uy: np.ndarray) -> np.ndarray:
    """Second-order isothermal D2Q9 Maxwellian; cs^2 = 1/3."""
    cu = C[:, 0, None, None] * ux + C[:, 1, None, None] * uy
    return W[:, None, None] * rho * (
        1 + 3 * cu + 4.5 * cu**2 - 1.5 * (ux**2 + uy**2))


def macroscopic(f: np.ndarray) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    rho = f.sum(axis=0)
    ux = (f[1] + f[5] + f[8] - f[3] - f[6] - f[7]) / rho
    uy = (f[2] + f[5] + f[6] - f[4] - f[7] - f[8]) / rho
    return rho, ux, uy


def obstacle_mask(cfg: FlowConfig) -> np.ndarray:
    """Fixed angular grooves/ridges, rasterized as a perturbed circular cylinder.

    Bounce-back is halfway along each cut lattice link. The nominal curved
    surface is therefore represented by a staircase with O(dx) location error;
    it is not an interpolated, geometrically exact curved-wall treatment.
    """
    yy, xx = np.indices((cfg.ny, cfg.nx))
    cx, cy = 0.24 * cfg.nx, (cfg.ny - 1) / 2
    theta = np.arctan2(yy - cy, xx - cx) - cfg.seam_angle
    radius = np.full(theta.shape, cfg.diameter / 2)
    # Deliberately unequal angles/heights break reflection symmetry. Negative
    # heights represent shallow grooves; positive ones represent seam shoulders.
    angles = np.array([0.35, 1.25, 2.5, 3.55, 4.8, 5.65])
    heights = np.array([1.0, -0.65, 0.7, -0.8, 0.9, -0.5])
    for angle, height in zip(angles, heights):
        delta = np.arctan2(np.sin(theta - angle), np.cos(theta - angle))
        radius += cfg.seam_depth * cfg.diameter * height * np.exp(-0.5 * (delta / 0.11)**2)
    return np.hypot(xx - cx, yy - cy) <= radius


def zou_he_inlet(f: np.ndarray, u0: float) -> None:
    """Zou-He velocity reconstruction followed by boundary-only regularization.

    Preserve its density, momentum, and non-equilibrium second moments while
    removing higher kinetic moments at the inlet (Latt et al., PRE 77, 056703).
    This avoids amplification of inlet kinetic modes at small tau. The entire
    fluid interior still uses the unmodified, single-relaxation-time BGK rule.
    """
    rho = (f[0, :, 0] + f[2, :, 0] + f[4, :, 0]
           + 2 * (f[3, :, 0] + f[6, :, 0] + f[7, :, 0])) / (1 - u0)
    f[1, :, 0] = f[3, :, 0] + (2 / 3) * rho * u0
    f[5, :, 0] = f[7, :, 0] + 0.5 * (f[4, :, 0] - f[2, :, 0]) + rho * u0 / 6
    f[8, :, 0] = f[6, :, 0] + 0.5 * (f[2, :, 0] - f[4, :, 0]) + rho * u0 / 6
    cx, cy = C[:, 0, None], C[:, 1, None]
    cu = cx * u0
    feq = W[:, None] * rho * (1 + 3 * cu + 4.5 * cu**2 - 1.5 * u0**2)
    nonequilibrium = f[:, :, 0] - feq
    pxx = (C[:, 0]**2) @ nonequilibrium
    pxy = (C[:, 0] * C[:, 1]) @ nonequilibrium
    pyy = (C[:, 1]**2) @ nonequilibrium
    # f_i^neq = w_i/(2 cs^4) (c_i c_i - cs^2 I) : Pi^neq.
    f[:, :, 0] = feq + 4.5 * W[:, None] * (
        (cx**2 - 1 / 3) * pxx + 2 * cx * cy * pxy + (cy**2 - 1 / 3) * pyy)


class LBM:
    """NumPy-vectorized BGK with link-wise momentum exchange and periodic y.

    The only spatial-work loops are over the nine velocities (or six seams).
    There are no Python loops over cells. Both buffers are reused every step.
    """

    def __init__(self, cfg: FlowConfig, solid: np.ndarray | None = None):
        cfg.validate()
        self.cfg = cfg
        self.solid = obstacle_mask(cfg) if solid is None else np.asarray(solid, dtype=bool)
        if self.solid.shape != (cfg.ny, cfg.nx):
            raise ValueError("Solid mask shape does not match the domain.")
        if np.any(self.solid[:, :2]) or np.any(self.solid[:, -2:]):
            raise ValueError("The obstacle must be separated from inlet and outlet.")
        self.fluid = ~self.solid
        self.solid_indices = np.flatnonzero(self.solid)
        self.links = []
        for cx, cy in C:
            # True at a fluid SOURCE whose destination in direction i is solid.
            neighbor_solid = np.roll(self.solid, shift=(-cy, -cx), axis=(0, 1))
            self.links.append(np.flatnonzero(self.fluid & neighbor_solid))
        yy, xx = np.indices(self.solid.shape)
        ux = np.full(self.solid.shape, cfg.u0)
        # A tiny localized transverse perturbation only at initialization;
        # the inlet remains exactly uniform throughout the run.
        rng = np.random.default_rng(cfg.seed)
        envelope = np.exp(-((xx - 0.24 * cfg.nx - cfg.diameter) / cfg.diameter)**2
                          - ((yy - cfg.ny / 2) / cfg.diameter)**2)
        uy = cfg.u0 * 0.002 * envelope * (1 + 0.1 * rng.standard_normal(ux.shape))
        ux[self.solid] = uy[self.solid] = 0.0
        self.f = equilibrium(np.ones_like(ux), ux, uy)
        self.buffer = np.empty_like(self.f)
        self.iteration = 0

    def step(self) -> np.ndarray:
        rho, ux, uy = macroscopic(self.f)
        u2 = ux**2 + uy**2
        # Collision f_i* = f_i - (f_i - f_i^eq)/tau.
        for i, (cx, cy) in enumerate(C):
            cu = cx * ux + cy * uy
            feq = W[i] * rho * (1 + 3 * cu + 4.5 * cu**2 - 1.5 * u2)
            self.f[i] += (feq - self.f[i]) / self.cfg.tau

        # Push streaming. np.roll gives periodic y; the x wraps affect only
        # incoming populations, which are overwritten by the open boundaries.
        for i, (cx, cy) in enumerate(C):
            self.buffer[i] = np.roll(self.f[i], shift=(cy, cx), axis=(0, 1))

        force = np.zeros(2)
        for i in range(1, 9):
            outgoing = self.f[i].ravel()[self.links[i]]
            # At the same fluid source, reflect the population arriving from
            # its solid neighbor. No collision inside the solid contributes.
            self.buffer[OPPOSITE[i]].ravel()[self.links[i]] = outgoing
            # Obstacle gains +2*f_i* c_i; the fluid gains the opposite impulse.
            force += 2 * np.sum(outgoing, dtype=np.float64) * C[i]

        zou_he_inlet(self.buffer, self.cfg.u0)
        # Zero normal gradient for only the incoming W,NW,SW populations.
        # Outgoing populations retain their streamed values, avoiding x wrap.
        self.buffer[[3, 6, 7], :, -1] = self.buffer[[3, 6, 7], :, -2]
        self.buffer.reshape(9, -1)[:, self.solid_indices] = W[:, None]
        self.f, self.buffer = self.buffer, self.f
        self.iteration += 1
        return force

    def fields(self) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
        rho, ux, uy = macroscopic(self.f)
        ux[self.solid] = uy[self.solid] = 0.0
        return rho, ux, uy

    def check_stability(self) -> dict[str, float]:
        rho, ux, uy = self.fields()
        mach = np.hypot(ux[self.fluid], uy[self.fluid]).max() * math.sqrt(3)
        rmin, rmax = rho[self.fluid].min(), rho[self.fluid].max()
        if (not np.isfinite(self.f).all() or not 0.8 < rmin <= rmax < 1.2
                or not np.isfinite(mach) or mach >= 0.1):
            raise RuntimeError(
                f"LBM low-Mach/stability check failed at step {self.iteration}: "
                f"rho=[{rmin:.5g},{rmax:.5g}], Ma_max={mach:.5g}. "
                "Reduce u0, increase tau, or increase the domain/resolution. "
                "No population clipping or artificial force substitution is applied.")
        return {"max_mach": float(mach), "min_density": float(rmin), "max_density": float(rmax)}


@dataclass
class FlowResult:
    steps: np.ndarray
    forces: np.ndarray
    cd: np.ndarray
    cl: np.ndarray
    frame_steps: np.ndarray
    vorticity: np.ndarray
    quiver_u: np.ndarray
    quiver_v: np.ndarray
    solid: np.ndarray
    diagnostics: dict


def run_flow(cfg: FlowConfig) -> FlowResult:
    solver = LBM(cfg)
    frame_steps = np.unique(np.linspace(cfg.warmup + 1, cfg.steps, cfg.frames).astype(int))
    nf = len(frame_steps)
    vort_shape = solver.solid[::cfg.flow_stride, ::cfg.flow_stride].shape
    q_shape = solver.solid[::cfg.quiver_stride, ::cfg.quiver_stride].shape
    vort = np.empty((nf, *vort_shape), dtype=np.float32)
    qu = np.empty((nf, *q_shape), dtype=np.float32)
    qv = np.empty_like(qu)
    forces = np.empty((cfg.steps, 2))
    next_frame = 0
    start = last_report = time.monotonic()
    diagnostics = {"max_mach": 0.0, "min_density": 1.0, "max_density": 1.0}
    print(f"LBM: {cfg.nx}x{cfg.ny}, D={cfg.diameter:g}, tau={cfg.tau:g}, "
          f"Re={cfg.reynolds:.2f}, inlet Ma={math.sqrt(3)*cfg.u0:.4f}", flush=True)
    for step in range(1, cfg.steps + 1):
        forces[step - 1] = solver.step()
        if step % 100 == 0 or step == 1 or step == cfg.steps:
            diagnostic = solver.check_stability()
            diagnostics["max_mach"] = max(diagnostics["max_mach"], diagnostic["max_mach"])
            diagnostics["min_density"] = min(diagnostics["min_density"], diagnostic["min_density"])
            diagnostics["max_density"] = max(diagnostics["max_density"], diagnostic["max_density"])
        if next_frame < nf and step == frame_steps[next_frame]:
            _, ux, uy = solver.fields()
            # dv/dx uses one-sided differences at open x boundaries;
            # du/dy uses centered periodic differences across top/bottom.
            omega = np.gradient(uy, axis=1) - (np.roll(ux, -1, axis=0) - np.roll(ux, 1, axis=0)) / 2
            # Mask solid AND one-cell wall stencil so visualization does not
            # imply an accurate wall vorticity on the staircased boundary.
            wall_stencil = solver.solid.copy()
            for axis in (0, 1):
                wall_stencil |= np.roll(solver.solid, 1, axis=axis) | np.roll(solver.solid, -1, axis=axis)
            omega[wall_stencil] = np.nan
            vort[next_frame] = (omega * cfg.diameter / cfg.u0)[::cfg.flow_stride, ::cfg.flow_stride]
            qu[next_frame] = (ux / cfg.u0)[::cfg.quiver_stride, ::cfg.quiver_stride]
            qv[next_frame] = (uy / cfg.u0)[::cfg.quiver_stride, ::cfg.quiver_stride]
            next_frame += 1
        now = time.monotonic()
        if now - last_report > 10 or step == cfg.steps:
            elapsed = now - start
            eta = elapsed / step * (cfg.steps - step)
            print(f"  {step:6d}/{cfg.steps} | {elapsed:.1f}s elapsed | "
                  f"ETA {eta:.1f}s | Ma_max <= {diagnostics['max_mach']:.4f}", flush=True)
            last_report = now
    # rho_ref=1; projected area D*unit_span. All forces retained, including startup.
    denominator = 0.5 * cfg.u0**2 * cfg.diameter
    diagnostics["runtime_seconds"] = time.monotonic() - start
    diagnostics["stability_check_interval_steps"] = 100
    return FlowResult(np.arange(1, cfg.steps + 1), forces, forces[:, 0] / denominator,
                      forces[:, 1] / denominator, frame_steps, vort, qu, qv,
                      solver.solid, diagnostics)


def fourier_basis(s: np.ndarray, st: float, harmonics: int = 3) -> np.ndarray:
    phase = 2 * math.pi * st * np.asarray(s)
    columns = [np.ones_like(phase)]
    for harmonic in range(1, harmonics + 1):
        columns.extend((np.sin(harmonic * phase), np.cos(harmonic * phase)))
    return np.stack(columns, axis=-1)


@dataclass
class WakeFit:
    strouhal: float
    coefficients: np.ndarray  # Columns: Cd, Cl; rows: 1, sin(phi), cos(phi), ...
    lift_rms: float
    drag_rms: float
    r_squared: np.ndarray
    training_cycles: float
    rms_stationarity_ratio: float

    def evaluate(self, s: np.ndarray | float) -> np.ndarray:
        return fourier_basis(np.asarray(s), self.strouhal) @ self.coefficients

    def to_dict(self) -> dict:
        result = asdict(self)
        result["coefficients"] = self.coefficients.tolist()
        result["r_squared"] = self.r_squared.tolist()
        return result


def fit_wake(flow: FlowResult, cfg: FlowConfig) -> WakeFit:
    """Fit measured force harmonics in convective time s=t_lattice*U/D.

    Frequency is selected from the lift spectrum, then refined by nonlinear
    least squares; Cd and Cl share that frequency. No assumed St, frequency,
    or force amplitude is substituted for an underdeveloped wake.
    """
    valid = flow.steps > cfg.warmup
    s = (flow.steps[valid] - flow.steps[valid][0]) * cfg.u0 / cfg.diameter
    observations = np.column_stack((flow.cd[valid], flow.cl[valid]))
    lift = detrend(observations[:, 1])
    if np.std(lift) < 1e-4:
        raise RuntimeError("Resolved lift fluctuations are too small to calibrate. Run more steps.")
    ds = cfg.u0 / cfg.diameter
    freq, spectrum = periodogram(lift, fs=1 / ds, window="hann",
                                nfft=2 ** (int(np.ceil(np.log2(len(s)))) + 2))
    band = (freq >= 0.07) & (freq <= 0.35)
    if not np.any(band):
        raise RuntimeError("Force record too short to resolve shedding. Run more steps.")
    st0 = freq[band][np.argmax(spectrum[band])]
    # Fit the fundamental alone when refining frequency: a harmonic basis can
    # otherwise identify a subharmonic of the actual shedding as fundamental.
    def residual(st: float) -> float:
        basis = fourier_basis(s, st, harmonics=1)
        coef = np.linalg.lstsq(basis, lift, rcond=None)[0]
        return float(np.mean((basis @ coef - lift)**2))

    width = 0.5 / max(s[-1], ds)
    optimum = minimize_scalar(residual, bounds=(max(0.07, st0 - width), min(0.35, st0 + width)),
                              method="bounded", options={"xatol": 1e-8})
    st = float(optimum.x)
    cycles = s[-1] * st
    if cycles < 2:
        raise RuntimeError(f"Only {cycles:.2f} fitted shedding cycles after warmup. "
                           "Increase --steps (and allow enough --warmup for growth).")
    basis = fourier_basis(s, st)
    coeff = np.linalg.lstsq(basis, observations, rcond=None)[0]
    fit = basis @ coeff
    variance = np.sum((observations - observations.mean(axis=0))**2, axis=0)
    r2 = 1 - np.sum((fit - observations)**2, axis=0) / np.maximum(variance, 1e-30)
    split = len(lift) // 2
    stationarity = float(np.std(lift[split:]) / max(np.std(lift[:split]), 1e-12))
    if coeff[0, 0] <= 0:
        raise RuntimeError("Nonpositive fitted mean drag: inspect the flow or run longer.")
    if cycles < 4 or r2[1] < 0.75 or not 0.7 < stationarity < 1.4:
        warnings.warn(f"Wake calibration is provisional: {cycles:.1f} cycles, "
                      f"lift R²={r2[1]:.3f}, late/early lift RMS={stationarity:.2f}. "
                      "Increase steps and warmup for a more stationary force record.")
    wake = WakeFit(st, coeff, float(np.std(observations[:, 1])),
                   float(np.std(observations[:, 0])), r2, cycles, stationarity)
    print(f"Wake fit: St={st:.4f}, <Cd>={coeff[0,0]:.3f}, "
          f"Cl_rms={wake.lift_rms:.4f}, R²(Cd,Cl)={r2.round(3)}, "
          f"cycles={cycles:.2f}", flush=True)
    return wake


class SeparationNoise:
    """Precomputed exact OU samples, linearly interpolated deterministically.

    Sampling occurs ONCE, outside the adaptive ODE RHS. RK45 stage count or
    step rejection therefore cannot change the stochastic force realization.
    These slow 3-D separation timescales are empirical, not inferred from 2-D.
    """

    def __init__(self, ball: BallConfig, seed: int):
        self.times = np.linspace(0, ball.max_time, int(np.ceil(ball.max_time / 0.005)) + 1)
        dt = self.times[1] - self.times[0]
        correlation = ball.wander_time * np.array([1.2, 1.0, 1.8])
        decay = np.exp(-dt / correlation)
        rng = np.random.default_rng(seed + 1000)
        innovations = rng.standard_normal((len(self.times), 3))
        self.values = np.empty_like(innovations)
        self.values[0] = innovations[0]
        for k in range(1, len(self.times)):
            self.values[k] = decay * self.values[k - 1] + np.sqrt(1 - decay**2) * innovations[k]

    def __call__(self, t: float) -> np.ndarray:
        return np.array([np.interp(t, self.times, self.values[:, j]) for j in range(3)])


def lateral_direction(velocity: np.ndarray, angle: float) -> np.ndarray:
    """Unit direction normal to instantaneous velocity; wake angle is not spin."""
    vhat = velocity / np.linalg.norm(velocity)
    reference = np.array([0.0, 1.0, 0.0])
    if abs(np.dot(reference, vhat)) > 0.95:
        reference = np.array([1.0, 0.0, 0.0])
    e1 = reference - np.dot(reference, vhat) * vhat
    e1 /= np.linalg.norm(e1)
    e2 = np.cross(vhat, e1)
    return math.cos(angle) * e1 + math.sin(angle) * e2


class FlightModel:
    def __init__(self, wake: WakeFit, ball: BallConfig, noise: SeparationNoise):
        self.wake, self.ball, self.noise = wake, ball, noise

    def coefficients(self, t: float, state: np.ndarray) -> tuple[float, float, float, float]:
        ball, wake = self.ball, self.wake
        speed = np.linalg.norm(state[3:6])
        reynolds = speed * ball.diameter / ball.air_nu
        z = self.noise(t)
        re_critical = ball.critical_re * (1 + ball.crisis_jitter * np.tanh(z[0]))
        target = expit((reynolds - re_critical) / ball.transition_width)
        fraction = state[7]  # Lagged supercritical boundary-layer fraction.
        base_cd = ball.cd_subcritical * (1 - fraction) + ball.cd_supercritical * fraction
        cd_2d, cl_2d = wake.evaluate(state[6])
        # Cylinder mean drag is NOT reused as a sphere's mean drag. Only the
        # measured relative fluctuation modulates the empirical sphere curve.
        relative_drag = cd_2d / wake.coefficients[0, 0] - 1
        cd = base_cd * math.exp(ball.drag_gain * float(np.clip(relative_drag, -1, 1)))
        # Retain fitted high-frequency shedding, plus slower unresolved wake
        # wandering. Both amplitudes derive from the measured 2-D lift scale;
        # the conversion gains and wandering process are declared assumptions.
        crisis_amplitude = 0.65 + 0.8 * 4 * fraction * (1 - fraction)
        cl = ball.lift_gain * crisis_amplitude * (
            0.15 * wake.coefficients[0, 1]
            + 0.35 * (cl_2d - wake.coefficients[0, 1])
            + ball.wander_strength * wake.lift_rms * np.tanh(z[1]))
        angle = 0.65 * np.tanh(z[2])
        return float(cd), float(cl), float(angle), float(target)

    def rhs(self, t: float, state: np.ndarray, include_lift: bool = True) -> np.ndarray:
        ball = self.ball
        velocity = state[3:6]
        speed = np.linalg.norm(velocity)
        cd, cl, angle, target = self.coefficients(t, state)
        acceleration = np.array([0.0, 0.0, -9.81])
        factor = 0.5 * ball.air_density * ball.area / ball.mass
        acceleration -= factor * cd * speed * velocity
        if include_lift and speed > 1e-12:
            acceleration += factor * cl * speed**2 * lateral_direction(velocity, angle)
        return np.r_[velocity, acceleration, speed / ball.diameter,
                     (target - state[7]) / ball.transition_time]


@dataclass
class FlightResult:
    time: np.ndarray
    state: np.ndarray
    reference_state: np.ndarray
    coefficients: np.ndarray
    ending: str
    reference_ending: str
    diagnostics: dict


def run_flight(wake: WakeFit, ball: BallConfig, seed: int) -> FlightResult:
    ball.validate()
    model = FlightModel(wake, ball, SeparationNoise(ball, seed))
    angle = math.radians(ball.elevation)
    state0 = np.array([0, 0, ball.height, ball.speed * math.cos(angle), 0,
                       ball.speed * math.sin(angle), 0, 0.5])
    state0[7] = model.coefficients(0, state0)[3]

    def goal(t: float, state: np.ndarray) -> float:
        return state[0] - ball.distance

    def ground(t: float, state: np.ndarray) -> float:
        return state[2] - ball.diameter / 2

    goal.terminal, goal.direction = True, 1
    ground.terminal, ground.direction = True, -1

    def integrate(include_lift: bool):
        # Resolve the highest fitted harmonic as well as the smooth random path.
        max_step = min(0.01, ball.diameter / (36 * wake.strouhal * ball.speed))
        sol = solve_ivp(lambda t, state: model.rhs(t, state, include_lift),
                        (0, ball.max_time), state0, method="RK45", dense_output=True,
                        events=(goal, ground), rtol=2e-7, atol=1e-9, max_step=max_step)
        if not sol.success:
            raise RuntimeError(f"Trajectory integration failed: {sol.message}")
        ending = "target plane" if len(sol.t_events[0]) else (
            "ground contact" if len(sol.t_events[1]) else "time limit")
        return sol, ending

    solution, ending = integrate(True)
    reference, reference_ending = integrate(False)
    times = np.linspace(0, solution.t[-1], 700)
    states = solution.sol(times).T
    # The reference uses the same drag model/noise but no lateral force. Never
    # extrapolate its dense output past its own terminal ground/target event.
    reference_states = np.full_like(states, np.nan)
    valid = times <= reference.t[-1]
    reference_states[valid] = reference.sol(times[valid]).T
    coefficients = np.array([model.coefficients(t, state)[:3] for t, state in zip(times, states)])
    speeds = np.linalg.norm(states[:, 3:6], axis=1)
    diagnostics = {"duration_seconds": float(times[-1]), "range_m": float(states[-1, 0]),
                   "side_deflection_m": float(states[-1, 1]), "height_m": float(states[-1, 2]),
                   "physical_re_start": float(speeds[0] * ball.diameter / ball.air_nu),
                   "physical_re_end": float(speeds[-1] * ball.diameter / ball.air_nu),
                   "rhs_evaluations": solution.nfev}
    print(f"Flight: {ending} at t={times[-1]:.3f}s, x={states[-1,0]:.3f}m, "
          f"y={states[-1,1]:+.3f}m, z={states[-1,2]:.3f}m", flush=True)
    if ending != "target plane":
        warnings.warn("Flight ended before the target plane; increase launch speed or elevation.")
    return FlightResult(times, states, reference_states, coefficients, ending,
                        reference_ending, diagnostics)


def make_animation(flow: FlowResult, wake: WakeFit, flight: FlightResult,
                   cfg: FlowConfig, ball: BallConfig, fps: int):
    import matplotlib.pyplot as plt
    from matplotlib.animation import FuncAnimation

    plt.rcParams.update({"font.size": 10, "axes.spines.top": False, "axes.spines.right": False})
    fig = plt.figure(figsize=(15, 9), layout="constrained", facecolor="#f5f6f8")
    grid = fig.add_gridspec(3, 2, width_ratios=(1.2, 1), height_ratios=(1.35, 0.85, 0.8))
    ax_flow = fig.add_subplot(grid[0, 0])
    ax_force = fig.add_subplot(grid[1, 0])
    ax_flight = fig.add_subplot(grid[:2, 1], projection="3d")
    ax_top = fig.add_subplot(grid[2, 1])
    ax_sphere = fig.add_subplot(grid[2, 0])
    fig.suptitle("Non-spinning knuckleball | resolved 2-D wake + empirical 3-D flight", fontsize=16)

    dx = ball.diameter / cfg.diameter
    extent = (-0.5 / cfg.diameter, (cfg.nx - 0.5) / cfg.diameter,
              -0.5 / cfg.diameter, (cfg.ny - 0.5) / cfg.diameter)
    vmax = max(float(np.nanpercentile(np.abs(flow.vorticity), 98.5)), 0.5)
    cmap = plt.get_cmap("RdBu_r").copy()
    cmap.set_bad("#d6d8dc")
    # Downsampled cell centers start at x=y=0; their imshow pixel extent must
    # account for the stride to align them with the full-resolution obstacle.
    stride = cfg.flow_stride
    nyv, nxv = flow.vorticity.shape[1:]
    image_extent = (-stride / 2 / cfg.diameter, (nxv - 0.5) * stride / cfg.diameter,
                    -stride / 2 / cfg.diameter, (nyv - 0.5) * stride / cfg.diameter)
    image = ax_flow.imshow(flow.vorticity[0], origin="lower", cmap=cmap, vmin=-vmax, vmax=vmax,
                           extent=image_extent, interpolation="bilinear")
    obstacle = np.ma.masked_where(~flow.solid, np.ones_like(flow.solid, dtype=float))
    ax_flow.imshow(obstacle, origin="lower", cmap="gray", vmin=0, vmax=1.5,
                   interpolation="nearest", extent=extent)
    qs = cfg.quiver_stride
    yy, xx = np.mgrid[0:cfg.ny:qs, 0:cfg.nx:qs]
    visible = (~flow.solid[::qs, ::qs]) & (xx > 0.24 * cfg.nx + cfg.diameter / 2)
    arrows = ax_flow.quiver(xx[visible] / cfg.diameter, yy[visible] / cfg.diameter,
                           flow.quiver_u[0][visible], flow.quiver_v[0][visible],
                           angles="xy", scale_units="xy", scale=7, width=0.0022,
                           color="#222b38", alpha=0.65)
    ax_flow.set(xlabel="x / D", ylabel="y / D", xlim=extent[:2], ylim=extent[2:])
    colorbar = fig.colorbar(image, ax=ax_flow, fraction=0.035, pad=0.02)
    colorbar.set_label(r"Vorticity $\omega D/U_0$")
    flow_title = ax_flow.set_title("")

    valid = flow.steps > cfg.warmup
    s = flow.steps[valid] * cfg.u0 / cfg.diameter
    fit = wake.evaluate(s - s[0])
    thin = max(1, len(s) // 4000)
    ax_force.plot(s[::thin], flow.cd[valid][::thin], color="#275dad", lw=1.1, label="LBM Cd")
    ax_force.plot(s[::thin], flow.cl[valid][::thin], color="#c33c54", lw=1.1, label="LBM Cl")
    ax_force.plot(s[::thin], fit[::thin, 0], "--", color="#18355e", lw=0.8, label="Fourier fit")
    ax_force.plot(s[::thin], fit[::thin, 1], "--", color="#7d2133", lw=0.8)
    cursor = ax_force.axvline(s[0], color="black", lw=1, alpha=0.5)
    ax_force.set(xlabel=r"LBM convective time $t^*=t_{LB}U_0/D$", ylabel="Cylinder coefficients",
                 title=f"Momentum exchange | St = {wake.strouhal:.3f} | lift fit R² = {wake.r_squared[1]:.2f}")
    ax_force.legend(ncol=3, fontsize=8, loc="upper right")
    ax_force.grid(alpha=0.2)

    xyz, ref = flight.state[:, :3], flight.reference_state[:, :3]
    ax_flight.plot(ref[:, 0], ref[:, 1], ref[:, 2], "--", color="#8e97a6", lw=1.5, label="Same drag, no side force")
    path, = ax_flight.plot([], [], [], color="#7541a0", lw=2.5, label="Empirical knuckleball")
    marker, = ax_flight.plot([], [], [], "o", color="#ed9a24", ms=8)
    ymax = max(0.08, float(np.max(np.abs(xyz[:, 1]))) * 1.35)
    zmax = max(1.0, float(np.nanmax(np.r_[xyz[:, 2], ref[:, 2]]))) * 1.1
    ax_flight.set(xlim=(0, ball.distance), ylim=(-ymax, ymax), zlim=(0, zmax),
                  xlabel="Downrange x [m]", ylabel="Side y [m]", zlabel="Height z [m]")
    ax_flight.set_box_aspect((2.8, 1.2, 1.2), zoom=0.82)
    ax_flight.view_init(elev=23, azim=-63)
    ax_flight.legend(loc="upper left", fontsize=8)
    flight_title = ax_flight.set_title("")
    ax_flight.text2D(0.02, 0.02, "Transverse axes enlarged; smooth changes of curvature", transform=ax_flight.transAxes,
                     color="#555d69", fontsize=8)

    ax_top.axhline(0, color="#8e97a6", ls="--", lw=1)
    top_path, = ax_top.plot([], [], color="#7541a0", lw=2)
    top_marker, = ax_top.plot([], [], "o", color="#ed9a24")
    ax_top.set(xlim=(0, ball.distance), ylim=(-100 * ymax, 100 * ymax),
               xlabel="Downrange x [m]", ylabel="Side y [cm]", title="Top view | side displacement")
    ax_top.grid(alpha=0.2)
    ax_sphere.plot(flight.time, flight.coefficients[:, 0], color="#275dad", label="Sphere Cd")
    ax_sphere.plot(flight.time, flight.coefficients[:, 1], color="#c33c54", label="Sphere Cl")
    flight_cursor = ax_sphere.axvline(0, color="black", lw=1, alpha=0.5)
    ax_sphere.set(xlabel="Physical flight time [s]", ylabel="Sphere coefficients",
                  title="Empirical drag transition + calibrated wake fluctuations")
    ax_sphere.legend(ncol=2, fontsize=8)
    ax_sphere.grid(alpha=0.2)
    fig.supxlabel(f"Independent playback clocks | Re_LBM = {cfg.reynolds:.1f} | "
                  f"Re_ball = {flight.diagnostics['physical_re_start']/1e5:.2f} → "
                  f"{flight.diagnostics['physical_re_end']/1e5:.2f} × 10⁵ | "
                  f"dx = {dx*1000:.2f} mm; viscosity similarity is not imposed", fontsize=9)

    def update(frame: int):
        progress = frame / max(1, len(flow.frame_steps) - 1)
        k = min(int(round(progress * (len(flight.time) - 1))), len(flight.time) - 1)
        image.set_data(flow.vorticity[frame])
        arrows.set_UVC(flow.quiver_u[frame][visible], flow.quiver_v[frame][visible])
        stime = flow.frame_steps[frame] * cfg.u0 / cfg.diameter
        cursor.set_xdata([stime, stime])
        flight_cursor.set_xdata([flight.time[k], flight.time[k]])
        path.set_data_3d(xyz[:k+1, 0], xyz[:k+1, 1], xyz[:k+1, 2])
        marker.set_data_3d([xyz[k, 0]], [xyz[k, 1]], [xyz[k, 2]])
        top_path.set_data(xyz[:k+1, 0], 100 * xyz[:k+1, 1])
        top_marker.set_data([xyz[k, 0]], [100 * xyz[k, 1]])
        flow_title.set_text(f"Seamed cylinder | LBM step {flow.frame_steps[frame]:,} | t* = {stime:.1f}")
        flight_title.set_text(f"3-D flight | t = {flight.time[k]:.2f} s | y = {100*xyz[k,1]:+.1f} cm")
        return image, arrows, cursor, flight_cursor, path, marker, top_path, top_marker

    update(0)
    animation = FuncAnimation(fig, update, frames=len(flow.frame_steps), interval=1000 / fps,
                              blit=False, repeat=True, cache_frame_data=False)
    return fig, animation, update


def save_results(prefix: Path, flow: FlowResult, wake: WakeFit, flight: FlightResult,
                 cfg: FlowConfig, ball: BallConfig) -> None:
    prefix.parent.mkdir(parents=True, exist_ok=True)
    dx = ball.diameter / cfg.diameter
    dt = cfg.u0 * dx / ball.speed
    metadata = {"model": "2-D BGK cylinder wake + empirical high-Re 3-D sphere closure",
                "flow_config": asdict(cfg), "ball_config": asdict(ball),
                "flow_diagnostics": flow.diagnostics, "wake_fit": wake.to_dict(),
                "flight_diagnostics": flight.diagnostics, "flight_ending": flight.ending,
                "reference_ending": flight.reference_ending,
                "units": {"dx_m": dx, "dt_s_at_initial_speed": dt,
                          "mapped_lbm_nu_m2_per_s": cfg.viscosity * dx**2 / dt,
                          "actual_air_nu_m2_per_s": ball.air_nu,
                          "lbm_reynolds": cfg.reynolds},
                "limitations": ["Re is not preserved between the training CFD and ball flight.",
                                "Seams are exaggerated and rasterized; 2-D blockage/outlet effects remain.",
                                "Drag crisis and 3-D low-frequency wandering are empirical assumptions.",
                                "A single 2-D flow cannot identify sphere coefficients or 3-D wake direction.",
                                "No grid/domain/time convergence or experimental validation is claimed."]}
    Path(f"{prefix}.json").write_text(json.dumps(metadata, indent=2), encoding="utf-8")
    np.savez_compressed(f"{prefix}.npz", steps=flow.steps, forces_lattice=flow.forces,
                        cd_cylinder=flow.cd, cl_cylinder=flow.cl,
                        frame_steps=flow.frame_steps, vorticity_dimensionless=flow.vorticity,
                        quiver_u_over_u0=flow.quiver_u, quiver_v_over_u0=flow.quiver_v,
                        solid=flow.solid, flight_time_s=flight.time, flight_state=flight.state,
                        reference_state=flight.reference_state, sphere_coefficients=flight.coefficients,
                        fourier_coefficients=wake.coefficients, metadata_json=json.dumps(metadata))
    np.savetxt(f"{prefix}_forces.csv", np.column_stack((flow.steps, flow.forces, flow.cd, flow.cl)),
               delimiter=",", header="step,Fx_lattice_per_span,Fy_lattice_per_span,Cd_cylinder,Cl_cylinder", comments="")
    np.savetxt(f"{prefix}_trajectory.csv", np.column_stack((flight.time, flight.state, flight.coefficients)),
               delimiter=",", comments="", header="t_s,x_m,y_m,z_m,vx_m_s,vy_m_s,vz_m_s,"
               "convective_age,supercritical_fraction,Cd_sphere,Cl_sphere,wake_angle_rad")


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--quick", action="store_true", help="240x120, D=24, 48000 steps; lower-resolution demonstration")
    for flag in ("nx", "ny", "steps", "warmup", "frames", "seed"):
        parser.add_argument(f"--{flag}", type=int)
    for flag in ("diameter", "u0", "tau", "seam-depth", "seam-angle"):
        parser.add_argument(f"--{flag}", type=float)
    parser.add_argument("--speed", type=float, default=25.0, help="Launch speed [m/s]")
    parser.add_argument("--elevation", type=float, default=22.0, help="Launch elevation [degrees]")
    parser.add_argument("--critical-re", type=float, default=3e5, help="Empirical sphere drag-crisis center")
    parser.add_argument("--lift-gain", type=float, default=0.55, help="Empirical cylinder-to-sphere lift gain")
    parser.add_argument("--wander-strength", type=float, default=1.4, help="Empirical slow wake amplitude; 0 disables it")
    parser.add_argument("--fps", type=int, default=24)
    parser.add_argument("--save", type=Path, help="Animation destination ending in .gif or .mp4")
    parser.add_argument("--output", type=Path, default=Path("output/knuckleball"), help="Prefix for PNG, NPZ, JSON and CSV files")
    parser.add_argument("--no-show", action="store_true", help="Use a headless Agg backend and do not open a window")
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    cfg = FlowConfig()
    if args.quick:
        cfg = FlowConfig(nx=240, ny=120, diameter=24, u0=0.027,
                         steps=48000, warmup=24000, frames=120, quiver_stride=8)
    for field in ("nx", "ny", "steps", "warmup", "frames", "seed", "diameter", "u0", "tau", "seam_depth", "seam_angle"):
        value = getattr(args, field)
        if value is not None:
            setattr(cfg, field, value)
    if args.steps is not None and args.warmup is None:
        cfg.warmup = int(0.4 * cfg.steps)
    ball = BallConfig(speed=args.speed, elevation=args.elevation, critical_re=args.critical_re,
                      lift_gain=args.lift_gain, wander_strength=args.wander_strength)
    cfg.validate()
    ball.validate()
    if args.fps <= 0:
        raise ValueError("fps must be positive.")
    # Validate movie requirements before starting the expensive simulation.
    import matplotlib
    if args.no_show:
        matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    from matplotlib.animation import FFMpegWriter, PillowWriter
    if args.save:
        suffix = args.save.suffix.lower()
        if suffix not in (".mp4", ".gif"):
            raise ValueError("--save needs a .mp4 or .gif filename.")
        if suffix == ".mp4" and not FFMpegWriter.isAvailable():
            raise RuntimeError("MP4 requires ffmpeg on PATH. Install ffmpeg or use --save movie.gif.")
        args.save.parent.mkdir(parents=True, exist_ok=True)

    print("Model scope: resolved low-Re 2-D wake; empirical high-Re sphere drag crisis and wandering.", flush=True)
    flow = run_flow(cfg)
    wake = fit_wake(flow, cfg)
    flight = run_flight(wake, ball, cfg.seed)
    save_results(args.output, flow, wake, flight, cfg, ball)
    fig, animation, update = make_animation(flow, wake, flight, cfg, ball, args.fps)
    # Initialize the animation, then render a fully developed final still.
    fig.canvas.draw()
    update(len(flow.frame_steps) - 1)
    fig.savefig(f"{args.output}.png", dpi=150)
    if args.save:
        writer = PillowWriter(fps=args.fps) if args.save.suffix.lower() == ".gif" else FFMpegWriter(fps=args.fps, bitrate=2200)
        print(f"Saving animation to {args.save} ...", flush=True)
        animation.save(str(args.save), writer=writer, dpi=85)
    print(f"Saved {args.output}.png/.npz/.json and force/trajectory CSV files.", flush=True)
    if args.no_show:
        plt.close(fig)
    else:
        update(0)
        plt.show()  # Keep the strong reference to animation alive through show().
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (ValueError, RuntimeError) as error:
        raise SystemExit(f"Error: {error}") from error
