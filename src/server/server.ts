import express from 'express';
import http from 'http';
import { Server, Socket } from 'socket.io';
import path from 'path';

import {
  buildOfferMilestones,
  CLASS_BASE_SKILL,
  EVO_THRESHOLDS,
  MIN_SEGMENTS,
  SKIN_BASE_SKILL,
  OFFER_COUNTS,
  START_MASS,
  skillCooldownMs,
} from '../shared/balance';

import {
  classForSkin,
  defaultSkinForClass,
  randomColorForSkin,
  randomSkinForClass,
  sanitizeSkin,
} from '../shared/characters';

import {
  IRON_ARMOR_BOOST_RECOVER,
  IRON_MASS_DECAY_MUL,
  MASS_DECAY_RATE,
  MASS_DECAY_SEGMENT_MUL,
  MASS_DECAY_START,
  SHADOW_KILL_REWARD_MUL,
  turnPenaltyForMass,
} from './balance';

import type {
  ClientToServerEvents,
  ServerToClientEvents,
  BlackHoleState,
  DecoyState,
  FoodState,
  GasState,
  IceState,
  LeaderboardEntry,
  MutationChoice,
  MutationId,
  MutationOfferPayload,
  MutationRarity,
  MutationStage,
  PlayerState,
  StatePayload,
  Vec2,
  WorldConfig,
  WormClass,
  WormSkin,
} from '../shared/protocol';

const app = express();
const server = http.createServer(app);
const io = new Server<ClientToServerEvents, ServerToClientEvents>(server);

// 정적 파일 제공 (클라이언트 빌드 결과물)
app.use(express.static(path.join(__dirname, '../../dist')));

app.get('/health', (_req, res) => {
  res.json({ ok: true });
});

interface Food {
  id: string;
  x: number;
  y: number;
  r: number;
  color: number;
  value: number;
  kind: FoodKind;
}

type ChronoSnapshot = { t: number; x: number; y: number; angle: number; scoreAcc: number; len: number };
type ChronoPoint = { x: number; y: number; angle: number };

interface Player {
  id: string;
  name: string;
  color: number;
  segments: Vec2[];
  trail: Vec2[];
  trailStart: number;
  trailLen: number;
  scoreAcc: number;
  score: number;
  dna: WormClass;
  skin: WormSkin;
  armor: number;
  slowUntil: number;
  stealthUntil: number;
  phaseUntil: number;
  invulnerableUntil: number;
  bunkerUntil: number;
  evoStage: number;
  nextEvoScore: number;
  nextOfferScore: number;
  offerIndex: number;
  pendingStage: MutationStage | 0;
  pendingChoices: MutationChoice[];
  mutations: MutationId[];
  scoreGainMul: number;
  boostDrainMul: number;
  speedBonusMul: number;
  turnBonusMul: number;
  gasTrail: boolean;
  gasAccMs: number;
  baitBomb: boolean;
  baitAccMs: number;
  hyperMetabolism: boolean;
  metabolismAcc: number;
  massDecayAcc: number;
  spikedTailStacks: number;
  toxicTrailStacks: number;
  boostBurnUntil: number;
  boostBurnStacks: number;
  boostBurnAcc: number;
  gasDebuffUntil: number;
  iceSlipUntil: number;
  turnLockUntil: number;
  plasmaDamageAcc: number;
  skill: MutationId;
  skillCooldownUntil: number;
  skillActiveUntil: number;
  skillHeld: boolean;
  chronoHistory: ChronoSnapshot[];
  chronoNextSampleAt: number;
  chronoRewindStartAt: number;
  chronoRewindUntil: number;
  chronoRewindPath: ChronoPoint[];
  chronoTargetScoreAcc: number;
  chronoTargetLen: number;
  magnetUntil: number;
  goldrushUntil: number;
  overchargeUntil: number;
  angle: number;
  inputAngle: number;
  boost: boolean;
  boostBlend: number;
  boostDrain: number;
  growthAcc: number;
  growthApplyAcc: number;
  spawnedAt: number;
  isBot: boolean;
  ai?: BotBrain;
}

class SpatialGrid<T> {
  private readonly cells: Map<string, Set<T>> = new Map();

  constructor(private readonly cellSize: number) {}

  // Convert coordinates to a grid key ("10,20").
  private getKey(x: number, y: number): string {
    const cx = Math.floor(x / this.cellSize);
    const cy = Math.floor(y / this.cellSize);
    return `${cx},${cy}`;
  }

  add(obj: T, x: number, y: number): void {
    const key = this.getKey(x, y);
    let cell = this.cells.get(key);
    if (!cell) {
      cell = new Set();
      this.cells.set(key, cell);
    }
    cell.add(obj);
  }

  remove(obj: T, x: number, y: number): void {
    const key = this.getKey(x, y);
    const cell = this.cells.get(key);
    if (!cell) return;
    cell.delete(obj);
    if (cell.size <= 0) this.cells.delete(key);
  }

  // Get objects from the surrounding 9 cells (including the current one).
  getNearby(x: number, y: number, range: number = 1): T[] {
    const out: T[] = [];
    const cx = Math.floor(x / this.cellSize);
    const cy = Math.floor(y / this.cellSize);
    const r = Math.max(0, Math.floor(range));

    for (let dx = -r; dx <= r; dx++) {
      for (let dy = -r; dy <= r; dy++) {
        const key = `${cx + dx},${cy + dy}`;
        const cell = this.cells.get(key);
        if (!cell) continue;
        for (const obj of cell) out.push(obj);
      }
    }
    return out;
  }

  clear(): void {
    this.cells.clear();
  }
}

function isInsideGas(pos: Vec2): boolean {
  const nearby = gasGrid.getNearby(pos.x, pos.y, 1);
  for (const cloud of nearby) {
    const dx = cloud.x - pos.x;
    const dy = cloud.y - pos.y;
    if (dx * dx + dy * dy <= cloud.r * cloud.r) return true;
  }
  return false;
}

function isInsideIce(pos: Vec2, selfId: string): boolean {
  const range = Math.max(1, Math.ceil(FROST_DOMAIN_RADIUS / GRID_CELL_SIZE));
  const nearby = iceGrid.getNearby(pos.x, pos.y, range);
  for (const zone of nearby) {
    if (zone.ownerId === selfId) continue;
    const dx = zone.x - pos.x;
    const dy = zone.y - pos.y;
    if (dx * dx + dy * dy <= zone.r * zone.r) return true;
  }
  return false;
}

function recordChronoHistory(player: Player, now: number): void {
  if (now < player.chronoNextSampleAt) return;
  const head = player.segments[0];
  if (!head) return;

  player.chronoHistory.push({
    t: now,
    x: head.x,
    y: head.y,
    angle: player.angle,
    scoreAcc: player.scoreAcc,
    len: player.segments.length,
  });
  player.chronoNextSampleAt = now + CHRONO_HISTORY_SAMPLE_MS;

  const cutoff = now - CHRONO_HISTORY_KEEP_MS;
  while (player.chronoHistory.length > 2 && (player.chronoHistory[0]?.t ?? now) < cutoff) {
    player.chronoHistory.shift();
  }
}

function lerpAngle(a: number, b: number, t: number): number {
  const d = normalizeAngle(b - a);
  return normalizeAngle(a + d * t);
}

function rebuildTrailFromSegments(player: Player): void {
  const segs = player.segments;
  player.trail = [];
  for (let i = segs.length - 1; i >= 0; i--) {
    const s = segs[i];
    if (!s) continue;
    player.trail.push({ x: s.x, y: s.y });
  }
  player.trailStart = 0;
  player.trailLen = 0;
  for (let i = 1; i < player.trail.length; i++) {
    const a = player.trail[i - 1];
    const b = player.trail[i];
    if (!a || !b) continue;
    player.trailLen += Math.hypot(b.x - a.x, b.y - a.y);
  }
}

function startChronoRewind(player: Player, now: number): boolean {
  const head = player.segments[0];
  if (!head) return false;

  const targetTime = now - CHRONO_REWIND_LOOKBACK_MS;
  const history = player.chronoHistory;
  if (history.length <= 0) return false;

  let snap = history[0]!;
  for (let i = history.length - 1; i >= 0; i--) {
    const s = history[i]!;
    if (s.t <= targetTime) {
      snap = s;
      break;
    }
    snap = s;
  }

  const path: ChronoPoint[] = [{ x: head.x, y: head.y, angle: player.angle }];
  for (let i = history.length - 1; i >= 0; i--) {
    const s = history[i]!;
    if (s.t < targetTime) break;
    path.push({ x: s.x, y: s.y, angle: s.angle });
  }
  if (path.length < 2) return false;

  player.chronoRewindPath = path;
  player.chronoRewindStartAt = now;
  player.chronoRewindUntil = now + CHRONO_REWIND_MS;
  player.chronoTargetScoreAcc = snap.scoreAcc;
  player.chronoTargetLen = snap.len;
  player.boost = false;
  player.boostBlend = 0;
  player.boostDrain = 0;
  return true;
}

function stepChronoRewind(player: Player, now: number): void {
  const head = player.segments[0];
  if (!head) return;
  const path = player.chronoRewindPath;
  if (!path || path.length < 2) return;

  const elapsed = now - player.chronoRewindStartAt;
  const t = clamp(elapsed / Math.max(1, CHRONO_REWIND_MS), 0, 1);
  const f = t * (path.length - 1);
  const i0 = Math.max(0, Math.min(path.length - 1, Math.floor(f)));
  const i1 = Math.max(0, Math.min(path.length - 1, i0 + 1));
  const a = f - i0;
  const p0 = path[i0]!;
  const p1 = path[i1]!;
  const nx = p0.x + (p1.x - p0.x) * a;
  const ny = p0.y + (p1.y - p0.y) * a;

  const dx = nx - head.x;
  const dy = ny - head.y;
  if (Math.abs(dx) < 1e-6 && Math.abs(dy) < 1e-6) return;

  for (const seg of player.segments) {
    seg.x += dx;
    seg.y += dy;
  }

  player.angle = lerpAngle(p0.angle, p1.angle, a);
  player.inputAngle = player.angle;
  player.boost = false;
  player.boostBlend = 0;
  player.boostDrain = 0;

  // Phase + invulnerable while rewinding so it reads as "time magic", not a teleport-collision exploit.
  player.phaseUntil = Math.max(player.phaseUntil, now + 140);
  player.invulnerableUntil = Math.max(player.invulnerableUntil, now + 140);

  // Push away heads along the rewind path so other players don't get clipped.
  const newHead = player.segments[0];
  if (!newHead) return;
  const pushR = headRadiusForPlayer(player) * 2.1 + 70;
  const pushR2 = pushR * pushR;
  for (const other of players.values()) {
    if (other.id === player.id) continue;
    if (now - other.spawnedAt < SPAWN_INVULNERABLE_MS) continue;
    if (isPhaseActive(other, now)) continue;
    const oh = other.segments[0];
    if (!oh) continue;
    const ox = oh.x - newHead.x;
    const oy = oh.y - newHead.y;
    const d2 = ox * ox + oy * oy;
    if (d2 > pushR2 || d2 === 0) continue;
    const d = Math.sqrt(d2) || 1;
    const strength = (pushR - d) * 0.55;
    pushWholeWorm(other, (ox / d) * strength, (oy / d) * strength);
  }
}

function finishChronoRewind(player: Player): void {
  player.chronoRewindUntil = 0;
  player.chronoRewindStartAt = 0;
  player.chronoRewindPath = [];

  const targetLen = Math.max(MIN_SEGMENTS, Math.round(player.chronoTargetLen));
  if (player.segments.length > targetLen) {
    player.segments.length = targetLen;
  } else if (player.segments.length < targetLen) {
    grow(player, targetLen - player.segments.length);
  }

  player.scoreAcc = Math.max(START_MASS, player.chronoTargetScoreAcc);
  player.score = Math.max(0, Math.floor(player.scoreAcc));

  player.boost = false;
  player.boostBlend = 0;
  player.boostDrain = 0;

  rebuildTrailFromSegments(player);
}

function spawnMirageClones(player: Player, now: number): void {
  const head = player.segments[0];
  if (!head) return;

  // Replace any existing clones owned by this player.
  for (const [id, decoy] of decoys) {
    if (decoy.ownerId === player.id) decoys.delete(id);
  }

  const baseAngle = rand(-Math.PI, Math.PI);
  for (let i = 0; i < MIRAGE_CLONES_COUNT; i++) {
    const angleOffset = baseAngle + (i / MIRAGE_CLONES_COUNT) * Math.PI * 2;
    const id = String(nextDecoyId++);
    decoys.set(id, {
      id,
      ownerId: player.id,
      name: player.name,
      color: player.color,
      dna: player.dna,
      skin: player.skin,
      segments: player.segments.map((s) => ({ x: s.x, y: s.y })),
      originalLen: player.segments.length,
      spawnedAt: now,
      angleOffset,
      maxOffset: MIRAGE_CLONE_OFFSET_DIST,
      expiresAt: now + MIRAGE_CLONES_MS,
    });
  }
}

function easeOutCubic(t: number): number {
  const x = clamp(t, 0, 1);
  return 1 - Math.pow(1 - x, 3);
}

function stepDecoys(now: number): void {
  for (const decoy of decoys.values()) {
    const owner = players.get(decoy.ownerId);
    if (!owner) continue;
    const ownerSegs = owner.segments;
    if (ownerSegs.length === 0) continue;

    // Animate the initial "burst" outwards.
    const u = easeOutCubic((now - decoy.spawnedAt) / 900);
    const dist = decoy.maxOffset * u;
    const wobble = Math.sin(now / 380 + decoy.angleOffset * 3.0) * 18;
    const ox = Math.cos(decoy.angleOffset);
    const oy = Math.sin(decoy.angleOffset);
    const offX = ox * dist + -oy * wobble;
    const offY = oy * dist + ox * wobble;

    const baseHead = ownerSegs[0]!;
    const headPos = { x: baseHead.x + offX, y: baseHead.y + offY };
    const clamped = clampToArena(headPos, HEAD_RADIUS + 80);
    const cx = clamped.x - headPos.x;
    const cy = clamped.y - headPos.y;
    const finalOffX = offX + cx;
    const finalOffY = offY + cy;

    // Keep original length for the decoy (it matches the owner at cast time).
    if (decoy.segments.length !== decoy.originalLen) {
      const tail = decoy.segments[decoy.segments.length - 1] ?? baseHead;
      while (decoy.segments.length < decoy.originalLen) decoy.segments.push({ x: tail.x, y: tail.y });
      if (decoy.segments.length > decoy.originalLen) decoy.segments.length = decoy.originalLen;
    }

    for (let i = 0; i < decoy.segments.length; i++) {
      const src = ownerSegs[Math.min(i, ownerSegs.length - 1)]!;
      const seg = decoy.segments[i]!;
      seg.x = src.x + finalOffX;
      seg.y = src.y + finalOffY;
    }
  }
}

function isBoostingNow(player: Player, now: number): boolean {
  if (isBunkerDownActive(player, now)) return false;
  return player.boost && player.segments.length > MIN_SEGMENTS;
}

function stepPlasmaRays(now: number): void {
  for (const attacker of players.values()) {
    if (attacker.skill !== 'skill_plasma_ray') continue;
    if (now >= attacker.skillActiveUntil) continue;
    const head = attacker.segments[0];
    if (!head) continue;

    const fx = Math.cos(attacker.angle);
    const fy = Math.sin(attacker.angle);

    for (const victim of players.values()) {
      if (victim.id === attacker.id) continue;
      if (now - victim.spawnedAt < SPAWN_INVULNERABLE_MS) continue;
      if (isPhaseActive(victim, now)) continue;
      if (isInvulnerableActive(victim, now)) continue;
      if (isBoostingNow(victim, now)) continue; // counterplay: boosting worms are immune

      const victimBodyR = bodyRadiusForPlayer(victim);
      const hitWidth = PLASMA_RAY_HALF_WIDTH + victimBodyR * 0.9;
      const hitWidth2 = hitWidth * hitWidth;

      let hit = false;
      for (let i = 0; i < victim.segments.length; i += 3) {
        const p = victim.segments[i];
        if (!p) continue;
        const vx = p.x - head.x;
        const vy = p.y - head.y;
        const proj = vx * fx + vy * fy;
        if (proj <= 0 || proj > PLASMA_RAY_RANGE) continue;
        const px = vx - fx * proj;
        const py = vy - fy * proj;
        if (px * px + py * py <= hitWidth2) {
          hit = true;
          break;
        }
      }
      if (!hit) continue;

      const segs = victim.segments.length;
      const dmg = segs * PLASMA_RAY_DAMAGE_PER_SEC * DT;
      victim.plasmaDamageAcc += dmg;

      while (victim.plasmaDamageAcc >= 1) {
        victim.plasmaDamageAcc -= 1;
        if (victim.segments.length <= MIN_SEGMENTS) break;
        victim.segments.pop();
        victim.scoreAcc = Math.max(0, victim.scoreAcc - 1);
        victim.score = Math.max(0, Math.floor(victim.scoreAcc));
      }
    }
  }
}

// World config is still rectangular for client/minimap math, but the arena is a circle centered at (0, 0).
const WORLD: WorldConfig = { width: 16000, height: 16000 };
const ARENA_RADIUS = WORLD.width / 2;
const TICK_RATE = 60; // higher TPS for snappier control
const DT = 1 / TICK_RATE;

const SEGMENT_SPACING = 12;
const HEAD_RADIUS = 18;
const BODY_RADIUS = 14;
// Head-trajectory trail: record head movement at a higher resolution so the tail can follow curves precisely.
const TRAIL_POINT_MIN_DIST = 1; // 3에서 1로 변경하여 기록 해상도를 높임
const TRAIL_BUFFER_DIST = 2400;
const TRAIL_COMPACT_THRESHOLD = 2048;

// Network quantization:
// Keep payload size reasonable while still sending enough precision for smooth interpolation.
const NET_POS_SCALE = 100; // 2 decimals (0.01 world-units)

// Speeds are in world-units per second (movement uses dt).
const BASE_SPEED = 126;
const BOOST_SPEED = 270;

const BOOST_BLEND_UP = 4.0; // per second
const BOOST_BLEND_DOWN = 5.6; // per second
const BOOST_DRAIN_RATE = 3.2; // segments per second

const BOT_COUNT = 10;
const BOT_RESPAWN_MS = 900;

const MAX_FOOD = 4000;
const FOOD_BASE_R = 4;
const FOOD_CLUSTER_CHANCE = 0.09;
const FOOD_CLUSTER_RADIUS = 240;
const FOOD_CLUSTER_MIN = 14;
const FOOD_CLUSTER_MAX = 32;
const FOOD_VALUE_WEIGHTS: Array<{ value: number; weight: number }> = [
  { value: 1, weight: 0.78 },
  { value: 2, weight: 0.18 },
  { value: 3, weight: 0.04 },
];

// Growth tuning:
// - Keep per-food growth "micro" so worms lengthen smoothly instead of jumping.
// - Corpse food is still better than normal, but never grants multiple segments at once.
const FOOD_GROWTH_PER_VALUE = 0.2;
const CORPSE_GROWTH_PER_VALUE = 0.32;
const GROWTH_APPLY_RATE = 6; // segments per second (throttles queued growth)

// Magnetic passive: gently pull nearby food toward the head (slither.io-style).
const MAGNET_PULL_RADIUS = 520;
const MAGNET_PULL_RADIUS_SINGULARITY = 1080;
const MAGNET_PULL_MIN_SPEED = 90; // ensures visible movement even with integer food netpos
const MAGNET_PULL_MAX_SPEED = 1850;

const SPAWN_INVULNERABLE_MS = 1500;
const SHADOW_STEALTH_MS = 1000;
const BUNKER_DOWN_MS = 3000;
const PHANTOM_DECOY_DURATION_MS = 4200;
const PHANTOM_DECOY_STEALTH_MS = 2200;
const VOID_STRIKE_MS = 5000;
const SIEGE_BREAKER_MS = 5000;
const SINGULARITY_MS = 5000;
const SINGULARITY_RADIUS = 240;
const SINGULARITY_PULL_RADIUS = 920;
const SINGULARITY_MAX_RANGE = 1400;

const SHADOW_CLOAK_REFRESH_MS = 120;
const SHADOW_CLOAK_FULL_DRAIN_MS = 4200;

// Skin skills (9 characters)
const VIPER_BLENDER_MS = 1500;
const EEL_OVERDRIVE_MS = 3000;
const VENOM_GAS_REFRESH_MS = 120;
const VENOM_GAS_FULL_DRAIN_MS = 3000;
const SCARAB_THORNS_MS = 3000;
const FROST_DOMAIN_MS = 7000;
const PLASMA_RAY_MS = 5000;
const CHRONO_REWIND_LOOKBACK_MS = 3000;
const CHRONO_REWIND_MS = 2000;
const CHRONO_HISTORY_SAMPLE_MS = 80;
const CHRONO_HISTORY_KEEP_MS = 5200;
const MIRAGE_CLONES_COUNT = 9;
const MIRAGE_CLONES_MS = 10000;
const VOID_MAW_MS = 3000;

// Skill tuning knobs (server-authoritative)
const GAS_DEBUFF_LINGER_MS = 700;
const GAS_BOOST_DRAIN_MUL = 1.45;

const EEL_FIELD_STUN_MS = 500;
const EEL_FIELD_RADIUS_EXTRA = 140;

const FROST_DOMAIN_RADIUS = 820;
const FROST_SLIP_LINGER_MS = 320;
const FROST_SLIP_TURN_MUL = 0.45;

const PLASMA_RAY_RANGE = 1700;
const PLASMA_RAY_HALF_WIDTH = 120;
const PLASMA_RAY_DAMAGE_PER_SEC = 0.01; // 1% of current length per second

const VIPER_PULL_RADIUS = 1400;
const VOID_MAW_PULL_RADIUS = 1500;
const VOID_MAW_HALF_ANGLE = (60 * Math.PI) / 180;

const MIRAGE_CLONE_OFFSET_DIST = 520;

const HYPER_METABOLISM_GROWTH_MUL = 1.3;
const HYPER_METABOLISM_DECAY_RATE = 0.12; // segments per second

const OFFER_MILESTONES = buildOfferMilestones(START_MASS, EVO_THRESHOLDS, OFFER_COUNTS);

const GAS_DURATION_MS = 3000;
const GAS_RADIUS = 190;
const GAS_DROP_INTERVAL_MS = 180;

const BAIT_BOMB_INTERVAL_MS = 1200;

const players = new Map<string, Player>();
const foods = new Map<string, Food>();
let nextFoodId = 1;

// Spatial grids rebuilt every tick (cell size slightly larger than a typical view chunk).
const GRID_CELL_SIZE = 300;
const PLAYER_GRID_SKIP_NECK = 6;
const PLAYER_GRID_SAMPLE_STEP = 2; // keep collision reliable (segment spacing=12, sampling=24)

const foodGrid = new SpatialGrid<Food>(GRID_CELL_SIZE);
type PlayerBodySample = { seg: Vec2; playerId: string };
const playerGrid = new SpatialGrid<PlayerBodySample>(GRID_CELL_SIZE);

type GasCloud = { id: string; x: number; y: number; r: number; expiresAt: number };
const gasClouds = new Map<string, GasCloud>();
let nextGasId = 1;
const gasGrid = new SpatialGrid<GasCloud>(GRID_CELL_SIZE);

type IceZone = { id: string; ownerId: string; x: number; y: number; r: number; expiresAt: number };
const iceZones = new Map<string, IceZone>();
let nextIceZoneId = 1;
const iceGrid = new SpatialGrid<IceZone>(GRID_CELL_SIZE);

type BlackHole = { id: string; ownerId: string; x: number; y: number; r: number; expiresAt: number };
const blackHoles = new Map<string, BlackHole>();
let nextBlackHoleId = 1;

type Decoy = {
  id: string;
  ownerId: string;
  name: string;
  color: number;
  dna: WormClass;
  skin: WormSkin;
  segments: Vec2[];
  originalLen: number;
  spawnedAt: number;
  angleOffset: number;
  maxOffset: number;
  expiresAt: number;
};
const decoys = new Map<string, Decoy>();
let nextDecoyId = 1;

const FOOD_STREAM_BASE_RADIUS = 3800;
const FOOD_STREAM_MAX = 1400;

interface BotBrain {
  target: Vec2;
  nextDecisionAt: number;
  boostUntil: number;
}

type BotProfile = {
  name: string;
  color: number;
  dna: WormClass;
  skin: WormSkin;
};

type FoodKind = 'normal' | 'boost' | 'corpse' | 'bomb';

const botProfiles = new Map<string, BotProfile>();
const spectatorCenters = new Map<string, Vec2>();

function rand(min: number, max: number): number {
  return Math.random() * (max - min) + min;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function netPos(value: number): number {
  return Math.round(value * NET_POS_SCALE) / NET_POS_SCALE;
}

function normalizeAngle(angle: number): number {
  let a = angle;
  while (a > Math.PI) a -= Math.PI * 2;
  while (a < -Math.PI) a += Math.PI * 2;
  return a;
}

function isOutsideArena(pos: Vec2, margin: number): boolean {
  const limit = Math.max(0, ARENA_RADIUS - margin);
  return pos.x * pos.x + pos.y * pos.y > limit * limit;
}

function clampToArena(pos: Vec2, margin: number): Vec2 {
  const limit = Math.max(0, ARENA_RADIUS - margin);
  const limit2 = limit * limit;
  const d2 = pos.x * pos.x + pos.y * pos.y;
  if (d2 <= limit2 || d2 === 0) return { x: pos.x, y: pos.y };
  const d = Math.sqrt(d2);
  const k = limit / d;
  return { x: pos.x * k, y: pos.y * k };
}

function randomPointInArena(margin: number): Vec2 {
  const limit = Math.max(0, ARENA_RADIUS - margin);
  const r = Math.sqrt(Math.random()) * limit;
  const a = rand(-Math.PI, Math.PI);
  return { x: Math.cos(a) * r, y: Math.sin(a) * r };
}

function sizeExtraForLength(length: number): number {
  return clamp((Math.sqrt(length) - 4) * 0.85, 0, 10);
}

function bodyRadiusForLength(length: number): number {
  return BODY_RADIUS + sizeExtraForLength(length);
}

function headRadiusForLength(length: number): number {
  return HEAD_RADIUS + sizeExtraForLength(length) * 1.1;
}

function classConfig(
  dna: WormClass,
): {
  baseMul: number;
  boostMul: number;
  turnMul: number;
  boostDrainMul: number;
  eatMul: number;
  hitboxHeadMul: number;
  hitboxBodyMul: number;
} {
  if (dna === 'iron') {
    return { baseMul: 0.86, boostMul: 0.9, turnMul: 0.85, boostDrainMul: 2, eatMul: 1, hitboxHeadMul: 1.02, hitboxBodyMul: 1.08 };
  }
  if (dna === 'shadow') {
    // Hitbox -10% (survivability), kill reward is handled on corpse spawn.
    return {
      baseMul: 1.05,
      boostMul: 1.15,
      turnMul: 1.06,
      boostDrainMul: 0.7,
      eatMul: 1,
      hitboxHeadMul: 1.22 * 0.9,
      hitboxBodyMul: 0.9 * 0.9,
    };
  }
  return { baseMul: 0.98, boostMul: 1.02, turnMul: 0.96, boostDrainMul: 1, eatMul: 3, hitboxHeadMul: 1.06, hitboxBodyMul: 1 };
}

function grantIronArmorBoost(player: Player): void {
  const gain = IRON_ARMOR_BOOST_RECOVER;
  player.scoreAcc += gain;
  player.score = Math.max(0, Math.floor(player.scoreAcc));
  grow(player, gain);
}

function isStealthActive(player: Player, now: number): boolean {
  return player.dna === 'shadow' && now < player.stealthUntil;
}

function isPhaseActive(player: Player, now: number): boolean {
  return now < player.phaseUntil;
}

function isInvulnerableActive(player: Player, now: number): boolean {
  return now < player.invulnerableUntil;
}

function isBunkerDownActive(player: Player, now: number): boolean {
  return now < player.bunkerUntil;
}

function isSiegeBreakerActive(player: Player, now: number): boolean {
  return player.skill === 'ultimate_iron_charge' && now < player.skillActiveUntil;
}

function isVoidStrikeActive(player: Player, now: number): boolean {
  return player.skill === 'ultimate_shadow_phase' && now < player.skillActiveUntil;
}

function isSingularityActive(player: Player, now: number): boolean {
  return player.skill === 'ultimate_magnetic_magnet' && now < player.skillActiveUntil;
}

function headRadiusForPlayer(player: Player): number {
  return headRadiusForLength(player.segments.length) * classConfig(player.dna).hitboxHeadMul;
}

function bodyRadiusForPlayer(player: Player): number {
  return bodyRadiusForLength(player.segments.length) * classConfig(player.dna).hitboxBodyMul;
}

function dist2(a: Vec2, b: Vec2): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return dx * dx + dy * dy;
}

function randomBrightColor(): number {
  const hue = Math.random() * 360;
  const saturation = 0.92;
  const lightness = 0.6;

  const c = (1 - Math.abs(2 * lightness - 1)) * saturation;
  const x = c * (1 - Math.abs(((hue / 60) % 2) - 1));
  const m = lightness - c / 2;

  let r = 0;
  let g = 0;
  let b = 0;

  if (hue < 60) [r, g, b] = [c, x, 0];
  else if (hue < 120) [r, g, b] = [x, c, 0];
  else if (hue < 180) [r, g, b] = [0, c, x];
  else if (hue < 240) [r, g, b] = [0, x, c];
  else if (hue < 300) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];

  const ri = Math.round((r + m) * 255);
  const gi = Math.round((g + m) * 255);
  const bi = Math.round((b + m) * 255);
  return (ri << 16) + (gi << 8) + bi;
}

const CLASS_COLORS: Record<WormClass, number[]> = {
  iron: [0xffb15a, 0xe07b39, 0xffd34d, 0xff3b2f, 0xf2505d, 0xff7a4a],
  shadow: [0x00e5ff, 0x5cf2ff, 0xb000ff, 0x7b2cff, 0xff4dff, 0x4d6bff],
  magnetic: [0x8cff00, 0x57ff9a, 0xffd34d, 0xa55cff, 0x2bf7ff, 0x6bff5a],
};

function randomClassColor(dna: WormClass): number {
  const palette = CLASS_COLORS[dna] ?? CLASS_COLORS.shadow;
  const pick = palette[Math.floor(Math.random() * palette.length)];
  return pick ?? randomBrightColor();
}

function downsampleSegments(segments: readonly Vec2[], maxPoints: number): Vec2[] {
  if (segments.length <= maxPoints) return segments.map((s) => ({ x: s.x, y: s.y }));
  const step = Math.max(1, Math.ceil(segments.length / maxPoints));
  const out: Vec2[] = [];
  for (let i = 0; i < segments.length; i += step) {
    const s = segments[i]!;
    out.push({ x: s.x, y: s.y });
  }
  const tail = segments[segments.length - 1];
  const last = out[out.length - 1];
  if (tail && last && (tail.x !== last.x || tail.y !== last.y)) {
    out.push({ x: tail.x, y: tail.y });
  }
  return out;
}

function sanitizeName(name: string): string {
  const cleaned = name.replace(/\s+/g, ' ').trim().slice(0, 16);
  return cleaned.length === 0 ? 'Unknown' : cleaned;
}

function sanitizeClass(dna: unknown): WormClass {
  if (dna === 'iron' || dna === 'shadow' || dna === 'magnetic') return dna;
  return 'shadow';
}

type MutationDef = { stage: MutationStage; name: string; desc: string; rarity: MutationRarity; maxStacks: number };

const MUTATION_DEFS: Partial<Record<MutationId, MutationDef>> = {
  rocket_fuel: {
    stage: 1,
    name: '로켓 추진 (Rocket Fuel)',
    desc: '부스트 소모량 -15%.',
    rarity: 'rare',
    maxStacks: 3,
  },
  flexible_spine: {
    stage: 1,
    name: '유연한 관절 (Flexible Spine)',
    desc: '회전 반경 -10%.',
    rarity: 'common',
    maxStacks: 3,
  },
  lightweight: {
    stage: 1,
    name: '경량화 (Lightweight)',
    desc: '기본 이동 속도 +5%.',
    rarity: 'rare',
    maxStacks: 3,
  },
  iron_stomach: {
    stage: 1,
    name: '강철 소화기 (Iron Stomach)',
    desc: '먹이 획득량 +20%.',
    rarity: 'rare',
    maxStacks: 3,
  },
  eagle_eye: {
    stage: 1,
    name: '시야 확장 (Eagle Eye)',
    desc: '카메라 줌 아웃 +15%.',
    rarity: 'common',
    maxStacks: 3,
  },
  sixth_sense: {
    stage: 1,
    name: '위기 감지 (Sixth Sense)',
    desc: '화면 밖에서 고속 접근하는 적을 가장자리에 경고 표시합니다.',
    rarity: 'common',
    maxStacks: 1,
  },
  spiked_tail: {
    stage: 2,
    name: '가시 꼬리 (Spiked Tail)',
    desc: '몸통 근처에 닿은 적의 부스트 게이지를 태웁니다.',
    rarity: 'rare',
    maxStacks: 3,
  },
  toxic_trail: {
    stage: 2,
    name: '잔류 독소 (Toxic Trail)',
    desc: '독성 궤적이 1초 더 오래 남습니다.',
    rarity: 'rare',
    maxStacks: 3,
  },

  iron_bunker_down: {
    stage: 2,
    name: '벙커 다운 (Bunker Down)',
    desc: '3초 동안 제자리에 고정되어 무적 방어 상태가 됩니다. (이동 불가)',
    rarity: 'rare',
    maxStacks: 1,
  },
  shadow_phantom_decoy: {
    stage: 2,
    name: '광학 미채 (Optical Cloak)',
    desc: '버튼을 누르고 있는 동안 은신합니다. 유지 중 게이지가 소모되며, 해제하면 서서히 회복합니다.',
    rarity: 'rare',
    maxStacks: 1,
  },
  magnetic_hyper_metabolism: {
    stage: 2,
    name: '과대사 (Hyper-Metabolism)',
    desc: '먹이를 먹으면 성장 +30% 대신, 시간이 지나면 질량이 조금씩 감소합니다.',
    rarity: 'rare',
    maxStacks: 1,
  },

  ultimate_iron_charge: {
    stage: 3,
    name: '시즈 브레이커 (Siege Breaker)',
    desc: '5초간 1.5배 거대화 + 무적 돌진. 닿는 모든 것을 파괴합니다.',
    rarity: 'legend',
    maxStacks: 1,
  },
  ultimate_shadow_phase: {
    stage: 3,
    name: '보이드 스트라이크 (Void Strike)',
    desc: '5초간 유령 상태로 몸통을 통과하며 절단합니다. (단, 머리는 통과 불가)',
    rarity: 'legend',
    maxStacks: 1,
  },
  ultimate_magnetic_magnet: {
    stage: 3,
    name: '싱귤래리티 (Singularity)',
    desc: '5초간 블랙홀을 생성해 먹이와 작은 적을 끌어당겨 흡수합니다.',
    rarity: 'legend',
    maxStacks: 1,
  },
};

const SHARED_TIER1_MUTATIONS: MutationId[] = [
  'rocket_fuel',
  'flexible_spine',
  'lightweight',
  'iron_stomach',
  'eagle_eye',
  'sixth_sense',
];

const SHARED_TIER2_MUTATIONS: MutationId[] = ['spiked_tail', 'toxic_trail', ...SHARED_TIER1_MUTATIONS];
const SHARED_TIER3_MUTATIONS: MutationId[] = [...SHARED_TIER2_MUTATIONS];

const STAGE2_CLASS_MUTATION: Record<WormClass, MutationId> = {
  iron: 'iron_bunker_down',
  shadow: 'shadow_phantom_decoy',
  magnetic: 'magnetic_hyper_metabolism',
};

const STAGE3_CLASS_ULTIMATE: Record<WormClass, MutationId> = {
  iron: 'ultimate_iron_charge',
  shadow: 'ultimate_shadow_phase',
  magnetic: 'ultimate_magnetic_magnet',
};

function pickDistinct<T>(items: readonly T[], count: number): T[] {
  const copy = items.slice();
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const t = copy[i]!;
    copy[i] = copy[j]!;
    copy[j] = t;
  }
  return copy.slice(0, Math.max(0, Math.min(count, copy.length)));
}

function mutationStacks(player: Player, id: MutationId): number {
  let n = 0;
  for (const m of player.mutations) if (m === id) n++;
  return n;
}

function mutationMaxStacks(id: MutationId): number {
  return MUTATION_DEFS[id]?.maxStacks ?? 1;
}

function mutationChoice(player: Player, id: MutationId): MutationChoice {
  const def = MUTATION_DEFS[id];
  const base = def
    ? { name: def.name, desc: def.desc, rarity: def.rarity }
    : { name: id, desc: '', rarity: 'common' as const };

  const max = mutationMaxStacks(id);
  if (max <= 1) return { id, ...base };

  const current = mutationStacks(player, id);
  const next = Math.min(max, current + 1);
  return { id, name: `${base.name} (${next}/${max})`, desc: base.desc, rarity: base.rarity };
}

function nextEvoScoreForStage(stage: number): number {
  if (stage <= 0) return EVO_THRESHOLDS[0];
  if (stage === 1) return EVO_THRESHOLDS[1];
  if (stage === 2) return EVO_THRESHOLDS[2];
  return 0;
}

function buildMutationOffer(player: Player, tier: MutationStage, milestone: number): MutationOfferPayload | null {
  const isFinal = milestone >= EVO_THRESHOLDS[2];
  if (isFinal) {
    const ultimate = STAGE3_CLASS_ULTIMATE[player.dna] ?? STAGE3_CLASS_ULTIMATE.shadow;
    if (mutationStacks(player, ultimate) >= mutationMaxStacks(ultimate)) return null;
    return { stage: 3, choices: [mutationChoice(player, ultimate)] };
  }

  const pool = tier === 1 ? SHARED_TIER1_MUTATIONS : tier === 2 ? SHARED_TIER2_MUTATIONS : SHARED_TIER3_MUTATIONS;
  const picked: MutationId[] = [];

  const isTier2Unlock = milestone === EVO_THRESHOLDS[1];
  if (isTier2Unlock) {
    const classMut = STAGE2_CLASS_MUTATION[player.dna] ?? STAGE2_CLASS_MUTATION.shadow;
    if (mutationStacks(player, classMut) < mutationMaxStacks(classMut)) {
      picked.push(classMut);
    }
  }

  const available = pool.filter((id) => mutationStacks(player, id) < mutationMaxStacks(id));
  const remaining = Math.max(0, 3 - picked.length);
  const rest = pickDistinct(available, remaining);
  picked.push(...rest);

  if (picked.length === 0) return null;
  return { stage: tier, choices: picked.map((id) => mutationChoice(player, id)) };
}

function applyMutation(player: Player, _tier: MutationStage, id: MutationId, now: number): void {
  const max = mutationMaxStacks(id);
  const stacks = mutationStacks(player, id);
  if (stacks >= max) return;

  player.mutations.push(id);

  if (id === 'iron_stomach') player.scoreGainMul *= 1.2;
  else if (id === 'rocket_fuel') player.boostDrainMul *= 0.85;
  else if (id === 'flexible_spine') player.turnBonusMul *= 1.12;
  else if (id === 'lightweight') player.speedBonusMul *= 1.05;
  else if (id === 'toxic_trail') {
    player.gasTrail = true;
    player.toxicTrailStacks = Math.min(3, player.toxicTrailStacks + 1);
  } else if (id === 'spiked_tail') {
    player.spikedTailStacks = Math.min(3, player.spikedTailStacks + 1);
  } else if (id === 'iron_bunker_down' || id === 'shadow_phantom_decoy') {
    player.skill = id;
    player.skillHeld = false;
  } else if (id === 'magnetic_hyper_metabolism') {
    player.hyperMetabolism = true;
  } else if (id.startsWith('ultimate_')) {
    player.skill = id;
    player.skillHeld = false;
  }

  player.pendingStage = 0;
  player.pendingChoices = [];

  if (player.isBot && player.dna === 'shadow') {
    player.boost = true;
  }
}

function maybeOfferMutation(player: Player, now: number): void {
  if (player.pendingStage !== 0) return;
  if (player.offerIndex >= OFFER_MILESTONES.length) return;
  if (player.score < player.nextOfferScore) return;

  const milestone = player.nextOfferScore;
  const tier: MutationStage = milestone <= EVO_THRESHOLDS[0] ? 1 : milestone <= EVO_THRESHOLDS[1] ? 2 : 3;
  const offer = buildMutationOffer(player, tier, milestone);

  // Advance milestones even if this offer becomes empty (e.g., fully stacked).
  player.offerIndex += 1;
  player.nextOfferScore = OFFER_MILESTONES[player.offerIndex] ?? Number.POSITIVE_INFINITY;

  if (!offer || offer.choices.length === 0) return;
  player.pendingStage = offer.stage;
  player.pendingChoices = offer.choices;

  if (player.isBot) {
    const pick = offer.choices[Math.floor(Math.random() * offer.choices.length)]?.id;
    if (pick) applyMutation(player, offer.stage, pick, now);
    return;
  }

  io.to(player.id).emit('mutationOffer', offer);
}

function updateProgression(player: Player): void {
  const score = player.score;
  let stage = 0;
  if (score >= EVO_THRESHOLDS[2]) stage = 3;
  else if (score >= EVO_THRESHOLDS[1]) stage = 2;
  else if (score >= EVO_THRESHOLDS[0]) stage = 1;

  player.evoStage = stage;
  player.nextEvoScore = stage >= 3 ? 0 : EVO_THRESHOLDS[stage] ?? 0;
}

function pushWholeWorm(player: Player, dx: number, dy: number): void {
  for (const seg of player.segments) {
    seg.x += dx;
    seg.y += dy;
  }
  for (let i = player.trailStart; i < player.trail.length; i++) {
    const p = player.trail[i];
    if (!p) continue;
    p.x += dx;
    p.y += dy;
  }
}

function updateHeadTrail(player: Player): void {
  const head = player.segments[0];
  if (!head) return;

  const activeCount = player.trail.length - player.trailStart;
  if (activeCount <= 0) {
    player.trail = [{ x: head.x, y: head.y }];
    player.trailStart = 0;
    player.trailLen = 0;
    return;
  }

  const last = player.trail[player.trail.length - 1];
  if (!last) return;
  const dx = head.x - last.x;
  const dy = head.y - last.y;
  const d2 = dx * dx + dy * dy;

  const min2 = TRAIL_POINT_MIN_DIST * TRAIL_POINT_MIN_DIST;

  // [수정됨] 복잡한 덮어쓰기 로직 제거.
  // 단순히 일정 거리(1.0) 이상 이동했으면 무조건 궤적에 추가합니다.
  // 이렇게 해야 회전할 때의 모든 곡선이 기록되어 꼬리가 정확히 따라옵니다.
  if (d2 >= min2) {
    const d = Math.sqrt(d2);
    player.trail.push({ x: head.x, y: head.y });
    player.trailLen += d;
  }
}

function applyTrailToSegments(player: Player): void {
  const segs = player.segments;
  if (segs.length <= 1) return;

  const start = player.trailStart;
  const trail = player.trail;
  const end = trail.length - 1;
  if (end - start < 1) {
    const head = segs[0]!;
    for (let i = 1; i < segs.length; i++) {
      segs[i]!.x = head.x;
      segs[i]!.y = head.y;
    }
    return;
  }

  // Precision polish: treat the *current* head position as an implicit trail point.
  // When per-tick movement is < TRAIL_POINT_MIN_DIST, updateHeadTrail won't push a new point,
  // which can cause a tiny "neck stretch" between seg[0] (head) and seg[1] (body).
  // Including the head as a temporary point keeps segment spacing exact without bloating the trail.
  const head = segs[0]!;

  let segIndex = 1;
  let targetDist = SEGMENT_SPACING;
  let acc = 0;
  const last = trail[end]!;

  // Segment: head -> last recorded trail point
  let cur: Vec2 = head;
  {
    const dx = cur.x - last.x;
    const dy = cur.y - last.y;
    const segLen = Math.sqrt(dx * dx + dy * dy);
    if (segLen > 0.001) {
      while (segIndex < segs.length && acc + segLen >= targetDist) {
        const t = (targetDist - acc) / segLen;
        const px = cur.x + (last.x - cur.x) * t;
        const py = cur.y + (last.y - cur.y) * t;
        const seg = segs[segIndex]!;
        seg.x = px;
        seg.y = py;
        segIndex++;
        targetDist += SEGMENT_SPACING;
      }

      acc += segLen;
    }
  }

  cur = last;

  for (let idx = end; idx > start && segIndex < segs.length; idx--) {
    const prev = trail[idx - 1]!;
    const dx = cur.x - prev.x;
    const dy = cur.y - prev.y;
    const segLen = Math.sqrt(dx * dx + dy * dy);
    if (segLen <= 0.001) {
      cur = prev;
      continue;
    }

    while (segIndex < segs.length && acc + segLen >= targetDist) {
      const t = (targetDist - acc) / segLen;
      const px = cur.x + (prev.x - cur.x) * t;
      const py = cur.y + (prev.y - cur.y) * t;
      const seg = segs[segIndex]!;
      seg.x = px;
      seg.y = py;
      segIndex++;
      targetDist += SEGMENT_SPACING;
    }

    acc += segLen;
    cur = prev;
  }

  if (segIndex < segs.length) {
    const tail = trail[start] ?? cur;
    for (; segIndex < segs.length; segIndex++) {
      const seg = segs[segIndex]!;
      seg.x = tail.x;
      seg.y = tail.y;
    }
  }
}

function trimTrail(player: Player): void {
  const segs = player.segments;
  const needed = Math.max(0, (segs.length - 1) * SEGMENT_SPACING);
  const keepLen = needed + TRAIL_BUFFER_DIST;

  while (player.trailLen > keepLen && player.trail.length - player.trailStart > 2) {
    const a = player.trail[player.trailStart];
    const b = player.trail[player.trailStart + 1];
    if (a && b) player.trailLen -= Math.hypot(b.x - a.x, b.y - a.y);
    player.trailStart++;
  }

  if (player.trailStart >= TRAIL_COMPACT_THRESHOLD && player.trailStart > player.trail.length / 2) {
    player.trail.splice(0, player.trailStart);
    player.trailStart = 0;
  }
}

type SkillAction = 'tap' | 'start' | 'end';

function skillEnergyFraction(player: Player, now: number, cooldownMs: number): number {
  if (cooldownMs <= 0) return 0;
  const fullAt = Math.max(now, player.skillCooldownUntil);
  const missingMs = clamp(fullAt - now, 0, cooldownMs);
  return clamp(1 - missingMs / cooldownMs, 0, 1);
}

function tryStartShadowCloak(player: Player, now: number): void {
  if (player.skill !== 'shadow_phantom_decoy') return;
  if (player.pendingStage !== 0) return;

  const cooldownMs = skillCooldownMs(player.dna, player.skill) ?? 18000;
  const energy = skillEnergyFraction(player, now, cooldownMs);
  if (energy <= 0.001) return;

  player.skillHeld = true;
  player.skillCooldownUntil = Math.max(player.skillCooldownUntil, now);
  player.skillActiveUntil = Math.max(player.skillActiveUntil, now + SHADOW_CLOAK_REFRESH_MS);
  player.stealthUntil = Math.max(player.stealthUntil, now + SHADOW_CLOAK_REFRESH_MS);
}

function stopSkillHold(player: Player): void {
  player.skillHeld = false;
}

function handleSkillAction(player: Player, now: number, action: SkillAction, x?: number, y?: number): void {
  player.skill = SKIN_BASE_SKILL[player.skin] ?? CLASS_BASE_SKILL[player.dna];
  if (player.pendingStage !== 0) return;

  if (player.skill === 'shadow_phantom_decoy') {
    if (action === 'end') {
      stopSkillHold(player);
      return;
    }
    if (action === 'start') {
      tryStartShadowCloak(player, now);
      return;
    }
    // Back-compat: treat tap as toggle for hold skills.
    if (player.skillHeld) stopSkillHold(player);
    else tryStartShadowCloak(player, now);
    return;
  }

  if (player.skill === 'skill_venom_gas') {
    if (action === 'end') {
      stopSkillHold(player);
      return;
    }

    const cooldownMs = skillCooldownMs(player.dna, player.skill) ?? 25000;
    const energy = skillEnergyFraction(player, now, cooldownMs);
    if (action === 'start') {
      if (energy <= 0.001) return;
      player.skillHeld = true;
      player.skillCooldownUntil = Math.max(player.skillCooldownUntil, now);
      player.skillActiveUntil = Math.max(player.skillActiveUntil, now + VENOM_GAS_REFRESH_MS);
      return;
    }

    // Toggle on tap.
    if (player.skillHeld) {
      stopSkillHold(player);
      return;
    }
    if (energy <= 0.001) return;
    player.skillHeld = true;
    player.skillCooldownUntil = Math.max(player.skillCooldownUntil, now);
    player.skillActiveUntil = Math.max(player.skillActiveUntil, now + VENOM_GAS_REFRESH_MS);
    return;
  }

  if (action === 'end') return;
  const target = typeof x === 'number' && typeof y === 'number' ? { x, y } : undefined;
  useSkill(player, now, target);
}

function useSkill(player: Player, now: number, target?: Vec2): void {
  player.skill = SKIN_BASE_SKILL[player.skin] ?? CLASS_BASE_SKILL[player.dna];
  if (now < player.skillCooldownUntil) return;
  if (player.pendingStage !== 0) return;

  const id = player.skill;
  const cooldownMs = skillCooldownMs(player.dna, id) ?? 20000;
  if (id === 'iron_bunker_down') {
    player.skillActiveUntil = now + BUNKER_DOWN_MS;
    player.bunkerUntil = Math.max(player.bunkerUntil, now + BUNKER_DOWN_MS);
    player.invulnerableUntil = Math.max(player.invulnerableUntil, now + BUNKER_DOWN_MS);
    player.skillCooldownUntil = now + cooldownMs;
  } else if (id === 'shadow_phantom_decoy') {
    // Hold skill (Shadow Cloak) is handled by handleSkillAction / stepSkillHolds.
    return;
  } else if (id === 'ultimate_iron_charge') {
    // Siege Breaker
    player.skillActiveUntil = now + SIEGE_BREAKER_MS;
    player.invulnerableUntil = Math.max(player.invulnerableUntil, now + SIEGE_BREAKER_MS);
    player.slowUntil = 0;
    player.skillCooldownUntil = now + cooldownMs;
  } else if (id === 'ultimate_iron_fortress') {
    player.skillActiveUntil = now + 5000;
    player.armor = Math.max(player.armor, 2);
    player.skillCooldownUntil = now + cooldownMs;
  } else if (id === 'ultimate_iron_shockwave') {
    player.skillActiveUntil = now + 250;
    player.skillCooldownUntil = now + cooldownMs;

    const head = player.segments[0];
    if (head) {
      const radius = 560;
      const radius2 = radius * radius;
      for (const other of players.values()) {
        if (other.id === player.id) continue;
        if (now - other.spawnedAt < SPAWN_INVULNERABLE_MS) continue;
        const oh = other.segments[0];
        if (!oh) continue;
        const dx = oh.x - head.x;
        const dy = oh.y - head.y;
        const d2 = dx * dx + dy * dy;
        if (d2 > radius2 || d2 === 0) continue;
        const d = Math.sqrt(d2);
        const strength = (1 - d / radius) * 240;
        pushWholeWorm(other, (dx / d) * strength, (dy / d) * strength);
      }
    }
  } else if (id === 'ultimate_shadow_phase') {
    // Void Strike
    player.skillActiveUntil = now + VOID_STRIKE_MS;
    player.skillCooldownUntil = now + cooldownMs;
  } else if (id === 'ultimate_shadow_smokescreen') {
    player.skillActiveUntil = now + 4000;
    player.skillCooldownUntil = now + cooldownMs;
  } else if (id === 'ultimate_shadow_dash') {
    player.skillActiveUntil = now + 1200;
    player.stealthUntil = Math.max(player.stealthUntil, now + 1200);
    player.skillCooldownUntil = now + cooldownMs;
  } else if (id === 'ultimate_magnetic_magnet') {
    // Singularity
    player.skillActiveUntil = now + SINGULARITY_MS;
    player.skillCooldownUntil = now + cooldownMs;

    const head = player.segments[0];
    if (!head) return;

    const raw = target ?? head;
    let pos = { x: raw.x, y: raw.y };
    const dx = pos.x - head.x;
    const dy = pos.y - head.y;
    const d2 = dx * dx + dy * dy;
    if (d2 > SINGULARITY_MAX_RANGE * SINGULARITY_MAX_RANGE) {
      const d = Math.sqrt(d2) || 1;
      pos = { x: head.x + (dx / d) * SINGULARITY_MAX_RANGE, y: head.y + (dy / d) * SINGULARITY_MAX_RANGE };
    }
    pos = clampToArena(pos, SINGULARITY_RADIUS + 40);

    // Replace any existing black hole owned by this player.
    for (const [holeId, hole] of blackHoles) {
      if (hole.ownerId === player.id) blackHoles.delete(holeId);
    }

    const holeId = String(nextBlackHoleId++);
    blackHoles.set(holeId, {
      id: holeId,
      ownerId: player.id,
      x: pos.x,
      y: pos.y,
      r: SINGULARITY_RADIUS,
      expiresAt: now + SINGULARITY_MS,
    });
  } else if (id === 'ultimate_magnetic_goldrush') {
    player.skillActiveUntil = now + 6500;
    player.goldrushUntil = Math.max(player.goldrushUntil, now + 6500);
    player.skillCooldownUntil = now + cooldownMs;
  } else if (id === 'ultimate_magnetic_overcharge') {
    player.skillActiveUntil = now + 5000;
    player.overchargeUntil = Math.max(player.overchargeUntil, now + 5000);
    player.skillCooldownUntil = now + cooldownMs;
  } else if (id === 'skill_viper_blender') {
    player.skillActiveUntil = now + VIPER_BLENDER_MS;
    player.skillCooldownUntil = now + cooldownMs;
  } else if (id === 'skill_eel_overdrive') {
    player.skillActiveUntil = now + EEL_OVERDRIVE_MS;
    player.skillCooldownUntil = now + cooldownMs;
  } else if (id === 'skill_venom_gas') {
    // Toggle/energy skill handled by handleSkillAction + stepSkillHolds.
    return;
  } else if (id === 'skill_scarab_thorns') {
    player.skillActiveUntil = now + SCARAB_THORNS_MS;
    player.skillCooldownUntil = now + cooldownMs;
  } else if (id === 'skill_frost_domain') {
    player.skillActiveUntil = now + FROST_DOMAIN_MS;
    player.skillCooldownUntil = now + cooldownMs;

    const head = player.segments[0];
    if (!head) return;

    // Replace any existing ice zone owned by this player.
    for (const [zoneId, zone] of iceZones) {
      if (zone.ownerId === player.id) iceZones.delete(zoneId);
    }

    const zoneId = String(nextIceZoneId++);
    const pos = clampToArena({ x: head.x, y: head.y }, FROST_DOMAIN_RADIUS + 40);
    iceZones.set(zoneId, { id: zoneId, ownerId: player.id, x: pos.x, y: pos.y, r: FROST_DOMAIN_RADIUS, expiresAt: now + FROST_DOMAIN_MS });
  } else if (id === 'skill_plasma_ray') {
    player.skillActiveUntil = now + PLASMA_RAY_MS;
    player.skillCooldownUntil = now + cooldownMs;
  } else if (id === 'skill_chrono_rewind') {
    if (!startChronoRewind(player, now)) return;
    player.skillActiveUntil = now + CHRONO_REWIND_MS;
    player.skillCooldownUntil = now + cooldownMs;
  } else if (id === 'skill_mirage_clones') {
    player.skillActiveUntil = now + 600;
    player.skillCooldownUntil = now + cooldownMs;
    spawnMirageClones(player, now);
  } else if (id === 'skill_void_maw') {
    player.skillActiveUntil = now + VOID_MAW_MS;
    player.skillCooldownUntil = now + cooldownMs;
  }
}

function chooseFoodValue(): number {
  const t = Math.random();
  let acc = 0;
  for (const { value, weight } of FOOD_VALUE_WEIGHTS) {
    acc += weight;
    if (t <= acc) return value;
  }
  return FOOD_VALUE_WEIGHTS[0]?.value ?? 1;
}

function spawnFood(at?: Vec2, value?: number, color?: number, kind: FoodKind = 'normal'): Food {
  const v = value ?? chooseFoodValue();
  const rBonus = kind === 'corpse' ? 2 : 0;
  const r = FOOD_BASE_R + v + rBonus;

  const pos = at ?? randomPointInArena(r + 6);
  const clamped = clampToArena(pos, r + 6);

  const food: Food = {
    id: String(nextFoodId++),
    x: clamped.x,
    y: clamped.y,
    r,
    value: v,
    kind,
    color: color ?? randomBrightColor(),
  };

  foods.set(food.id, food);
  return food;
}

function chooseClusterFoodValue(): number {
  const t = Math.random();
  if (t < 0.86) return 1;
  if (t < 0.98) return 2;
  return 3;
}

function randomFoodClusterCenter(): Vec2 {
  const minDist = 260;
  const minDist2 = minDist * minDist;
  const margin = FOOD_CLUSTER_RADIUS + 40;

  for (let attempt = 0; attempt < 24; attempt++) {
    const candidate = randomPointInArena(margin);

    let ok = true;
    for (const other of players.values()) {
      const oh = other.segments[0];
      if (!oh) continue;
      if (dist2(candidate, oh) < minDist2) {
        ok = false;
        break;
      }
    }

    if (ok) return candidate;
  }

  return randomPointInArena(margin);
}

function spawnFoodCluster(): void {
  const center = randomFoodClusterCenter();
  const count = Math.floor(rand(FOOD_CLUSTER_MIN, FOOD_CLUSTER_MAX + 1));

  for (let i = 0; i < count && foods.size < MAX_FOOD; i++) {
    const a = rand(-Math.PI, Math.PI);
    const r = Math.pow(Math.random(), 1.6) * FOOD_CLUSTER_RADIUS;
    spawnFood(
      {
        x: center.x + Math.cos(a) * r + rand(-12, 12),
        y: center.y + Math.sin(a) * r + rand(-12, 12),
      },
      chooseClusterFoodValue(),
    );
  }
}

function trimFoods(): void {
  const max = MAX_FOOD + 400;
  if (foods.size <= max) return;

  const target = MAX_FOOD + 200;
  for (const id of foods.keys()) {
    foods.delete(id);
    if (foods.size <= target) break;
  }
}

function spawnFoodsUpToCap(): void {
  while (foods.size < MAX_FOOD) {
    const remaining = MAX_FOOD - foods.size;
    if (remaining >= FOOD_CLUSTER_MIN && Math.random() < FOOD_CLUSTER_CHANCE) {
      spawnFoodCluster();
      continue;
    }
    spawnFood();
  }
}

function randomSpawnPoint(): Vec2 {
  const minDist = 450;
  const minDist2 = minDist * minDist;
  const margin = HEAD_RADIUS + 120;

  for (let attempt = 0; attempt < 30; attempt++) {
    const candidate = randomPointInArena(margin);

    let ok = true;
    for (const other of players.values()) {
      if (dist2(candidate, other.segments[0]!) < minDist2) {
        ok = false;
        break;
      }
    }

    if (ok) return candidate;
  }

  return randomPointInArena(margin);
}

function createPlayer(
  id: string,
  name: string,
  options?: { color?: number; initialSegments?: number; isBot?: boolean; dna?: WormClass; skin?: WormSkin },
): Player {
  const spawn = randomSpawnPoint();
  const startAngle = rand(-Math.PI, Math.PI);
  const initialSegments = options?.initialSegments ?? 26;
  const desiredDna = sanitizeClass(options?.dna ?? 'shadow');
  const skin = options?.skin ? sanitizeSkin(options.skin) : defaultSkinForClass(desiredDna);
  const dna = classForSkin(skin);

  const segments: Vec2[] = [];
  for (let i = 0; i < initialSegments; i++) {
    segments.push({
      x: spawn.x - Math.cos(startAngle) * i * SEGMENT_SPACING,
      y: spawn.y - Math.sin(startAngle) * i * SEGMENT_SPACING,
    });
  }

  const trail: Vec2[] = [];
  for (let i = segments.length - 1; i >= 0; i--) {
    const s = segments[i]!;
    trail.push({ x: s.x, y: s.y });
  }
  let trailLen = 0;
  for (let i = 1; i < trail.length; i++) {
    const a = trail[i - 1]!;
    const b = trail[i]!;
    trailLen += Math.hypot(b.x - a.x, b.y - a.y);
  }

  return {
    id,
    name,
    color: options?.color ?? randomColorForSkin(skin),
    segments,
    trail,
    trailStart: 0,
    trailLen,
    scoreAcc: START_MASS,
    score: START_MASS,
    dna,
    skin,
    armor: dna === 'iron' ? 2 : 0,
    slowUntil: 0,
    stealthUntil: 0,
    phaseUntil: 0,
    invulnerableUntil: 0,
    bunkerUntil: 0,
    evoStage: 0,
    nextEvoScore: EVO_THRESHOLDS[0],
    nextOfferScore: OFFER_MILESTONES[0] ?? EVO_THRESHOLDS[0],
    offerIndex: 0,
    pendingStage: 0,
    pendingChoices: [],
    mutations: [],
    scoreGainMul: 1,
    boostDrainMul: 1,
    speedBonusMul: 1,
    turnBonusMul: 1,
    gasTrail: false,
    gasAccMs: 0,
    baitBomb: false,
    baitAccMs: 0,
    hyperMetabolism: false,
    metabolismAcc: 0,
    massDecayAcc: 0,
    spikedTailStacks: 0,
    toxicTrailStacks: 0,
    boostBurnUntil: 0,
    boostBurnStacks: 0,
    boostBurnAcc: 0,
    gasDebuffUntil: 0,
    iceSlipUntil: 0,
    turnLockUntil: 0,
    plasmaDamageAcc: 0,
    skill: SKIN_BASE_SKILL[skin] ?? CLASS_BASE_SKILL[dna],
    skillCooldownUntil: 0,
    skillActiveUntil: 0,
    skillHeld: false,
    chronoHistory: [{ t: Date.now(), x: spawn.x, y: spawn.y, angle: startAngle, scoreAcc: START_MASS, len: initialSegments }],
    chronoNextSampleAt: Date.now() + CHRONO_HISTORY_SAMPLE_MS,
    chronoRewindStartAt: 0,
    chronoRewindUntil: 0,
    chronoRewindPath: [],
    chronoTargetScoreAcc: START_MASS,
    chronoTargetLen: initialSegments,
    magnetUntil: 0,
    goldrushUntil: 0,
    overchargeUntil: 0,
    angle: startAngle,
    inputAngle: startAngle,
    boost: false,
    boostBlend: 0,
    boostDrain: 0,
    growthAcc: 0,
    growthApplyAcc: 0,
    spawnedAt: Date.now(),
    isBot: options?.isBot ?? false,
  };
}

function resetPlayerForLobbyChoice(player: Player, dna: WormClass, skin: WormSkin, color?: number): void {
  player.dna = dna;
  player.skin = skin;
  if (typeof color === 'number' && Number.isFinite(color)) {
    player.color = color;
  }
  player.armor = dna === 'iron' ? 2 : 0;
  player.scoreAcc = START_MASS;
  player.score = START_MASS;
  player.evoStage = 0;
  player.nextEvoScore = EVO_THRESHOLDS[0];
  player.offerIndex = 0;
  player.nextOfferScore = OFFER_MILESTONES[0] ?? EVO_THRESHOLDS[0];
  player.pendingStage = 0;
  player.pendingChoices = [];
  player.mutations = [];

  player.scoreGainMul = 1;
  player.boostDrainMul = 1;
  player.speedBonusMul = 1;
  player.turnBonusMul = 1;

  player.gasTrail = false;
  player.gasAccMs = 0;
  player.baitBomb = false;
  player.baitAccMs = 0;
  player.hyperMetabolism = false;
  player.metabolismAcc = 0;
  player.massDecayAcc = 0;

  player.spikedTailStacks = 0;
  player.toxicTrailStacks = 0;
  player.boostBurnUntil = 0;
  player.boostBurnStacks = 0;
  player.boostBurnAcc = 0;
  player.gasDebuffUntil = 0;
  player.iceSlipUntil = 0;
  player.turnLockUntil = 0;
  player.plasmaDamageAcc = 0;

  player.skill = SKIN_BASE_SKILL[skin] ?? CLASS_BASE_SKILL[dna];
  player.skillCooldownUntil = 0;
  player.skillActiveUntil = 0;
  player.skillHeld = false;
  const head = player.segments[0] ?? { x: 0, y: 0 };
  player.chronoHistory = [{ t: Date.now(), x: head.x, y: head.y, angle: player.angle, scoreAcc: START_MASS, len: player.segments.length }];
  player.chronoNextSampleAt = Date.now() + CHRONO_HISTORY_SAMPLE_MS;
  player.chronoRewindStartAt = 0;
  player.chronoRewindUntil = 0;
  player.chronoRewindPath = [];
  player.chronoTargetScoreAcc = START_MASS;
  player.chronoTargetLen = player.segments.length;
  player.magnetUntil = 0;
  player.goldrushUntil = 0;
  player.overchargeUntil = 0;

  player.slowUntil = 0;
  player.stealthUntil = 0;
  player.phaseUntil = 0;
  player.invulnerableUntil = 0;
  player.bunkerUntil = 0;

  player.boost = false;
  player.boostBlend = 0;
  player.boostDrain = 0;
  player.growthAcc = 0;
  player.growthApplyAcc = 0;
}

function grow(player: Player, amount: number): void {
  const tail = player.segments[player.segments.length - 1];
  if (!tail) return;

  for (let i = 0; i < amount; i++) {
    player.segments.push({ x: tail.x, y: tail.y });
  }
}

function applyQueuedGrowth(player: Player): void {
  if (player.growthAcc < 1) {
    player.growthApplyAcc = 0;
    return;
  }

  player.growthApplyAcc += GROWTH_APPLY_RATE * DT;
  if (player.growthApplyAcc < 1) return;

  // Apply at most 1 segment per tick for smoothness.
  player.growthApplyAcc -= 1;
  player.growthAcc -= 1;
  grow(player, 1);
}

function initBot(id: string): Player {
  const profile = botProfiles.get(id);
  if (!profile) {
    throw new Error(`Unknown bot profile: ${id}`);
  }

  const bot = createPlayer(id, profile.name, { color: profile.color, isBot: true, dna: profile.dna, skin: profile.skin });
  bot.ai = {
    target: randomSpawnPoint(),
    nextDecisionAt: 0,
    boostUntil: 0,
  };
  return bot;
}

function scheduleBotRespawn(id: string): void {
  if (!botProfiles.has(id)) return;
  const delay = BOT_RESPAWN_MS + rand(0, 650);
  setTimeout(() => {
    if (players.has(id)) return;
    players.set(id, initBot(id));
  }, delay);
}

function chooseBotTarget(head: Vec2): Vec2 {
  const avoidEdge = 720;
  if (head.x * head.x + head.y * head.y > Math.pow(ARENA_RADIUS - avoidEdge, 2)) {
    return { x: 0, y: 0 };
  }

  // Prefer nearby food if any, otherwise wander.
  let best: Food | undefined;
  let bestD2 = 1100 * 1100;
  for (const f of foods.values()) {
    const d2 = dist2(head, f);
    if (d2 < bestD2) {
      best = f;
      bestD2 = d2;
    }
  }

  if (best) return { x: best.x, y: best.y };

  const r = rand(600, 1400);
  const a = rand(-Math.PI, Math.PI);
  return clampToArena({ x: head.x + Math.cos(a) * r, y: head.y + Math.sin(a) * r }, HEAD_RADIUS + 120);
}

function stepBot(player: Player, now: number): void {
  if (!player.ai) return;
  const head = player.segments[0];
  if (!head) return;

  let nearestThreatD2 = Infinity;
  let threat: Vec2 | undefined;
  for (const other of players.values()) {
    if (other.id === player.id) continue;
    const oh = other.segments[0];
    if (!oh) continue;
    const d2 = dist2(head, oh);
    if (d2 < nearestThreatD2) {
      nearestThreatD2 = d2;
      threat = oh;
    }
  }

  const threatRadius = 220;
  if (threat && nearestThreatD2 < threatRadius * threatRadius) {
    // Flee.
    player.inputAngle = Math.atan2(head.y - threat.y, head.x - threat.x);
    player.ai.boostUntil = now + rand(180, 380);
    player.boost = player.dna === 'shadow' || player.segments.length > MIN_SEGMENTS + 6;
    return;
  }

  const tx = player.ai.target.x - head.x;
  const ty = player.ai.target.y - head.y;
  const closeToTarget = tx * tx + ty * ty < 260 * 260;

  if (now >= player.ai.nextDecisionAt || closeToTarget) {
    player.ai.target = chooseBotTarget(head);
    player.ai.nextDecisionAt = now + rand(250, 520);
  }

  const targetAngle = Math.atan2(player.ai.target.y - head.y, player.ai.target.x - head.x);
  player.inputAngle = normalizeAngle(targetAngle);

  const wantsBoost = now < player.ai.boostUntil;
  player.boost = wantsBoost && (player.dna === 'shadow' || player.segments.length > MIN_SEGMENTS + 6);
}

function stepSkillHolds(player: Player, now: number): void {
  if (!player.skillHeld) return;
  if (player.pendingStage !== 0) {
    player.skillHeld = false;
    return;
  }

  if (player.skill === 'shadow_phantom_decoy') {
    const cooldownMs = skillCooldownMs(player.dna, player.skill) ?? 18000;
    const energy = skillEnergyFraction(player, now, cooldownMs);
    if (energy <= 0.001) {
      player.skillHeld = false;
      return;
    }

    player.skillActiveUntil = Math.max(player.skillActiveUntil, now + SHADOW_CLOAK_REFRESH_MS);
    player.stealthUntil = Math.max(player.stealthUntil, now + SHADOW_CLOAK_REFRESH_MS);

    const drainFactor = 1 + cooldownMs / Math.max(1, SHADOW_CLOAK_FULL_DRAIN_MS);
    player.skillCooldownUntil = Math.max(now, player.skillCooldownUntil) + DT * 1000 * drainFactor;
    player.skillCooldownUntil = Math.min(player.skillCooldownUntil, now + cooldownMs);
    return;
  }

  if (player.skill === 'skill_venom_gas') {
    const cooldownMs = skillCooldownMs(player.dna, player.skill) ?? 25000;
    const energy = skillEnergyFraction(player, now, cooldownMs);
    if (energy <= 0.001) {
      player.skillHeld = false;
      return;
    }

    // Treat as a toggle-able energy skill. Energy drains only while boosting, but the toggle stays "armed".
    player.skillActiveUntil = Math.max(player.skillActiveUntil, now + VENOM_GAS_REFRESH_MS);
    const draining = player.boost && player.segments.length > MIN_SEGMENTS;
    if (!draining) return;

    const drainFactor = 1 + cooldownMs / Math.max(1, VENOM_GAS_FULL_DRAIN_MS);
    player.skillCooldownUntil = Math.max(now, player.skillCooldownUntil) + DT * 1000 * drainFactor;
    player.skillCooldownUntil = Math.min(player.skillCooldownUntil, now + cooldownMs);
    return;
  }

  player.skillHeld = false;
}

function stepPlayer(player: Player, now: number): boolean {
  const head = player.segments[0];
  if (!head) return true;

  if (player.chronoRewindUntil > 0) {
    if (now < player.chronoRewindUntil) {
      stepChronoRewind(player, now);
      return true;
    }
    finishChronoRewind(player);
    return true;
  }

  // Environmental debuffs (gas / ice).
  if (isInsideGas(head)) player.gasDebuffUntil = Math.max(player.gasDebuffUntil, now + GAS_DEBUFF_LINGER_MS);
  if (isInsideIce(head, player.id)) player.iceSlipUntil = Math.max(player.iceSlipUntil, now + FROST_SLIP_LINGER_MS);

  const classCfg = classConfig(player.dna);
  const bunkered = isBunkerDownActive(player, now);
  if (bunkered) player.boost = false;

  stepSkillHolds(player, now);

  const desiredBoost = !bunkered && player.boost && player.segments.length > MIN_SEGMENTS;
  const blendDelta = desiredBoost ? BOOST_BLEND_UP : -BOOST_BLEND_DOWN;
  player.boostBlend = clamp(player.boostBlend + blendDelta * DT, 0, 1);

  const len = player.segments.length;
  const headR = headRadiusForPlayer(player);
  const lengthSpeedFactor = clamp(1.08 - len / 520, 0.74, 1.06);
  let speedMul = player.speedBonusMul;
  let turnMul = 1;
  if (now < player.overchargeUntil) {
    speedMul *= 1.22;
    turnMul *= 1.1;
  }
  if (now < player.slowUntil) {
    speedMul *= 0.68;
    turnMul *= 0.85;
  }
  if (player.skill === 'ultimate_iron_charge' && now < player.skillActiveUntil) {
    speedMul *= 1.42;
    turnMul *= 0.92;
  }
  if (player.skill === 'ultimate_shadow_dash' && now < player.skillActiveUntil) {
    speedMul *= 1.55;
    turnMul *= 1.15;
  }
  if (player.skill === 'skill_eel_overdrive' && now < player.skillActiveUntil) {
    speedMul *= 1.85;
    turnMul *= 1.12;
  }
  if (now < player.iceSlipUntil) {
    turnMul *= FROST_SLIP_TURN_MUL;
  }

  const base = BASE_SPEED * classCfg.baseMul * speedMul;
  const boost = BOOST_SPEED * classCfg.boostMul * speedMul;
  const speedPerSec = bunkered ? 0 : (base + (boost - base) * player.boostBlend) * lengthSpeedFactor;
  const speed = speedPerSec * DT;

  turnMul *= player.turnBonusMul;
  turnMul *= turnPenaltyForMass(player.scoreAcc);
  const baseTurnRate = (desiredBoost ? 4.4 : 6.2) * classCfg.turnMul * turnMul; // rad/sec
  const lengthTurnFactor = clamp(1.12 - len / 260, 0.52, 1.05);
  const maxTurn = baseTurnRate * lengthTurnFactor * DT;
  const inputAngle = now < player.turnLockUntil ? player.angle : player.inputAngle;
  const turn = clamp(normalizeAngle(inputAngle - player.angle), -maxTurn, maxTurn);
  player.angle = normalizeAngle(player.angle + turn);

  const next = { x: head.x + Math.cos(player.angle) * speed, y: head.y + Math.sin(player.angle) * speed };
  if (isOutsideArena(next, headR)) {
    killPlayer(player, '벽에 충돌');
    return false;
  }
  head.x = next.x;
  head.y = next.y;

  updateHeadTrail(player);
  applyTrailToSegments(player);

  if (!desiredBoost) {
    player.boostDrain = 0;
  } else if (classCfg.boostDrainMul <= 0) {
    player.boostDrain = 0;
  } else {
    const gasMul = now < player.gasDebuffUntil ? GAS_BOOST_DRAIN_MUL : 1;
    player.boostDrain += BOOST_DRAIN_RATE * DT * classCfg.boostDrainMul * player.boostDrainMul * gasMul;
    while (player.boostDrain >= 1) {
      player.boostDrain -= 1;
      if (player.segments.length <= MIN_SEGMENTS) break;
      const tail = player.segments[player.segments.length - 1];
      if (!tail) break;

      player.segments.pop();
      player.scoreAcc = Math.max(0, player.scoreAcc - 1);
      player.score = Math.max(0, Math.floor(player.scoreAcc));
      spawnFood({ x: tail.x + rand(-6, 6), y: tail.y + rand(-6, 6) }, 1, player.color, 'boost');
    }
  }

  // Spiked Tail debuff: drains "boost gauge" (segments above minimum) over time.
  if (now < player.boostBurnUntil && player.boostBurnStacks > 0) {
    const burnBudget = Math.max(0, player.segments.length - MIN_SEGMENTS);
    const burnPerSec = clamp(burnBudget * 0.1 * player.boostBurnStacks, 0, 18);
    player.boostBurnAcc += burnPerSec * DT;
    while (player.boostBurnAcc >= 1) {
      player.boostBurnAcc -= 1;
      if (player.segments.length <= MIN_SEGMENTS) break;
      player.segments.pop();
      player.scoreAcc = Math.max(0, player.scoreAcc - 1);
      player.score = Math.max(0, Math.floor(player.scoreAcc));
    }
  } else {
    player.boostBurnStacks = 0;
    player.boostBurnAcc = 0;
  }

  // Bait bombs (passive, stage 2).
  if (desiredBoost && player.baitBomb) {
    player.baitAccMs += DT * 1000;
    if (player.baitAccMs >= BAIT_BOMB_INTERVAL_MS) {
      player.baitAccMs = 0;
      const tail = player.segments[player.segments.length - 1];
      if (tail) {
        spawnFood({ x: tail.x + rand(-8, 8), y: tail.y + rand(-8, 8) }, 1, 0xf2505d, 'bomb');
      }
    }
  } else {
    player.baitAccMs = 0;
  }

  // Toxic gas trail.
  const smokescreen = player.skill === 'ultimate_shadow_smokescreen' && now < player.skillActiveUntil;
  const venomGas = player.skill === 'skill_venom_gas' && player.skillHeld && desiredBoost;
  if (player.gasTrail || venomGas || smokescreen) {
    player.gasAccMs += DT * 1000;
    const interval = smokescreen ? 120 : venomGas ? 110 : GAS_DROP_INTERVAL_MS;
    if (player.gasAccMs >= interval) {
      player.gasAccMs = 0;
      const base = smokescreen ? head : player.segments[player.segments.length - 1];
      if (base) {
        const pos = smokescreen ? { x: base.x + rand(-90, 90), y: base.y + rand(-90, 90) } : { x: base.x, y: base.y };
        const cloud: GasCloud = {
          id: String(nextGasId++),
          x: pos.x,
          y: pos.y,
          r: smokescreen ? GAS_RADIUS * 1.2 : GAS_RADIUS,
          expiresAt: now + GAS_DURATION_MS + player.toxicTrailStacks * 1000,
        };
        gasClouds.set(cloud.id, cloud);
      }
    }
  } else {
    player.gasAccMs = 0;
  }

  if (player.hyperMetabolism) {
    player.metabolismAcc += HYPER_METABOLISM_DECAY_RATE * DT;
    while (player.metabolismAcc >= 1) {
      player.metabolismAcc -= 1;
      if (player.segments.length <= MIN_SEGMENTS) break;
      player.segments.pop();
      player.scoreAcc = Math.max(0, player.scoreAcc - 1);
      player.score = Math.max(0, Math.floor(player.scoreAcc));
    }
  } else {
    player.metabolismAcc = 0;
  }

  // Mass decay: starts above 1000 score and forces large worms to keep farming/fighting.
  if (player.scoreAcc > MASS_DECAY_START) {
    const before = player.scoreAcc;
    const decayMul = player.dna === 'iron' ? IRON_MASS_DECAY_MUL : 1;
    const decay = before * MASS_DECAY_RATE * decayMul * DT;
    player.scoreAcc = Math.max(START_MASS, before - decay);
    player.score = Math.max(0, Math.floor(player.scoreAcc));

    const lost = before - player.scoreAcc;
    player.massDecayAcc += lost * MASS_DECAY_SEGMENT_MUL;
    while (player.massDecayAcc >= 1) {
      player.massDecayAcc -= 1;
      if (player.segments.length <= MIN_SEGMENTS) break;
      player.segments.pop();
    }
  } else {
    player.massDecayAcc = 0;
  }

  // Apply queued growth smoothly (throttled), so food doesn't cause big one-frame length jumps.
  applyQueuedGrowth(player);

  recordChronoHistory(player, now);
  trimTrail(player);
  return true;
}

function tryEatFood(player: Player, now: number): void {
  const head = player.segments[0];
  if (!head) return;

  const classCfg = classConfig(player.dna);
  const headR = headRadiusForPlayer(player);
  const maxFoodR = FOOD_BASE_R + 3 + 2;
  let eatR = (headR + maxFoodR + 4) * classCfg.eatMul;
  if (now < player.magnetUntil) eatR *= 4;

  const viperBlender = player.skill === 'skill_viper_blender' && now < player.skillActiveUntil;
  const voidMaw = player.skill === 'skill_void_maw' && now < player.skillActiveUntil;
  if (viperBlender) eatR *= 1.25;
  if (voidMaw) eatR *= 1.15;
  const eatR2 = eatR * eatR;

  const magneticPull = player.dna === 'magnetic';
  let pullR = magneticPull ? (isSingularityActive(player, now) ? MAGNET_PULL_RADIUS_SINGULARITY : MAGNET_PULL_RADIUS) : 0;
  let pullMinSpeed = MAGNET_PULL_MIN_SPEED;
  let pullMaxSpeed = MAGNET_PULL_MAX_SPEED;
  let coneCos = -1;

  if (viperBlender) {
    pullR = Math.max(pullR, VIPER_PULL_RADIUS);
    pullMinSpeed = 180;
    pullMaxSpeed = 2600;
    coneCos = -1;
  } else if (voidMaw) {
    pullR = Math.max(pullR, VOID_MAW_PULL_RADIUS);
    pullMinSpeed = 220;
    pullMaxSpeed = 3100;
    coneCos = Math.cos(VOID_MAW_HALF_ANGLE);
  }

  const pullR2 = pullR * pullR;
  const forwardX = Math.cos(player.angle);
  const forwardY = Math.sin(player.angle);

  const queryR = Math.max(eatR, pullR);
  const range = Math.max(1, Math.ceil(queryR / GRID_CELL_SIZE));
  const nearbyFoods = foodGrid.getNearby(head.x, head.y, range);
  for (const food of nearbyFoods) {
    if (!foods.has(food.id)) continue; // may have been eaten earlier this tick

    // Pull food toward the head before the eat check (magnetic passive / skin skills).
    if (pullR > 0 && food.kind !== 'bomb') {
      const dx = head.x - food.x;
      const dy = head.y - food.y;
      const d2 = dx * dx + dy * dy;
      if (d2 > 0.001 && d2 <= pullR2) {
        let allow = true;
        const d = Math.sqrt(d2) || 1;
        if (coneCos > -0.99) {
          const dot = (dx / d) * forwardX + (dy / d) * forwardY;
          allow = dot >= coneCos;
        }

        if (allow) {
          const t = clamp(1 - d / pullR, 0, 1);
          const strength = t * t;
          const speed = pullMinSpeed + (pullMaxSpeed - pullMinSpeed) * strength;
          const step = Math.min(d, speed * DT);

          const oldX = food.x;
          const oldY = food.y;
          const moved = clampToArena({ x: food.x + (dx / d) * step, y: food.y + (dy / d) * step }, food.r + 6);
          food.x = moved.x;
          food.y = moved.y;
          foodGrid.remove(food, oldX, oldY);
          foodGrid.add(food, food.x, food.y);
        }
      }
    }

    const eatD2 = dist2(head, food);
    if (eatD2 > eatR2) continue;

    foods.delete(food.id);
    foodGrid.remove(food, food.x, food.y);

    if (food.kind === 'bomb') {
      player.scoreAcc = Math.max(0, player.scoreAcc - 12);
      player.score = Math.max(0, Math.floor(player.scoreAcc));
      const shrink = Math.min(8, Math.max(0, player.segments.length - MIN_SEGMENTS));
      for (let i = 0; i < shrink; i++) player.segments.pop();
      continue;
    }

    const scoreGain = 1 * player.scoreGainMul * (now < player.goldrushUntil ? 2 : 1);
    player.scoreAcc += scoreGain;
    player.score = Math.max(0, Math.floor(player.scoreAcc));

    const growthUnitsBase = food.kind === 'corpse' ? food.value * CORPSE_GROWTH_PER_VALUE : food.value * FOOD_GROWTH_PER_VALUE;
    const growthUnits = growthUnitsBase * (player.hyperMetabolism ? HYPER_METABOLISM_GROWTH_MUL : 1);
    player.growthAcc += growthUnits;
  }
}

function killPlayer(player: Player, reason: string, killerDna?: WormClass): void {
  const score = player.score;
  const shadowKillRewardMul = killerDna === 'shadow' ? SHADOW_KILL_REWARD_MUL : 1;
  const wallCrash = reason.includes('벽') || reason.includes('경계');
  const head = player.segments[0];
  if (head) spectatorCenters.set(player.id, { x: head.x, y: head.y });

  // Remove owned decoys.
  for (const [id, decoy] of decoys) {
    if (decoy.ownerId === player.id) decoys.delete(id);
  }

  // Remove owned ice zones.
  for (const [id, zone] of iceZones) {
    if (zone.ownerId === player.id) iceZones.delete(id);
  }

  // Wall crash: extra burst of pellets so it reads as an explosion.
  if (wallCrash) {
    if (head) {
      for (let i = 0; i < 18; i++) {
        const value = Math.random() < 0.22 ? 2 : 1;
        spawnFood({ x: head.x + rand(-140, 140), y: head.y + rand(-140, 140) }, value, player.color, 'corpse');
      }
    }
  }

  // Convert worm body into food.
  for (let i = 0; i < player.segments.length; i += 2) {
    const seg = player.segments[i];
    if (!seg) continue;

    const bigChance = i === 0 ? 0.3 : 0.08;
    const value = Math.random() < bigChance ? 3 : 1;
    spawnFood({ x: seg.x + rand(-10, 10), y: seg.y + rand(-10, 10) }, value, player.color, 'corpse');
  }

  // Shadow Snake: +20% kill reward by spawning ~20% extra corpse mass (expected value).
  if (shadowKillRewardMul > 1) {
    const chance = clamp(shadowKillRewardMul - 1, 0, 1);
    for (let i = 1; i < player.segments.length; i += 2) {
      if (Math.random() > chance) continue;
      const seg = player.segments[i];
      if (!seg) continue;
      const value = Math.random() < 0.08 ? 3 : 1;
      spawnFood({ x: seg.x + rand(-10, 10), y: seg.y + rand(-10, 10) }, value, player.color, 'corpse');
    }
  }

  players.delete(player.id);
  if (!player.isBot) {
    io.to(player.id).emit('dead', { reason, score });
  } else {
    scheduleBotRespawn(player.id);
  }
}

function stepBlackHoles(now: number): void {
  for (const hole of blackHoles.values()) {
    const owner = players.get(hole.ownerId);
    if (!owner) continue;

    const pullR = SINGULARITY_PULL_RADIUS;
    const pullR2 = pullR * pullR;

    for (const food of foods.values()) {
      const dx = hole.x - food.x;
      const dy = hole.y - food.y;
      const d2 = dx * dx + dy * dy;
      if (d2 > pullR2) continue;

      if (d2 <= hole.r * hole.r) {
        foods.delete(food.id);
        if (food.kind === 'bomb') continue;

        const scoreGain = 1 * owner.scoreGainMul * (now < owner.goldrushUntil ? 2 : 1);
        owner.scoreAcc += scoreGain;
        owner.score = Math.max(0, Math.floor(owner.scoreAcc));

        const growthUnitsBase =
          food.kind === 'corpse' ? food.value * CORPSE_GROWTH_PER_VALUE : food.value * FOOD_GROWTH_PER_VALUE;
        const growthUnits = growthUnitsBase * (owner.hyperMetabolism ? HYPER_METABOLISM_GROWTH_MUL : 1);
        owner.growthAcc += growthUnits;
        continue;
      }

      const d = Math.sqrt(d2) || 1;
      const t = 1 - d / pullR;
      const strength = t * t;
      const pullSpeed = 640;
      const step = pullSpeed * strength * DT;
      food.x += (dx / d) * step;
      food.y += (dy / d) * step;
    }
  }
}

function handleCollisions(now: number): void {
  const list = Array.from(players.values());
  const toKill = new Map<string, { reason: string; killerDna?: WormClass }>();

  const radii = new Map<string, { head: number; body: number }>();
  for (const p of list) {
    radii.set(p.id, { head: headRadiusForPlayer(p), body: bodyRadiusForPlayer(p) });
  }

  // Singularity: pull small worms toward the black hole.
  for (const hole of blackHoles.values()) {
    const owner = players.get(hole.ownerId);
    if (!owner) continue;

    const pullRadius = SINGULARITY_PULL_RADIUS;
    const pullRadius2 = pullRadius * pullRadius;
    const ownerLen = owner.segments.length;
    const smallLimit = Math.max(MIN_SEGMENTS + 10, Math.floor(ownerLen * 0.72));

    for (const other of list) {
      if (other.id === owner.id) continue;
      if (now - other.spawnedAt < SPAWN_INVULNERABLE_MS) continue;
      if (isPhaseActive(other, now)) continue;
      if (isInvulnerableActive(other, now)) continue;
      if (other.segments.length > smallLimit) continue;

      const oh = other.segments[0];
      if (!oh) continue;
      const dx = hole.x - oh.x;
      const dy = hole.y - oh.y;
      const d2 = dx * dx + dy * dy;
      if (d2 > pullRadius2 || d2 === 0) continue;
      const d = Math.sqrt(d2);
      const strength = (1 - d / pullRadius) * 460 * DT;
      pushWholeWorm(other, (dx / d) * strength, (dy / d) * strength);
    }
  }

  // Crimson Viper: spin knockback.
  for (const p of list) {
    if (p.skill !== 'skill_viper_blender') continue;
    if (now >= p.skillActiveUntil) continue;
    if (isPhaseActive(p, now)) continue;
    const ph = p.segments[0];
    if (!ph) continue;

    const radius = 520;
    const radius2 = radius * radius;
    for (const other of list) {
      if (other.id === p.id) continue;
      if (toKill.has(other.id)) continue;
      if (now - other.spawnedAt < SPAWN_INVULNERABLE_MS) continue;
      if (isPhaseActive(other, now)) continue;
      if (isInvulnerableActive(other, now)) continue;
      const oh = other.segments[0];
      if (!oh) continue;
      const dx = oh.x - ph.x;
      const dy = oh.y - ph.y;
      const d2 = dx * dx + dy * dy;
      if (d2 > radius2 || d2 === 0) continue;
      const d = Math.sqrt(d2) || 1;
      const strength = (1 - d / radius) * 980 * DT;
      pushWholeWorm(other, (dx / d) * strength, (dy / d) * strength);
    }
  }

  // Head-to-head: shorter loses (or both if same length).
  for (let i = 0; i < list.length; i++) {
    const a = list[i]!;
    if (toKill.has(a.id)) continue;
    if (now - a.spawnedAt < SPAWN_INVULNERABLE_MS) continue;
    const ah = a.segments[0];
    if (!ah) continue;

    for (let j = i + 1; j < list.length; j++) {
      const b = list[j]!;
      if (toKill.has(b.id)) continue;
      if (now - b.spawnedAt < SPAWN_INVULNERABLE_MS) continue;
      const bh = b.segments[0];
      if (!bh) continue;
      if (isPhaseActive(a, now) || isPhaseActive(b, now)) continue;

      const ra = radii.get(a.id)?.head ?? HEAD_RADIUS;
      const rb = radii.get(b.id)?.head ?? HEAD_RADIUS;
      const headHeadR = (ra + rb) * 1.05;
      if (dist2(ah, bh) > headHeadR * headHeadR) continue;

      const aSiege = isSiegeBreakerActive(a, now);
      const bSiege = isSiegeBreakerActive(b, now);
      const aThorns = a.skill === 'skill_scarab_thorns' && now < a.skillActiveUntil;
      const bThorns = b.skill === 'skill_scarab_thorns' && now < b.skillActiveUntil;

      const aLen = a.segments.length;
      const bLen = b.segments.length;
      let killA = false;
      let killB = false;

      const aHitBySiege = bSiege && !aSiege;
      const bHitBySiege = aSiege && !bSiege;

      if (aSiege && bSiege) {
        killA = false;
        killB = false;
      } else if (aSiege) {
        killA = false;
        killB = true;
      } else if (bSiege) {
        killA = true;
        killB = false;
      } else if (aThorns && !bThorns) {
        killA = false;
        killB = true;
      } else if (bThorns && !aThorns) {
        killA = true;
        killB = false;
      } else if (a.dna === 'shadow' || b.dna === 'shadow') {
        killA = a.dna === 'shadow';
        killB = b.dna === 'shadow';
      } else if (aLen === bLen) {
        killA = true;
        killB = true;
      } else if (aLen < bLen) {
        killA = true;
      } else {
        killB = true;
      }

      if (killA && a.dna === 'iron' && a.armor > 0 && !aHitBySiege) {
        a.armor -= 1;
        killA = false;
        grantIronArmorBoost(a);

        const dx = bh.x - ah.x;
        const dy = bh.y - ah.y;
        const d = Math.sqrt(dx * dx + dy * dy) || 1;
        const k = (headHeadR * 2.3) / d;
        const px = dx * k;
        const py = dy * k;
        for (const seg of b.segments) {
          seg.x += px;
          seg.y += py;
        }
      }
      if (killB && b.dna === 'iron' && b.armor > 0 && !bHitBySiege) {
        b.armor -= 1;
        killB = false;
        grantIronArmorBoost(b);

        const dx = ah.x - bh.x;
        const dy = ah.y - bh.y;
        const d = Math.sqrt(dx * dx + dy * dy) || 1;
        const k = (headHeadR * 2.3) / d;
        const px = dx * k;
        const py = dy * k;
        for (const seg of a.segments) {
          seg.x += px;
          seg.y += py;
        }
      }

      if (killA && isInvulnerableActive(a, now)) killA = false;
      if (killB && isInvulnerableActive(b, now)) killB = false;

      if (killA) toKill.set(a.id, { reason: '정면충돌', killerDna: b.dna });
      if (killB) toKill.set(b.id, { reason: '정면충돌', killerDna: a.dna });
    }
  }

  // Rebuild the body grid after positional adjustments (singularity pull, armor pushes).
  playerGrid.clear();
  for (const p of list) {
    for (let i = PLAYER_GRID_SKIP_NECK; i < p.segments.length; i += PLAYER_GRID_SAMPLE_STEP) {
      const seg = p.segments[i];
      if (!seg) continue;
      playerGrid.add({ seg, playerId: p.id }, seg.x, seg.y);
    }
  }

  for (const player of list) {
    if (toKill.has(player.id)) continue;
    if (now - player.spawnedAt < SPAWN_INVULNERABLE_MS) continue;
    if (isPhaseActive(player, now)) continue;

    const siege = isSiegeBreakerActive(player, now);
    const voidStrike = isVoidStrikeActive(player, now);
    const invulnerable = isInvulnerableActive(player, now);

    const head = player.segments[0];
    if (!head) continue;

    const headR = radii.get(player.id)?.head ?? HEAD_RADIUS;
    const nearbySegments = playerGrid.getNearby(head.x, head.y);
    for (const entry of nearbySegments) {
      if (entry.playerId === player.id) continue; // skip self

      const other = players.get(entry.playerId);
      if (!other) continue;
      if (isPhaseActive(other, now)) continue;

      const bodyR = radii.get(other.id)?.body ?? BODY_RADIUS;
      const collisionR = headR * 0.85 + bodyR * 0.95;
      const collisionR2 = collisionR * collisionR;
      const spikedStacks = other.spikedTailStacks;
      const burnR2 = (collisionR * 1.55) * (collisionR * 1.55);

      const d2 = dist2(head, entry.seg);

      // Thunder Eel: electric field breaks steering briefly.
      if (!siege && !voidStrike && !invulnerable && other.skill === 'skill_eel_overdrive' && now < other.skillActiveUntil) {
        const fieldR = collisionR + EEL_FIELD_RADIUS_EXTRA;
        if (d2 <= fieldR * fieldR) {
          player.turnLockUntil = Math.max(player.turnLockUntil, now + EEL_FIELD_STUN_MS);
        }
      }

      if (spikedStacks > 0 && !siege && !voidStrike && !invulnerable && d2 <= burnR2) {
        player.boostBurnUntil = Math.max(player.boostBurnUntil, now + 450);
        player.boostBurnStacks = Math.max(player.boostBurnStacks, spikedStacks);
      }

      // Golden Scarab: thorns kill on contact (unless you're in an unstoppable state).
      if (!siege && !voidStrike && !invulnerable && other.skill === 'skill_scarab_thorns' && now < other.skillActiveUntil) {
        if (d2 <= collisionR2) {
          toKill.set(player.id, { reason: '황금 가시', killerDna: other.dna });
          break;
        }
      }

      if (d2 <= collisionR2) {
        if ((siege || voidStrike) && now - other.spawnedAt >= SPAWN_INVULNERABLE_MS && !isInvulnerableActive(other, now)) {
          toKill.set(other.id, { reason: siege ? '시즈 브레이커' : '보이드 스트라이크', killerDna: player.dna });
        } else if (!invulnerable) {
          toKill.set(player.id, { reason: '충돌', killerDna: other.dna });
          break;
        }
      }
    }
  }

  // Singularity: absorb small worms that get too close.
  for (const hole of blackHoles.values()) {
    const owner = players.get(hole.ownerId);
    if (!owner) continue;
    const absorbRadius2 = hole.r * hole.r;
    const ownerLen = owner.segments.length;
    const smallLimit = Math.max(MIN_SEGMENTS + 10, Math.floor(ownerLen * 0.72));

    for (const other of list) {
      if (other.id === owner.id) continue;
      if (toKill.has(other.id)) continue;
      if (now - other.spawnedAt < SPAWN_INVULNERABLE_MS) continue;
      if (isPhaseActive(other, now)) continue;
      if (isInvulnerableActive(other, now)) continue;
      if (other.segments.length > smallLimit) continue;

      const oh = other.segments[0];
      if (!oh) continue;
      const dx = oh.x - hole.x;
      const dy = oh.y - hole.y;
      if (dx * dx + dy * dy <= absorbRadius2) {
        toKill.set(other.id, { reason: '싱귤래리티', killerDna: owner.dna });
      }
    }
  }

  for (const [id, entry] of toKill) {
    const player = players.get(id);
    if (!player) continue;
    killPlayer(player, entry.reason, entry.killerDna);
  }
}

function foodStreamRadiusForLength(length: number): number {
  const extra = clamp((Math.sqrt(length) - 6) * 220, 0, 1600);
  return FOOD_STREAM_BASE_RADIUS + extra;
}

function foodStreamRadiusForPlayer(player: Player, now: number): number {
  let radius = foodStreamRadiusForLength(player.segments.length);
  if (player.dna === 'magnetic') radius *= 1.35;
  if (now < player.magnetUntil) radius *= 1.25;
  return radius;
}

function buildPlayersPayload(now: number): Record<string, PlayerState> {
  const playersOut: Record<string, PlayerState> = {};

  for (const player of players.values()) {
    playersOut[player.id] = {
      id: player.id,
      name: player.name,
      color: player.color,
      boost: player.boost && player.segments.length > MIN_SEGMENTS,
      dna: player.dna,
      skin: player.skin,
      armor: player.armor,
      stealth: isStealthActive(player, now),
      phase: isPhaseActive(player, now),
      evoStage: player.evoStage,
      nextEvoScore: player.evoStage >= 3 ? 0 : player.nextEvoScore,
      skill: player.skill,
      skillCdMs: Math.max(0, player.skillCooldownUntil - now),
      skillActive: now < player.skillActiveUntil,
      mutations: player.mutations,
      // Use enough precision for smooth, slow movement without bloating payloads.
      segments: player.segments.map((s) => ({ x: netPos(s.x), y: netPos(s.y) })),
      score: player.score,
    };
  }

  return playersOut;
}

function buildDecoysPayload(): DecoyState[] {
  const out: DecoyState[] = [];
  for (const decoy of decoys.values()) {
    out.push({
      id: decoy.id,
      ownerId: decoy.ownerId,
      name: decoy.name,
      color: decoy.color,
      dna: decoy.dna,
      skin: decoy.skin,
      originalLen: decoy.originalLen,
      segments: decoy.segments.map((s) => ({ x: netPos(s.x), y: netPos(s.y) })),
    });
  }
  return out;
}

function buildBlackHolesPayload(): BlackHoleState[] {
  const out: BlackHoleState[] = [];
  for (const hole of blackHoles.values()) {
    out.push({
      id: hole.id,
      ownerId: hole.ownerId,
      x: Math.round(hole.x),
      y: Math.round(hole.y),
      r: hole.r,
      expiresAt: hole.expiresAt,
    });
  }
  return out;
}

function buildLeaderboardPayload(): LeaderboardEntry[] {
  return Array.from(players.values())
    .sort((a, b) => b.score - a.score)
    .slice(0, 10)
    .map((p) => ({
      id: p.id,
      name: p.name,
      color: p.color,
      score: p.score,
    }));
}

type FoodCandidate = { d2: number; food: Food };

function swap<T>(arr: T[], i: number, j: number): void {
  const t = arr[i]!;
  arr[i] = arr[j]!;
  arr[j] = t;
}

function partition<T>(arr: T[], left: number, right: number, pivotIndex: number, compare: (a: T, b: T) => number): number {
  const pivot = arr[pivotIndex]!;
  swap(arr, pivotIndex, right);

  let store = left;
  for (let i = left; i < right; i++) {
    if (compare(arr[i]!, pivot) < 0) {
      swap(arr, store, i);
      store++;
    }
  }

  swap(arr, right, store);
  return store;
}

function quickselect<T>(
  arr: T[],
  left: number,
  right: number,
  k: number,
  compare: (a: T, b: T) => number,
): void {
  let l = left;
  let r = right;
  let kk = k;

  while (l < r) {
    let pivotIndex = (l + r) >> 1;
    pivotIndex = partition(arr, l, r, pivotIndex, compare);

    if (kk === pivotIndex) return;
    if (kk < pivotIndex) {
      r = pivotIndex - 1;
    } else {
      l = pivotIndex + 1;
    }
  }
}

function buildFoodsPayload(center: Vec2, radius: number): FoodState[] {
  const r2 = radius * radius;
  const candidates: FoodCandidate[] = [];

  for (const f of foods.values()) {
    const dx = f.x - center.x;
    const dy = f.y - center.y;
    const d2 = dx * dx + dy * dy;
    if (d2 > r2) continue;
    candidates.push({ d2, food: f });
  }

  if (candidates.length <= FOOD_STREAM_MAX) {
    return candidates.map(({ food }) => ({
      id: food.id,
      x: Math.round(food.x),
      y: Math.round(food.y),
      r: food.r,
      color: food.color,
      value: food.value,
    }));
  }

  const nearCount = Math.max(0, Math.min(FOOD_STREAM_MAX, Math.round(FOOD_STREAM_MAX * 0.82)));
  const farCount = Math.max(0, FOOD_STREAM_MAX - nearCount);

  const asc = (a: FoodCandidate, b: FoodCandidate) => a.d2 - b.d2;
  quickselect(candidates, 0, candidates.length - 1, nearCount - 1, asc);

  if (farCount > 0) {
    const desc = (a: FoodCandidate, b: FoodCandidate) => b.d2 - a.d2;
    const left = nearCount;
    const right = candidates.length - 1;
    const k = Math.min(right, left + farCount - 1);
    if (left <= right) {
      quickselect(candidates, left, right, k, desc);
    }
  }

  const selected = candidates.slice(0, FOOD_STREAM_MAX);
  return selected.map(({ food }) => ({
    id: food.id,
    x: Math.round(food.x),
    y: Math.round(food.y),
    r: food.r,
    color: food.color,
    value: food.value,
  }));
}

function buildGasPayload(center: Vec2, radius: number): GasState[] {
  const r2 = radius * radius;
  const out: GasState[] = [];
  for (const cloud of gasClouds.values()) {
    const dx = cloud.x - center.x;
    const dy = cloud.y - center.y;
    if (dx * dx + dy * dy > r2) continue;
    out.push({ id: cloud.id, x: Math.round(cloud.x), y: Math.round(cloud.y), r: cloud.r });
  }
  return out;
}

function buildIcePayload(center: Vec2, radius: number): IceState[] {
  const out: IceState[] = [];
  for (const zone of iceZones.values()) {
    const dx = zone.x - center.x;
    const dy = zone.y - center.y;
    const rr = radius + zone.r + 280;
    if (dx * dx + dy * dy > rr * rr) continue;
    out.push({
      id: zone.id,
      ownerId: zone.ownerId,
      x: Math.round(zone.x),
      y: Math.round(zone.y),
      r: zone.r,
      expiresAt: Math.round(zone.expiresAt),
    });
  }
  return out;
}

function trimGas(now: number): void {
  for (const [id, cloud] of gasClouds) {
    if (now >= cloud.expiresAt) gasClouds.delete(id);
  }
}

function trimIceZones(now: number): void {
  for (const [id, zone] of iceZones) {
    if (now >= zone.expiresAt || !players.has(zone.ownerId)) iceZones.delete(id);
  }
}

function trimDecoys(now: number): void {
  for (const [id, decoy] of decoys) {
    if (now >= decoy.expiresAt || !players.has(decoy.ownerId)) {
      decoys.delete(id);
      continue;
    }

    const bodyR = bodyRadiusForLength(decoy.originalLen) * classConfig(decoy.dna).hitboxBodyMul;
    for (const player of players.values()) {
      if (player.id === decoy.ownerId) continue;
      if (now - player.spawnedAt < SPAWN_INVULNERABLE_MS) continue;
      if (isPhaseActive(player, now)) continue;
      const head = player.segments[0];
      if (!head) continue;

      const headR = headRadiusForPlayer(player);
      const collisionR = headR * 0.85 + bodyR * 0.95;
      const collisionR2 = collisionR * collisionR;

      // Skip the decoy head to make "hit" feel less random.
      for (let i = 2; i < decoy.segments.length; i++) {
        const seg = decoy.segments[i];
        if (!seg) continue;
        if (dist2(head, seg) <= collisionR2) {
          decoys.delete(id);
          break;
        }
      }

      if (!decoys.has(id)) break;
    }
  }
}

function trimBlackHoles(now: number): void {
  for (const [id, hole] of blackHoles) {
    if (now >= hole.expiresAt || !players.has(hole.ownerId)) blackHoles.delete(id);
  }
}

io.on('connection', (socket: Socket<ClientToServerEvents, ServerToClientEvents>) => {
  console.log('A cat connected: ' + socket.id);

  const defaultName = 'Unknown';
  let currentName = defaultName;
  let currentClass: WormClass = 'shadow';
  let currentSkin: WormSkin = defaultSkinForClass(currentClass);
  const player = createPlayer(socket.id, currentName, { dna: currentClass });
  let currentColor = player.color;
  currentSkin = player.skin;
  players.set(socket.id, player);

  socket.emit('welcome', { id: socket.id, world: WORLD, tickRate: TICK_RATE });

  socket.on('join', ({ name, dna, skin }) => {
    const p = players.get(socket.id);
    if (!p) return;
    currentName = sanitizeName(name);

    const fallbackClass = sanitizeClass(dna);
    const requestedSkin = typeof skin === 'string' ? sanitizeSkin(skin) : defaultSkinForClass(fallbackClass);
    currentSkin = requestedSkin;
    currentClass = classForSkin(requestedSkin);
    currentColor = randomColorForSkin(requestedSkin);
    p.name = currentName;

    const canApplyNow =
      p.score === START_MASS && p.evoStage === 0 && Date.now() - p.spawnedAt < SPAWN_INVULNERABLE_MS + 1200;
    if (canApplyNow) {
      resetPlayerForLobbyChoice(p, currentClass, currentSkin, currentColor);
    }
  });

  socket.on('input', (data) => {
    const p = players.get(socket.id);
    if (!p) return;

    if (typeof data.angle === 'number' && Number.isFinite(data.angle)) {
      p.inputAngle = clamp(data.angle, -Math.PI, Math.PI);
    }
    if (typeof data.boost === 'boolean') {
      p.boost = data.boost;
    }
  });

  socket.on('ability', ({ type, action, x, y }) => {
    if (type !== 'skill') return;
    const p = players.get(socket.id);
    if (!p) return;
    const now = Date.now();
    const act = action ?? 'tap';
    handleSkillAction(p, now, act, typeof x === 'number' ? x : undefined, typeof y === 'number' ? y : undefined);
  });

  socket.on('chooseMutation', ({ id }) => {
    const p = players.get(socket.id);
    if (!p) return;
    if (p.pendingStage === 0) return;
    if (!p.pendingChoices.some((c) => c.id === id)) return;
    applyMutation(p, p.pendingStage, id, Date.now());
  });

  socket.on('respawn', () => {
    if (players.has(socket.id)) return;
    const p = createPlayer(socket.id, currentName, { dna: currentClass, skin: currentSkin, color: currentColor });
    players.set(socket.id, p);
  });

  socket.on('disconnect', () => {
    console.log('A cat left: ' + socket.id);
    spectatorCenters.delete(socket.id);
    players.delete(socket.id);
    for (const [id, decoy] of decoys) {
      if (decoy.ownerId === socket.id) decoys.delete(id);
    }
    for (const [id, hole] of blackHoles) {
      if (hole.ownerId === socket.id) blackHoles.delete(id);
    }
  });
});

// Game loop (server authoritative)
spawnFoodsUpToCap();

// Spawn some bots so solo play feels alive.
for (let i = 0; i < BOT_COUNT; i++) {
  const id = `bot-${i + 1}`;
  const r = Math.random();
  const dna: WormClass = r < 0.34 ? 'iron' : r < 0.67 ? 'shadow' : 'magnetic';
  const skin = randomSkinForClass(dna);
  botProfiles.set(id, {
    name: 'Unknown',
    color: randomColorForSkin(skin),
    dna,
    skin,
  });
  players.set(id, initBot(id));
}

setInterval(() => {
  const now = Date.now();

  // Trim transient entities.
  trimGas(now);
  trimIceZones(now);

  // Rebuild spatial grids for this tick.
  foodGrid.clear();
  playerGrid.clear();
  gasGrid.clear();
  iceGrid.clear();
  for (const food of foods.values()) {
    foodGrid.add(food, food.x, food.y);
  }
  for (const cloud of gasClouds.values()) {
    gasGrid.add(cloud, cloud.x, cloud.y);
  }
  for (const zone of iceZones.values()) {
    iceGrid.add(zone, zone.x, zone.y);
  }

  for (const player of players.values()) {
    if (player.isBot) stepBot(player, now);
    const alive = stepPlayer(player, now);
    if (!alive) continue;
    tryEatFood(player, now);
    updateProgression(player);
    maybeOfferMutation(player, now);
  }

  stepDecoys(now);
  stepPlasmaRays(now);

  stepBlackHoles(now);
  handleCollisions(now);
  trimDecoys(now);
  trimBlackHoles(now);
  spawnFoodsUpToCap();
  trimFoods();
  trimGas(now);
  trimIceZones(now);

  const playersOut = buildPlayersPayload(now);
  const decoysOut = buildDecoysPayload();
  const blackHolesOut = buildBlackHolesPayload();
  const leaderboard = buildLeaderboardPayload();

  for (const socket of io.sockets.sockets.values()) {
    const player = players.get(socket.id);
    const head = player?.segments[0];

    const center: Vec2 = head
      ? { x: head.x, y: head.y }
      : spectatorCenters.get(socket.id) ?? { x: 0, y: 0 };
    if (head) spectatorCenters.set(socket.id, center);

    const foodRadius = player && head ? foodStreamRadiusForPlayer(player, now) : FOOD_STREAM_BASE_RADIUS;
    socket.emit('state', {
      now,
      world: WORLD,
      players: playersOut,
      decoys: decoysOut,
      foods: buildFoodsPayload(center, foodRadius),
      gas: buildGasPayload(center, foodRadius),
      ice: buildIcePayload(center, foodRadius),
      blackHoles: blackHolesOut,
      leaderboard,
    });
  }
}, 1000 / TICK_RATE);

const PORT = 3000;
server.listen(PORT, () => {
  console.log(`Mewdle Server is running on http://localhost:${PORT}`);
});
