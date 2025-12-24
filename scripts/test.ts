import assert from 'node:assert/strict';

import {
  EVO_THRESHOLDS,
  MIN_SEGMENTS,
  OFFER_COUNTS,
  START_MASS,
  buildOfferMilestones,
  skillCooldownMs,
} from '../src/shared/balance';
import { TURN_PENALTY_BASE_MASS, TURN_PENALTY_MIN, turnPenaltyForMass } from '../src/server/balance';

type TestFn = () => void;

function run(name: string, fn: TestFn): void {
  try {
    fn();
    process.stdout.write(`[ok] ${name}\n`);
  } catch (err) {
    process.stderr.write(`[fail] ${name}\n`);
    throw err;
  }
}

run('shared progression constants', () => {
  assert.deepEqual(EVO_THRESHOLDS, [300, 1500, 5000]);
  assert.deepEqual(OFFER_COUNTS, [3, 3, 4]);
  assert.equal(START_MASS, 10);
  assert.equal(MIN_SEGMENTS, 14);
});

run('offer milestones are stable', () => {
  const milestones = buildOfferMilestones();
  assert.equal(milestones.length, OFFER_COUNTS[0] + OFFER_COUNTS[1] + OFFER_COUNTS[2]);
  assert.equal(milestones[milestones.length - 1], EVO_THRESHOLDS[2]);
  assert.ok(milestones.includes(EVO_THRESHOLDS[0]));
  assert.ok(milestones.includes(EVO_THRESHOLDS[1]));

  for (let i = 1; i < milestones.length; i++) {
    assert.ok(milestones[i]! > milestones[i - 1]!);
  }
});

run('skill cooldown tuning matches design', () => {
  assert.equal(skillCooldownMs('magnetic', 'ultimate_magnetic_magnet'), 16000);
  assert.equal(skillCooldownMs('magnetic', 'ultimate_magnetic_goldrush'), 20000);
  assert.equal(skillCooldownMs('magnetic', 'ultimate_magnetic_overcharge'), 16000);
  assert.equal(skillCooldownMs('shadow', 'ultimate_magnetic_magnet'), 20000);
});

run('turn penalty scales per doubling', () => {
  assert.equal(turnPenaltyForMass(TURN_PENALTY_BASE_MASS), 1);
  assert.ok(Math.abs(turnPenaltyForMass(TURN_PENALTY_BASE_MASS * 2) - 0.85) < 1e-12);
  assert.ok(turnPenaltyForMass(TURN_PENALTY_BASE_MASS * 1e9) >= TURN_PENALTY_MIN);
});

