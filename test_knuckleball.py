"""Numerical invariants and pipeline checks; run with python -m unittest -v."""
import unittest

import numpy as np

from knuckleball import (BallConfig, C, FlowConfig, FlowResult, FlightModel,
                         LBM, SeparationNoise, WakeFit, equilibrium, fit_wake,
                         lateral_direction, macroscopic, run_flight, zou_he_inlet)


class NumericalChecks(unittest.TestCase):
    def setUp(self):
        self.cfg = FlowConfig(nx=120, ny=64, diameter=12, u0=0.025)

    def test_zou_he_recovers_prescribed_velocity(self):
        rng = np.random.default_rng(21)
        populations = rng.uniform(0.01, 0.15, (9, 20, 5))
        zou_he_inlet(populations, 0.027)
        _, ux, uy = macroscopic(populations)
        np.testing.assert_allclose(ux[:, 0], 0.027, atol=5e-16)
        np.testing.assert_allclose(uy[:, 0], 0, atol=5e-16)

    def test_open_boundaries_preserve_uniform_flow(self):
        cfg = self.cfg
        solver = LBM(cfg, solid=np.zeros((cfg.ny, cfg.nx), dtype=bool))
        rho = np.ones((cfg.ny, cfg.nx))
        solver.f = equilibrium(rho, rho * cfg.u0, rho * 0)
        original = solver.f.copy()
        for _ in range(30):
            np.testing.assert_array_equal(solver.step(), [0, 0])
        np.testing.assert_allclose(solver.f, original, atol=2e-15)

    def test_resting_seamed_obstacle_has_no_force(self):
        solver = LBM(self.cfg)
        # Boundary velocity also zero for this hydrostatic invariant test.
        solver.cfg.u0 = 0
        rho = np.ones(solver.solid.shape)
        solver.f = equilibrium(rho, rho * 0, rho * 0)
        original = solver.f.copy()
        for _ in range(10):
            np.testing.assert_allclose(solver.step(), 0, atol=2e-14)
        np.testing.assert_allclose(solver.f, original, atol=2e-15)

    def test_link_force_equals_fluid_momentum_loss(self):
        solver = LBM(self.cfg)
        rho = np.ones(solver.solid.shape)
        ux = np.where(solver.solid, 0, self.cfg.u0)
        solver.f = equilibrium(rho, ux, rho * 0)

        def momentum():
            per_direction = solver.f[:, solver.fluid].sum(axis=1)
            return per_direction @ C

        before_mass = solver.f[:, solver.fluid].sum()
        before_momentum = momentum()
        force = solver.step()
        after_momentum = momentum()
        # Obstacle is far from x boundaries; both carry identical uniform flux
        # on this step. The entire fluid impulse must be the reflected force.
        np.testing.assert_allclose(after_momentum - before_momentum, -force, atol=1e-10)
        self.assertGreater(force[0], 0)
        self.assertAlmostEqual(solver.f[:, solver.fluid].sum(), before_mass, places=10)

    def test_fit_recovers_known_shedding_and_drag_harmonic(self):
        cfg = FlowConfig(nx=240, ny=120, diameter=24, u0=0.03, steps=30000, warmup=0)
        steps = np.arange(1, cfg.steps + 1)
        s = (steps - 1) * cfg.u0 / cfg.diameter
        phase = 2 * np.pi * 0.21 * s
        cl = 0.02 + 0.32 * np.sin(phase) + 0.02 * np.cos(2 * phase)
        cd = 1.3 + 0.06 * np.cos(2 * phase) + 0.01 * np.sin(phase)
        empty = np.array([])
        flow = FlowResult(steps, empty, cd, cl, empty, empty, empty, empty, empty, {})
        wake = fit_wake(flow, cfg)
        self.assertAlmostEqual(wake.strouhal, 0.21, delta=5e-4)
        self.assertGreater(np.min(wake.r_squared), 0.999)
        np.testing.assert_allclose(wake.coefficients[0], [1.3, 0.02], atol=1e-3)

    def test_lateral_force_does_no_work_and_rhs_is_deterministic(self):
        ball = BallConfig()
        model = FlightModel(example_wake(), ball, SeparationNoise(ball, 7))
        state = np.array([3.0, 0.2, 1.0, 23.0, 0.8, 4.0, 5.3, 0.7])
        side = lateral_direction(state[3:6], 0.6)
        self.assertAlmostEqual(np.dot(side, state[3:6]), 0, places=13)
        self.assertAlmostEqual(np.linalg.norm(side), 1, places=13)
        full = model.rhs(0.27, state)
        drag_only = model.rhs(0.27, state, include_lift=False)
        self.assertAlmostEqual(np.dot(state[3:6], full[3:6] - drag_only[3:6]), 0, places=12)
        np.testing.assert_array_equal(full, model.rhs(0.27, state))

    def test_trajectory_terminates_at_target_and_ground(self):
        wake = example_wake()
        target = run_flight(wake, BallConfig(lift_gain=0), 7)
        self.assertEqual(target.ending, "target plane")
        self.assertAlmostEqual(target.state[-1, 0], 30, places=9)
        np.testing.assert_allclose(target.state[:, 1], 0, atol=1e-14)
        ground = run_flight(wake, BallConfig(speed=8, elevation=0, lift_gain=0), 7)
        self.assertEqual(ground.ending, "ground contact")
        self.assertAlmostEqual(ground.state[-1, 2], 0.11, places=9)
        self.assertTrue(np.all((target.state[:, 7] >= 0) & (target.state[:, 7] <= 1)))


def example_wake():
    coefficients = np.zeros((7, 2))
    coefficients[0] = [1.3, 0.02]
    coefficients[1, 1] = 0.3
    coefficients[4, 0] = 0.05
    return WakeFit(0.19, coefficients, 0.3 / np.sqrt(2), 0.05 / np.sqrt(2),
                   np.ones(2), 6, 1)


if __name__ == "__main__":
    unittest.main()
