import * as THREE from 'three';
import type { Graphics } from 'pixi.js';
import { io, type Socket } from 'socket.io-client';

import { EVO_THRESHOLDS, MIN_SEGMENTS, skillCooldownMs } from '../shared/balance';

import type {
  ClientToServerEvents,
  BlackHoleState,
  DecoyState,
  FoodState,
  GasState,
  LeaderboardEntry,
  MutationChoice,
  MutationId,
  MutationOfferPayload,
  PlayerState,
  WormClass,
  ServerToClientEvents,
  StatePayload,
  Vec2,
  WelcomePayload,
  WorldConfig,
} from '../shared/protocol';

type Vec2f = { x: number; y: number };

type PlayerRender = {
  group: THREE.Group;
  body: THREE.InstancedMesh;
  spine: THREE.InstancedMesh;
  material: THREE.MeshStandardMaterial;
  spineMaterial: THREE.MeshStandardMaterial;
  head: THREE.Group;
  headMaterials: THREE.MeshStandardMaterial[];
  shadow: THREE.Mesh;
  aura: THREE.Mesh;
  nameSprite: THREE.Sprite;
  nameKey: string;
  segs: Vec2f[];
  targetSegs: Vec2f[];
  name: string;
  color: number;
  boosting: boolean;
  dna: WormClass;
  armor: number;
  stealth: boolean;
  phase: boolean;
  mutations: MutationId[];
  skillActive: boolean;
  isDecoy: boolean;
  ownerId?: string;
  spawnFx: number;
  eatFx: number;
  heading: number;
  headingValid: boolean;
  bank: number;
  scarf?: THREE.Mesh;
  magicCircle?: THREE.Mesh;
  visualLen: number;
  tailTip?: Vec2f;
  skinSeed: number;
  skinPalette: number[];
  skinStripe: number;
  skinOffset: number;
  styleDna: WormClass;
  styleColor: number;
  prevArmor: number;
  prevStealth: boolean;
};

type Particle = {
  kind: 'dot' | 'ring' | 'spark' | 'square';
  x: number;
  y: number;
  vx: number;
  vy: number;
  r: number;
  life: number;
  maxLife: number;
  color: number;
  alpha: number;
  lineWidth?: number;
  grow?: number;
  rot?: number;
  len?: number;
};

const HEAD_RADIUS = 18;
const BODY_RADIUS = 14;
const SEGMENT_SPACING = 12;
const SINGULARITY_RADIUS = 240;
const SINGULARITY_MAX_RANGE = 1400;

// Camera zoom rules:
// - Higher zoom = closer (less FOV), lower zoom = farther (more FOV)
// - "Min zoom" acts as a zoom-out cap (max view range)
const CAMERA_BASE_MIN_ZOOM = 0.8; // Max zoom-out without Eagle Eye (narrower view)
const CAMERA_ABS_MIN_ZOOM = 0.68; // Hard zoom-out cap (even with Eagle Eye)

// Banking (flight-sim feel): roll the camera/worm into turns based on turn rate (rad/sec).
// NOTE: Camera roll is intentionally kept near-zero for comfort (avoid motion sickness).
const CAMERA_BANK_MAX = 0.0; // radians
const CAMERA_BANK_TURN_RATE_FOR_MAX = 4.2;
const CAMERA_BANK_K = 10;

const WORM_BANK_MAX = 0.35; // radians (~20°)
const WORM_BANK_TURN_RATE_FOR_MAX = 4.6;
const WORM_BANK_K = 12;

const CLASS_ORDER: WormClass[] = ['iron', 'shadow', 'magnetic'];

const CLASS_META: Record<
  WormClass,
  { title: string; desc: string; stats: { defense: number; speed: number; farm: number } }
> = {
  iron: {
    title: 'Iron Worm',
    desc: 'Tank · Full Metal(겹겹이 중장갑/갑옷판) · Titan Plating(정면충돌 2회 방어). Stage2: Bunker Down(E) / Stage3: Siege Breaker.',
    stats: { defense: 0.95, speed: 0.42, farm: 0.48 },
  },
  shadow: {
    title: 'Shadow Snake',
    desc: 'Assassin · Cyber Ninja(매끈 바디슈트+에너지 스카프) · Optical Cloak(홀드 은신/게이지). Stage2: Optical Cloak(Hold E) / Stage3: Void Strike.',
    stats: { defense: 0.32, speed: 0.96, farm: 0.58 },
  },
  magnetic: {
    title: 'Magnetic Slug',
    desc: 'Mage · Arcana/Cosmic(별자리 바디+회전 마법진) · 블랙홀 컨셉. Stage2: Hyper-Metabolism / Stage3: Singularity(드래그 조준).',
    stats: { defense: 0.46, speed: 0.56, farm: 0.95 },
  },
};

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function countMutation(mutations: readonly MutationId[] | undefined, id: MutationId): number {
  if (!mutations) return 0;
  let n = 0;
  for (const m of mutations) if (m === id) n++;
  return n;
}

function normalizeAngle(angle: number): number {
  let a = angle;
  while (a > Math.PI) a -= Math.PI * 2;
  while (a < -Math.PI) a += Math.PI * 2;
  return a;
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

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function smoothFactor(k: number, dt: number): number {
  return 1 - Math.exp(-k * dt);
}

function rand(min: number, max: number): number {
  return Math.random() * (max - min) + min;
}

function shade(color: number, factor: number): number {
  const r = (color >> 16) & 0xff;
  const g = (color >> 8) & 0xff;
  const b = color & 0xff;
  const nr = clamp(Math.round(r * factor), 0, 255);
  const ng = clamp(Math.round(g * factor), 0, 255);
  const nb = clamp(Math.round(b * factor), 0, 255);
  return (nr << 16) | (ng << 8) | nb;
}

function mixColor(a: number, b: number, t: number): number {
  const ar = (a >> 16) & 0xff;
  const ag = (a >> 8) & 0xff;
  const ab = a & 0xff;
  const br = (b >> 16) & 0xff;
  const bg = (b >> 8) & 0xff;
  const bb = b & 0xff;
  const nr = clamp(Math.round(lerp(ar, br, t)), 0, 255);
  const ng = clamp(Math.round(lerp(ag, bg, t)), 0, 255);
  const nb = clamp(Math.round(lerp(ab, bb, t)), 0, 255);
  return (nr << 16) | (ng << 8) | nb;
}

function ensureVertexColorOnes(geometry: THREE.BufferGeometry): void {
  if (geometry.getAttribute('color')) return;
  const pos = geometry.getAttribute('position');
  if (!pos || pos.count <= 0) return;
  const colors = new Float32Array(pos.count * 3);
  colors.fill(1);
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
}

function hashString32(input: string): number {
  let h = 2166136261;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function rgbToHsl(r: number, g: number, b: number): { h: number; s: number; l: number } {
  const nr = r / 255;
  const ng = g / 255;
  const nb = b / 255;
  const max = Math.max(nr, ng, nb);
  const min = Math.min(nr, ng, nb);
  const l = (max + min) / 2;
  const d = max - min;
  if (d === 0) return { h: 0, s: 0, l };

  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h = 0;
  switch (max) {
    case nr:
      h = (ng - nb) / d + (ng < nb ? 6 : 0);
      break;
    case ng:
      h = (nb - nr) / d + 2;
      break;
    default:
      h = (nr - ng) / d + 4;
  }
  h /= 6;
  return { h, s, l };
}

function hexToHsl(color: number): { h: number; s: number; l: number } {
  const r = (color >> 16) & 0xff;
  const g = (color >> 8) & 0xff;
  const b = color & 0xff;
  return rgbToHsl(r, g, b);
}

function hslToHex(h: number, s: number, l: number): number {
  const hue2rgb = (p: number, q: number, t: number): number => {
    let tt = t;
    if (tt < 0) tt += 1;
    if (tt > 1) tt -= 1;
    if (tt < 1 / 6) return p + (q - p) * 6 * tt;
    if (tt < 1 / 2) return q;
    if (tt < 2 / 3) return p + (q - p) * (2 / 3 - tt) * 6;
    return p;
  };

  const hh = ((h % 1) + 1) % 1;
  const ss = clamp(s, 0, 1);
  const ll = clamp(l, 0, 1);

  if (ss === 0) {
    const v = clamp(Math.round(ll * 255), 0, 255);
    return (v << 16) | (v << 8) | v;
  }

  const q = ll < 0.5 ? ll * (1 + ss) : ll + ss - ll * ss;
  const p = 2 * ll - q;
  const r = hue2rgb(p, q, hh + 1 / 3);
  const g = hue2rgb(p, q, hh);
  const b = hue2rgb(p, q, hh - 1 / 3);
  const ir = clamp(Math.round(r * 255), 0, 255);
  const ig = clamp(Math.round(g * 255), 0, 255);
  const ib = clamp(Math.round(b * 255), 0, 255);
  return (ir << 16) | (ig << 8) | ib;
}

function formatScore(score: number): string {
  return score.toLocaleString('ko-KR');
}

function escapeHtml(input: string): string {
  return input.replace(/[<>&"]/g, (ch) => {
    if (ch === '<') return '&lt;';
    if (ch === '>') return '&gt;';
    if (ch === '&') return '&amp;';
    return '&quot;';
  });
}

function buildLeaderboardHtml(entries: LeaderboardEntry[], myId?: string): string {
  const rows = entries
    .map((e, idx) => {
      const meClass = e.id === myId ? 'entry me' : 'entry';
      const safeName = escapeHtml(e.name);
      return `<div class="${meClass}"><span>${idx + 1}. ${safeName}</span><span>${formatScore(
        e.score,
      )}</span></div>`;
    })
    .join('');

  return `<div class="title">LEADERBOARD</div>${rows}`;
}

function titleForClass(dna: WormClass): string {
  return CLASS_META[dna]?.title ?? dna;
}

function descForClass(dna: WormClass): string {
  return CLASS_META[dna]?.desc ?? '';
}

function recommendedClassForToday(): WormClass {
  const d = new Date();
  const key = `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
  let h = 2166136261;
  for (let i = 0; i < key.length; i++) h = Math.imul(h ^ key.charCodeAt(i), 16777619);
  const idx = Math.abs(h) % CLASS_ORDER.length;
  return CLASS_ORDER[idx] ?? 'shadow';
}

function drawHexRadar(
  ctx: CanvasRenderingContext2D,
  stats: { defense: number; speed: number; farm: number },
  accent: string,
): void {
  const w = ctx.canvas.width;
  const h = ctx.canvas.height;
  ctx.clearRect(0, 0, w, h);

  const cx = w / 2;
  const cy = h / 2;
  const r = Math.min(w, h) * 0.36;
  const rings = 4;

  const axis = (i: number): number => (-Math.PI / 2) + (i * Math.PI) / 3;
  const valueAtAxis = (i: number): number => {
    if (i === 0 || i === 3) return stats.speed;
    if (i === 1 || i === 4) return stats.farm;
    return stats.defense;
  };

  const hexPoint = (radius: number, i: number): Vec2f => ({
    x: cx + Math.cos(axis(i)) * radius,
    y: cy + Math.sin(axis(i)) * radius,
  });

  ctx.save();
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';

  // Ring grid
  for (let k = 1; k <= rings; k++) {
    const rr = (r * k) / rings;
    ctx.beginPath();
    const p0 = hexPoint(rr, 0);
    ctx.moveTo(p0.x, p0.y);
    for (let i = 1; i < 6; i++) {
      const p = hexPoint(rr, i);
      ctx.lineTo(p.x, p.y);
    }
    ctx.closePath();
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.12)';
    ctx.lineWidth = 1;
    ctx.stroke();
  }

  // Axes
  for (let i = 0; i < 6; i++) {
    const p = hexPoint(r, i);
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(p.x, p.y);
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.08)';
    ctx.lineWidth = 1;
    ctx.stroke();
  }

  // Value polygon (6 points, 3 stats mirrored)
  ctx.beginPath();
  const v0 = hexPoint(r * clamp(valueAtAxis(0), 0, 1), 0);
  ctx.moveTo(v0.x, v0.y);
  for (let i = 1; i < 6; i++) {
    const p = hexPoint(r * clamp(valueAtAxis(i), 0, 1), i);
    ctx.lineTo(p.x, p.y);
  }
  ctx.closePath();
  ctx.fillStyle = accent;
  ctx.globalAlpha = 0.25;
  ctx.fill();
  ctx.globalAlpha = 0.95;
  ctx.strokeStyle = accent;
  ctx.lineWidth = 2;
  ctx.stroke();

  // Labels (3)
  ctx.globalAlpha = 0.9;
  ctx.fillStyle = 'rgba(234, 240, 255, 0.75)';
  ctx.font = '12px system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, "Noto Sans KR", sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  const pSpeed = hexPoint(r + 16, 0);
  ctx.fillText('속도', pSpeed.x, pSpeed.y);
  const pFarm = hexPoint(r + 18, 1);
  ctx.fillText('파밍', pFarm.x, pFarm.y);
  const pDef = hexPoint(r + 18, 2);
  ctx.fillText('방어', pDef.x, pDef.y);

  ctx.restore();
}

function findSkillMutation(mutations: MutationId[]): MutationId | undefined {
  for (const m of mutations) {
    if (m.startsWith('ultimate_')) return m;
  }
  for (const m of mutations) {
    if (m === 'iron_bunker_down' || m === 'shadow_phantom_decoy') return m;
  }
  return undefined;
}

function stageLabel(stage: number): string {
  if (stage === 1) return 'Stage 1 (성장기)';
  if (stage === 2) return 'Stage 2 (성체기)';
  if (stage === 3) return 'Stage 3 (궁극체)';
  return '';
}

function traceSmoothChain(graphics: Graphics, segs: Vec2f[], tailTip?: Vec2f): void {
  const extra = tailTip ? 1 : 0;
  const total = segs.length + extra;
  if (total < 2) return;

  const get = (i: number): Vec2f => (i < segs.length ? segs[i]! : tailTip!);
  const tail = get(total - 1);

  graphics.beginPath();
  graphics.moveTo(tail.x, tail.y);

  if (total === 2) {
    const head = get(0);
    graphics.lineTo(head.x, head.y);
    return;
  }

  for (let i = total - 2; i >= 1; i--) {
    const p = get(i);
    const next = get(i - 1);
    const mx = (p.x + next.x) * 0.5;
    const my = (p.y + next.y) * 0.5;
    graphics.quadraticCurveTo(p.x, p.y, mx, my);
  }

  const head = get(0);
  graphics.lineTo(head.x, head.y);
}

function drawWorm(
  graphics: Graphics,
  segs: Vec2f[],
  color: number,
  boosting: boolean,
  isMe: boolean,
  t: number,
  spawnFx: number,
  visualLen?: number,
  tailTip?: Vec2f,
  dna: WormClass = 'shadow',
  armor = 0,
  stealth = false,
  phase = false,
  skill: MutationId | undefined = undefined,
  skillActive = false,
  isDecoy = false,
): void {
  graphics.clear();
  if (segs.length === 0) return;

  const length = Math.max(1, visualLen ?? segs.length);
  const siege = skillActive && skill === 'ultimate_iron_charge';
  const bunker = skillActive && skill === 'iron_bunker_down';
  const voidStrike = skillActive && skill === 'ultimate_shadow_phase';
  const singularity = skillActive && skill === 'ultimate_magnetic_magnet';

  const sizeMul = siege ? 1.5 : 1;
  const bodyMul = dna === 'shadow' ? 0.78 : dna === 'iron' ? 1.06 : 1.18;
  const headMul = dna === 'shadow' ? 0.92 : dna === 'iron' ? 1.02 : 1.12;
  const bodyBase = bodyRadiusForLength(length) * bodyMul * sizeMul;
  const headBase = headRadiusForLength(length) * headMul * sizeMul;

  // Compute direction using neck segment (fallback to a tiny vector).
  const head = segs[0]!;
  const neck = segs[1] ?? { x: head.x - 1, y: head.y };
  const dx = head.x - neck.x;
  const dy = head.y - neck.y;
  const ang = Math.atan2(dy, dx);

  const ghosty = stealth || phase || voidStrike;
  const baseAlphaMul = dna === 'shadow' ? 0.86 : dna === 'magnetic' ? 0.96 : 1;
  let visMul = phase ? 0.18 : stealth ? 0.28 : voidStrike ? 0.74 : 1;
  if (isDecoy) {
    visMul *= 0.92 + 0.08 * Math.sin(t * 18.3 + length * 0.11);
  }

  const steel = 0x8a97a3;
  const baseBodyColor =
    dna === 'iron'
      ? mixColor(steel, color, 0.55)
      : dna === 'shadow'
        ? mixColor(color, 0x0b0d12, 0.35)
        : color;

  let bodyColor = shade(baseBodyColor, boosting ? 1.08 : 0.96);
  let shineColor =
    dna === 'shadow'
      ? mixColor(0x00e5ff, 0xb000ff, 0.5 + 0.5 * Math.sin(t * 1.35 + length * 0.04))
      : shade(baseBodyColor, boosting ? 1.55 : 1.18);

  if (siege) {
    bodyColor = mixColor(bodyColor, 0xff3b2f, 0.55);
    shineColor = mixColor(shineColor, 0xffb15a, 0.75);
  } else if (singularity && dna === 'magnetic') {
    shineColor = mixColor(shineColor, 0xa55cff, 0.65);
  }

  const bodyAlpha = (boosting ? 0.985 : 0.96) * baseAlphaMul * visMul * (isDecoy ? 0.9 : 1);
  const shineAlpha = (boosting ? 0.26 : 0.14) * baseAlphaMul * visMul * (dna === 'shadow' ? 0.82 : 1);

  // Smooth ribbon body (instead of bead-by-bead circles).
  if (segs.length >= 2) {
    traceSmoothChain(graphics, segs, tailTip);
    graphics.stroke({ width: bodyBase * 2.62, color: 0x000000, alpha: 0.18, cap: 'round', join: 'round' });

    traceSmoothChain(graphics, segs, tailTip);
    graphics.stroke({
      width: bodyBase * 2.18,
      color: bodyColor,
      alpha: bodyAlpha,
      cap: 'round',
      join: 'round',
    });

    traceSmoothChain(graphics, segs, tailTip);
    graphics.stroke({ width: bodyBase * 1.32, color: shineColor, alpha: shineAlpha, cap: 'round', join: 'round' });

    if (dna === 'shadow') {
      traceSmoothChain(graphics, segs, tailTip);
      graphics.stroke({
        width: bodyBase * 0.62,
        color: shineColor,
        alpha: (boosting ? 0.18 : 0.12) * baseAlphaMul * visMul,
        cap: 'round',
        join: 'round',
      });
    } else if (dna === 'iron') {
      const seamStep = Math.max(2, Math.floor(segs.length / 34));
      for (let i = 2; i < segs.length - 2; i += seamStep) {
        const prev = segs[i - 1]!;
        const p = segs[i]!;
        const next = segs[i + 1]!;
        const tx = next.x - prev.x;
        const ty = next.y - prev.y;
        const td = Math.sqrt(tx * tx + ty * ty) || 1;
        const nx = -ty / td;
        const ny = tx / td;
        const w = bodyBase * 0.95;

        graphics.beginPath();
        graphics.moveTo(p.x - nx * w, p.y - ny * w);
        graphics.lineTo(p.x + nx * w, p.y + ny * w);
        graphics.stroke({ width: 2, color: 0x000000, alpha: 0.09 * visMul, cap: 'round' });

        graphics.beginPath();
        graphics.moveTo(p.x - nx * w * 0.86, p.y - ny * w * 0.86);
        graphics.lineTo(p.x + nx * w * 0.86, p.y + ny * w * 0.86);
        graphics.stroke({ width: 1, color: 0xffffff, alpha: 0.028 * visMul, cap: 'round' });
      }
    }
  }

  if (boosting && segs.length >= 3) {
    const maxDots = 96;
    const step = Math.max(1, Math.floor(segs.length / maxDots));
    const phase = t * 26;
    const waveAmp = bodyBase * (dna === 'shadow' ? 0.48 : dna === 'iron' ? 0.28 : 0.36);
    const waveColor = siege
      ? mixColor(0xff3b2f, 0xffb15a, 0.5 + 0.5 * Math.sin(t * 6.2))
      : dna === 'shadow'
        ? shineColor
        : dna === 'iron'
          ? mixColor(color, 0xffb15a, 0.65)
          : mixColor(color, 0xa55cff, 0.35);

    for (let i = 1; i < segs.length - 1; i += step) {
      const prev = segs[i - 1]!;
      const p = segs[i]!;
      const next = segs[i + 1]!;

      const tx = next.x - prev.x;
      const ty = next.y - prev.y;
      const td = Math.sqrt(tx * tx + ty * ty) || 1;
      const nx = -ty / td;
      const ny = tx / td;

      const f = i / (segs.length - 1);
      const w = Math.sin(phase - f * 34);
      const a = 0.06 + 0.06 * (0.5 + 0.5 * Math.sin(phase * 1.15 - f * 21));
      const r = bodyBase * (0.55 + 0.18 * (0.5 + 0.5 * w));

      graphics.beginFill(waveColor, a);
      graphics.drawCircle(p.x + nx * w * waveAmp, p.y + ny * w * waveAmp, r);
      graphics.endFill();
    }
  }

  graphics.beginFill(0x000000, ghosty ? 0.12 : 0.22);
  graphics.drawCircle(head.x, head.y, headBase + 2.6 + headBase * 0.04);
  graphics.endFill();

  graphics.beginFill(shade(bodyColor, boosting ? 1.12 : 1.08), (ghosty ? 0.72 : 1) * baseAlphaMul * visMul);
  graphics.drawCircle(head.x, head.y, headBase);
  graphics.endFill();

  // Eyes (direction from neck)
  const forward = headBase * 0.35;
  const side = headBase * 0.42;
  const ex = Math.cos(ang) * forward;
  const ey = Math.sin(ang) * forward;
  const sx = -Math.sin(ang) * side;
  const sy = Math.cos(ang) * side;

  if (dna === 'shadow') {
    const sLen = Math.sqrt(sx * sx + sy * sy) || 1;
    const sdx = sx / sLen;
    const sdy = sy / sLen;

    const slitLen = Math.max(7, headBase * 0.46);
    const slitW = Math.max(2.4, headBase * 0.11);
    const c = shineColor;
    const a = 0.88 * visMul;

    const drawSlit = (cx: number, cy: number) => {
      graphics.beginPath();
      graphics.moveTo(cx - sdx * (slitLen * 0.5), cy - sdy * (slitLen * 0.5));
      graphics.lineTo(cx + sdx * (slitLen * 0.5), cy + sdy * (slitLen * 0.5));
      graphics.stroke({ width: slitW + 2.2, color: c, alpha: 0.12 * a, cap: 'round' });

      graphics.beginPath();
      graphics.moveTo(cx - sdx * (slitLen * 0.5), cy - sdy * (slitLen * 0.5));
      graphics.lineTo(cx + sdx * (slitLen * 0.5), cy + sdy * (slitLen * 0.5));
      graphics.stroke({ width: slitW, color: c, alpha: a, cap: 'round' });
    };

    drawSlit(head.x + ex + sx * 0.88, head.y + ey + sy * 0.88);
    drawSlit(head.x + ex - sx * 0.88, head.y + ey - sy * 0.88);
  } else if (dna === 'magnetic') {
    const eyeR = Math.max(3.6, headBase * 0.18);
    const pupilR = Math.max(1.5, eyeR * 0.55);
    const eyes: Vec2f[] = [
      { x: head.x + ex + sx * 0.88, y: head.y + ey + sy * 0.88 },
      { x: head.x + ex - sx * 0.88, y: head.y + ey - sy * 0.88 },
      { x: head.x + ex * 0.72, y: head.y + ey * 0.72 },
    ];

    graphics.beginFill(0xffffff, 0.9 * visMul);
    for (const e of eyes) graphics.drawCircle(e.x, e.y, eyeR);
    graphics.endFill();

    graphics.beginFill(0x0b0d12, 0.95 * visMul);
    for (const e of eyes) {
      graphics.drawCircle(e.x + Math.cos(ang) * 1.4, e.y + Math.sin(ang) * 1.4, pupilR);
    }
    graphics.endFill();
  } else if (dna === 'iron') {
    const sLen = Math.sqrt(sx * sx + sy * sy) || 1;
    const sdx = sx / sLen;
    const sdy = sy / sLen;

    const visorLen = Math.max(10, headBase * 0.72);
    const visorW = Math.max(3, headBase * 0.14);
    const c = siege ? 0xffb15a : 0x9fbaff;
    const a = 0.65 * visMul;

    const cx = head.x + ex * 1.1;
    const cy = head.y + ey * 1.1;

    graphics.beginPath();
    graphics.moveTo(cx - sdx * (visorLen * 0.5), cy - sdy * (visorLen * 0.5));
    graphics.lineTo(cx + sdx * (visorLen * 0.5), cy + sdy * (visorLen * 0.5));
    graphics.stroke({ width: visorW + 3.2, color: c, alpha: 0.08 * a, cap: 'round' });

    graphics.beginPath();
    graphics.moveTo(cx - sdx * (visorLen * 0.5), cy - sdy * (visorLen * 0.5));
    graphics.lineTo(cx + sdx * (visorLen * 0.5), cy + sdy * (visorLen * 0.5));
    graphics.stroke({ width: visorW, color: c, alpha: a, cap: 'round' });
  } else {
    const eyeR = Math.max(4.8, headBase * 0.27);
    const pupilR = Math.max(2.25, eyeR * 0.46);

    graphics.beginFill(0xffffff, 0.95);
    graphics.drawCircle(head.x + ex + sx, head.y + ey + sy, eyeR);
    graphics.drawCircle(head.x + ex - sx, head.y + ey - sy, eyeR);
    graphics.endFill();

    graphics.beginFill(0x0b0d12, 0.95);
    graphics.drawCircle(
      head.x + ex + sx + Math.cos(ang) * 1.7,
      head.y + ey + sy + Math.sin(ang) * 1.7,
      pupilR,
    );
    graphics.drawCircle(
      head.x + ex - sx + Math.cos(ang) * 1.7,
      head.y + ey - sy + Math.sin(ang) * 1.7,
      pupilR,
    );
    graphics.endFill();
  }

  const dirx = Math.cos(ang);
  const diry = Math.sin(ang);
  const nx = -diry;
  const ny = dirx;

  if (dna === 'iron') {
    const frontDist = headBase * 0.78;
    const backDist = headBase * 0.08;
    const wFront = headBase * 0.72;
    const wBack = headBase * 0.95;
    const fx = head.x + dirx * frontDist;
    const fy = head.y + diry * frontDist;
    const bx = head.x + dirx * backDist;
    const by = head.y + diry * backDist;
    const plateColor = mixColor(0x8a97a3, color, 0.45);
    const pts = [fx + nx * wFront, fy + ny * wFront, fx - nx * wFront, fy - ny * wFront, bx - nx * wBack, by - ny * wBack, bx + nx * wBack, by + ny * wBack];
    graphics.poly(pts).fill({ color: plateColor, alpha: 0.78 * visMul });
    graphics.poly(pts).stroke({ width: 2, color: 0x000000, alpha: 0.12 * visMul, join: 'round' });

    const rivetR = Math.max(1.3, headBase * 0.08);
    graphics.circle(bx + nx * (wBack * 0.42), by + ny * (wBack * 0.42), rivetR).fill({ color: 0x0b0d12, alpha: 0.38 * visMul });
    graphics.circle(bx - nx * (wBack * 0.42), by - ny * (wBack * 0.42), rivetR).fill({ color: 0x0b0d12, alpha: 0.38 * visMul });

    if (bunker) {
      const r0 = headBase + 14;
      graphics.circle(head.x, head.y, r0).stroke({ width: 3, color: 0xeaf0ff, alpha: 0.14 * visMul });
      graphics.circle(head.x, head.y, r0 + 6).stroke({ width: 2, color: 0xffffff, alpha: 0.06 * visMul });
    }

    if (siege) {
      const r0 = headBase + 20;
      graphics.circle(head.x, head.y, r0).stroke({ width: 3, color: 0xff3b2f, alpha: 0.1 * visMul });
    }
  } else if (dna === 'magnetic') {
    const ringR = headBase + (singularity ? 34 : 22);
    const dotCount = singularity ? 18 : 12;
    const swirlColor = mixColor(0x8cff00, 0xa55cff, 0.5 + 0.5 * Math.sin(t * 1.1 + length * 0.02));

    graphics.circle(head.x, head.y, ringR).stroke({ width: 2, color: swirlColor, alpha: 0.06 * visMul });
    for (let i = 0; i < dotCount; i++) {
      const a = t * (singularity ? 3.1 : 2.0) + (i / dotCount) * Math.PI * 2;
      const wobble = Math.sin(t * 5.2 + i * 1.7) * (singularity ? 6 : 3);
      const rr = ringR + wobble;
      const r = Math.max(1.5, headBase * (singularity ? 0.08 : 0.06));
      graphics.beginFill(swirlColor, (singularity ? 0.08 : 0.06) * visMul);
      graphics.drawCircle(head.x + Math.cos(a) * rr, head.y + Math.sin(a) * rr, r);
      graphics.endFill();
    }

    if (singularity) {
      graphics.beginFill(0x000000, 0.28 * visMul);
      graphics.drawCircle(head.x, head.y, headBase * 0.42);
      graphics.endFill();
      graphics.circle(head.x, head.y, headBase + 10).stroke({ width: 2, color: 0xa55cff, alpha: 0.08 * visMul });
    }
  }

  if (voidStrike) {
    const r0 = headBase + 16;
    graphics.circle(head.x, head.y, r0).stroke({ width: 2, color: shineColor, alpha: 0.08 * visMul });
  }

  if (dna === 'iron' && armor > 0) {
    const ringR = headBase + 7;
    graphics.lineStyle(3, 0xeaf0ff, 0.14 + armor * 0.03);
    graphics.drawCircle(head.x, head.y, ringR);
    if (armor >= 2) {
      graphics.lineStyle(2, 0xeaf0ff, 0.11);
      graphics.drawCircle(head.x, head.y, ringR + 4.2);
    }
    graphics.lineStyle(1, 0x000000, 0.16);
    graphics.drawCircle(head.x, head.y, ringR + 1.1);
    graphics.lineStyle(0);
  }

  if (isMe) {
    graphics.lineStyle(2, 0xffffff, 0.18);
    graphics.drawCircle(head.x, head.y, headBase + 8);
    graphics.lineStyle(0);
  }

  if (spawnFx > 0) {
    graphics.lineStyle(2, 0xffffff, spawnFx * 0.16);
    graphics.drawCircle(head.x, head.y, headBase + 14 + spawnFx * 26);
    graphics.lineStyle(0);
  }
}

function createHoneycombTexture(): { texture: THREE.CanvasTexture; tileW: number; tileH: number } {
  // Larger tiles (LoL-ish) + higher contrast so the ground reads as "hex tiles".
  const side = 64;
  const hexH = Math.sqrt(3) * side;
  const tileW = Math.round(3 * side);
  const tileH = Math.round(2 * hexH);

  const dpr = Math.min(window.devicePixelRatio ?? 1, 2);
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(tileW * dpr);
  canvas.height = Math.round(tileH * dpr);

  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas 2D context를 만들 수 없습니다.');
  ctx.scale(dpr, dpr);

  ctx.clearRect(0, 0, tileW, tileH);
  ctx.fillStyle = '#0b0d12';
  ctx.fillRect(0, 0, tileW, tileH);

  const stroke = 'rgba(255, 255, 255, 0.12)';
  const fill = 'rgba(255, 255, 255, 0.028)';
  const glow = 'rgba(120, 150, 255, 0.05)';

  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  ctx.lineWidth = 1.2;

  const halfH = hexH / 2;
  const horiz = 1.5 * side;
  const vert = hexH;

  const drawHex = (cx: number, cy: number) => {
    ctx.beginPath();
    ctx.moveTo(cx + side, cy);
    ctx.lineTo(cx + side / 2, cy + halfH);
    ctx.lineTo(cx - side / 2, cy + halfH);
    ctx.lineTo(cx - side, cy);
    ctx.lineTo(cx - side / 2, cy - halfH);
    ctx.lineTo(cx + side / 2, cy - halfH);
    ctx.closePath();

    ctx.fillStyle = fill;
    ctx.fill();

    ctx.strokeStyle = glow;
    ctx.stroke();

    ctx.strokeStyle = stroke;
    ctx.stroke();
  };

  // Draw a bit beyond the tile so edges stitch nicely when repeated.
  for (let col = -1; col <= 2; col++) {
    const x = col * horiz;
    const yOff = (col & 1) === 0 ? 0 : vert / 2;
    for (let row = -1; row <= 3; row++) {
      const y = row * vert + yOff;
      drawHex(x, y);
    }
  }

  // Subtle noise so the floor isn't perfectly flat.
  const noiseCount = 120;
  for (let i = 0; i < noiseCount; i++) {
    const x = Math.random() * tileW;
    const y = Math.random() * tileH;
    const r = 0.6 + Math.random() * 1.4;
    const a = 0.04 + Math.random() * 0.05;
    ctx.fillStyle = `rgba(255, 255, 255, ${a})`;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  }

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.needsUpdate = true;
  return { texture, tileW, tileH };
}

function createSoftCircleTexture(): THREE.CanvasTexture {
  const size = 96;
  const dpr = Math.min(window.devicePixelRatio ?? 1, 2);
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(size * dpr);
  canvas.height = Math.round(size * dpr);

  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas 2D context를 만들 수 없습니다.');
  ctx.scale(dpr, dpr);

  ctx.clearRect(0, 0, size, size);
  const cx = size / 2;
  const cy = size / 2;
  const r = size / 2;

  const grad = ctx.createRadialGradient(cx, cy, r * 0.05, cx, cy, r);
  grad.addColorStop(0, 'rgba(0, 0, 0, 0.55)');
  grad.addColorStop(0.35, 'rgba(0, 0, 0, 0.25)');
  grad.addColorStop(1, 'rgba(0, 0, 0, 0)');

  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, size, size);

  const texture = new THREE.CanvasTexture(canvas);
  texture.needsUpdate = true;
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  return texture;
}

function createGlowCircleTexture(): THREE.CanvasTexture {
  const size = 128;
  const dpr = Math.min(window.devicePixelRatio ?? 1, 2);
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(size * dpr);
  canvas.height = Math.round(size * dpr);

  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas 2D context를 만들 수 없습니다.');
  ctx.scale(dpr, dpr);

  ctx.clearRect(0, 0, size, size);
  const cx = size / 2;
  const cy = size / 2;
  const r = size / 2;

  const grad = ctx.createRadialGradient(cx, cy, r * 0.02, cx, cy, r);
  grad.addColorStop(0, 'rgba(255, 255, 255, 1)');
  grad.addColorStop(0.22, 'rgba(255, 255, 255, 0.85)');
  grad.addColorStop(0.55, 'rgba(255, 255, 255, 0.22)');
  grad.addColorStop(1, 'rgba(255, 255, 255, 0)');

  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, size, size);

  const texture = new THREE.CanvasTexture(canvas);
  texture.needsUpdate = true;
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  return texture;
}

function createRuneCircleTexture(): THREE.CanvasTexture {
  const size = 256;
  const dpr = Math.min(window.devicePixelRatio ?? 1, 2);
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(size * dpr);
  canvas.height = Math.round(size * dpr);

  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas 2D context를 만들 수 없습니다.');
  ctx.scale(dpr, dpr);

  ctx.clearRect(0, 0, size, size);
  ctx.translate(size / 2, size / 2);

  const r = size * 0.42;

  // Base glow ring
  const glow = ctx.createRadialGradient(0, 0, r * 0.55, 0, 0, r * 1.12);
  glow.addColorStop(0, 'rgba(255, 255, 255, 0)');
  glow.addColorStop(0.65, 'rgba(255, 255, 255, 0.08)');
  glow.addColorStop(1, 'rgba(255, 255, 255, 0)');
  ctx.fillStyle = glow;
  ctx.beginPath();
  ctx.arc(0, 0, r * 1.12, 0, Math.PI * 2);
  ctx.fill();

  // Outer & inner rings
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.32)';
  ctx.lineWidth = 10;
  ctx.beginPath();
  ctx.arc(0, 0, r * 1.02, 0, Math.PI * 2);
  ctx.stroke();

  ctx.strokeStyle = 'rgba(255, 255, 255, 0.6)';
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.arc(0, 0, r * 0.92, 0, Math.PI * 2);
  ctx.stroke();

  ctx.strokeStyle = 'rgba(255, 255, 255, 0.28)';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.arc(0, 0, r * 0.64, 0, Math.PI * 2);
  ctx.stroke();

  // Rune glyphs around the ring
  const runeCount = 28;
  for (let i = 0; i < runeCount; i++) {
    const a = (i / runeCount) * Math.PI * 2;
    ctx.save();
    ctx.rotate(a);
    ctx.translate(0, -r * 0.9);

    const w = 10 + (i % 3) * 3;
    const h = 16 + (i % 4) * 2;
    const slant = (i % 2 === 0 ? 1 : -1) * (0.2 + (i % 5) * 0.03);
    ctx.rotate(slant);

    ctx.strokeStyle = 'rgba(255, 255, 255, 0.78)';
    ctx.lineWidth = 2;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    ctx.beginPath();
    ctx.moveTo(-w * 0.45, h * 0.35);
    ctx.lineTo(-w * 0.1, -h * 0.45);
    ctx.lineTo(w * 0.35, h * 0.2);
    ctx.stroke();

    // Little "dot" accent
    ctx.fillStyle = 'rgba(255, 255, 255, 0.75)';
    ctx.beginPath();
    ctx.arc(w * 0.25, -h * 0.25, 1.6, 0, Math.PI * 2);
    ctx.fill();

    ctx.restore();
  }

  // Radial tick marks
  const tickCount = 56;
  for (let i = 0; i < tickCount; i++) {
    const a = (i / tickCount) * Math.PI * 2;
    const major = i % 7 === 0;
    const inner = major ? r * 0.68 : r * 0.73;
    const outer = major ? r * 0.82 : r * 0.8;
    ctx.strokeStyle = major ? 'rgba(255, 255, 255, 0.35)' : 'rgba(255, 255, 255, 0.18)';
    ctx.lineWidth = major ? 2.2 : 1.2;
    ctx.beginPath();
    ctx.moveTo(Math.cos(a) * inner, Math.sin(a) * inner);
    ctx.lineTo(Math.cos(a) * outer, Math.sin(a) * outer);
    ctx.stroke();
  }

  // Subtle star speckles
  for (let i = 0; i < 120; i++) {
    const a = Math.random() * Math.PI * 2;
    const rr = r * (0.25 + Math.random() * 0.85);
    const x = Math.cos(a) * rr;
    const y = Math.sin(a) * rr;
    const rad = 0.6 + Math.random() * 1.4;
    const alpha = 0.04 + Math.random() * 0.08;
    ctx.fillStyle = `rgba(255, 255, 255, ${alpha})`;
    ctx.beginPath();
    ctx.arc(x, y, rad, 0, Math.PI * 2);
    ctx.fill();
  }

  const texture = new THREE.CanvasTexture(canvas);
  texture.needsUpdate = true;
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  return texture;
}

function createWorldGrid(world: WorldConfig, maxAnisotropy: number): THREE.Group {
  const layer = new THREE.Group();
  const radius = world.width / 2;

  const { texture, tileW, tileH } = createHoneycombTexture();
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.repeat.set(world.width / tileW, world.height / tileH);
  texture.anisotropy = Math.min(8, Math.max(1, maxAnisotropy));

  const groundMat = new THREE.MeshStandardMaterial({
    map: texture,
    color: new THREE.Color(0xffffff),
    roughness: 0.98,
    metalness: 0.02,
  });
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(world.width, world.height), groundMat);
  ground.rotation.x = -Math.PI / 2;
  ground.position.set(0, 0, 0);
  ground.receiveShadow = true;
  ground.name = 'ground';

  const borderMat = new THREE.MeshBasicMaterial({
    color: 0xffffff,
    side: THREE.DoubleSide,
  });
  // Opaque + polygonOffset to avoid z-fighting flicker against the ground at large world scales.
  borderMat.polygonOffset = true;
  borderMat.polygonOffsetFactor = -2;
  borderMat.polygonOffsetUnits = -2;
  const border = new THREE.Mesh(new THREE.RingGeometry(radius - 12, radius + 12, 144), borderMat);
  border.rotation.x = -Math.PI / 2;
  border.position.y = 0.65;
  border.renderOrder = 2;
  border.name = 'border';

  const outsideMat = new THREE.MeshBasicMaterial({
    color: 0x0d0f14,
    side: THREE.DoubleSide,
  });
  outsideMat.polygonOffset = true;
  outsideMat.polygonOffsetFactor = -1;
  outsideMat.polygonOffsetUnits = -1;
  const outside = new THREE.Mesh(new THREE.RingGeometry(radius + 12, radius + 5200, 144), outsideMat);
  outside.rotation.x = -Math.PI / 2;
  outside.position.y = 0.6;
  outside.renderOrder = 1;
  outside.name = 'outside';

  ground.renderOrder = 0;
  layer.add(ground, outside, border);

  return layer;
}

function syncTargetSegments(render: PlayerRender, segments: Vec2[]): void {
  const prevLen = render.targetSegs.length;
  const prevTail = prevLen > 0 ? { x: render.targetSegs[prevLen - 1]!.x, y: render.targetSegs[prevLen - 1]!.y } : undefined;
  const prevVisibleTail = render.tailTip
    ? { x: render.tailTip.x, y: render.tailTip.y }
    : render.segs.length > 0
      ? { x: render.segs[render.segs.length - 1]!.x, y: render.segs[render.segs.length - 1]!.y }
      : prevTail;

  render.targetSegs.length = segments.length;
  for (let i = 0; i < segments.length; i++) {
    const s = segments[i]!;
    const existing = render.targetSegs[i];
    if (existing) {
      existing.x = s.x;
      existing.y = s.y;
    } else {
      render.targetSegs[i] = { x: s.x, y: s.y };
    }
  }

  const nextLen = render.targetSegs.length;
  if (prevVisibleTail && nextLen > 0 && nextLen < prevLen) {
    render.tailTip = { x: prevVisibleTail.x, y: prevVisibleTail.y };
  }

  if (render.segs.length === 0 && render.targetSegs.length > 0) {
    for (const s of render.targetSegs) render.segs.push({ x: s.x, y: s.y });
    render.visualLen = render.segs.length;
    const tail = render.segs[render.segs.length - 1]!;
    render.tailTip = { x: tail.x, y: tail.y };
    return;
  }

  // Keep render buffer length aligned (grow/shrink immediately, then smooth).
  if (render.segs.length > render.targetSegs.length) {
    render.segs.length = render.targetSegs.length;
  } else {
    while (render.segs.length < render.targetSegs.length) {
      const last = render.segs[render.segs.length - 1] ?? render.targetSegs[render.segs.length - 1] ?? { x: 0, y: 0 };
      render.segs.push({ x: last.x, y: last.y });
    }
  }
}

function constrainChain(segs: Vec2f[], spacing: number): void {
  for (let i = 1; i < segs.length; i++) {
    const prev = segs[i - 1]!;
    const cur = segs[i]!;
    const dx = prev.x - cur.x;
    const dy = prev.y - cur.y;
    const d = Math.sqrt(dx * dx + dy * dy);
    if (d <= spacing || d === 0) continue;

    const t = (d - spacing) / d;
    cur.x += dx * t;
    cur.y += dy * t;
  }
}

function isInsideView(x: number, y: number, view: { minX: number; maxX: number; minY: number; maxY: number }, margin: number): boolean {
  return x >= view.minX - margin && x <= view.maxX + margin && y >= view.minY - margin && y <= view.maxY + margin;
}

function isAnySegmentInsideView(segs: Vec2f[], view: { minX: number; maxX: number; minY: number; maxY: number }, margin: number): boolean {
  if (segs.length === 0) return false;

  const step = Math.max(1, Math.floor(segs.length / 46));
  for (let i = 0; i < segs.length; i += step) {
    const s = segs[i]!;
    if (isInsideView(s.x, s.y, view, margin)) return true;
  }

  const tail = segs[segs.length - 1]!;
  return isInsideView(tail.x, tail.y, view, margin);
}

function foodPhase(id: string): number {
  const n = Number.parseInt(id, 10);
  if (Number.isFinite(n)) return (n * 0.61803398875) % (Math.PI * 2);
  let h = 0;
  for (let i = 0; i < id.length; i++) {
    h = (h * 31 + id.charCodeAt(i)) >>> 0;
  }
  return (h / 0xffffffff) * Math.PI * 2;
}

function cssHexColor(color: number): string {
  return `#${color.toString(16).padStart(6, '0')}`;
}

function spawnBurst(particles: Particle[], at: Vec2f, color: number, count: number): void {
  for (let i = 0; i < count; i++) {
    const a = rand(-Math.PI, Math.PI);
    const sp = rand(60, 220);
    const life = rand(0.25, 0.55);
    particles.push({
      kind: 'dot',
      x: at.x + rand(-4, 4),
      y: at.y + rand(-4, 4),
      vx: Math.cos(a) * sp,
      vy: Math.sin(a) * sp,
      r: rand(1.8, 4.8),
      life,
      maxLife: life,
      color: shade(color, rand(1.05, 1.35)),
      alpha: rand(0.12, 0.28),
    });
  }
}

function spawnRing(particles: Particle[], at: Vec2f, color: number, r: number): void {
  const life = rand(0.18, 0.3);
  particles.push({
    kind: 'ring',
    x: at.x,
    y: at.y,
    vx: 0,
    vy: 0,
    r,
    life,
    maxLife: life,
    color: shade(color, 1.25),
    alpha: rand(0.14, 0.22),
    lineWidth: rand(1.3, 2.4),
    grow: rand(180, 320),
  });
}

function spawnEatSuction(particles: Particle[], from: Vec2f, to: Vec2f, color: number, dna: WormClass, value: number): void {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const dist = Math.hypot(dx, dy);
  if (dist <= 1) return;

  const nx = dx / dist;
  const ny = dy / dist;
  const px = -ny;
  const py = nx;
  const magnetic = dna === 'magnetic';
  const count = Math.round(clamp((magnetic ? 6 : 4) + value * 2, 4, magnetic ? 14 : 10));
  const speedBase = clamp(900 + dist * 0.9, 900, 2100) * (magnetic ? 1.12 : 1);

  for (let i = 0; i < count; i++) {
    const spread = rand(0, 18 + value * 8);
    const side = rand(-1, 1) * spread;
    const start = { x: from.x + px * side + rand(-3, 3), y: from.y + py * side + rand(-3, 3) };
    const speed = speedBase * rand(0.75, 1.1);
    const life = clamp(dist / Math.max(1, speed), 0.08, 0.22);
    const glow = dna === 'shadow' ? 0.55 : dna === 'iron' ? 0.35 : 0.45;
    particles.push({
      kind: 'dot',
      x: start.x,
      y: start.y,
      vx: nx * speed + (magnetic ? px * (rand(-1, 1) * speed * (0.12 + value * 0.03)) : 0),
      vy: ny * speed + (magnetic ? py * (rand(-1, 1) * speed * (0.12 + value * 0.03)) : 0),
      r: rand(1.6, 3.1) + value * 0.15,
      life,
      maxLife: life,
      color: mixColor(color, 0xffffff, glow + Math.random() * 0.18),
      alpha: rand(0.14, 0.28),
    });
  }

  // A few sharper streaks for readability.
  const streaks = Math.round(clamp((magnetic ? 2 : 1) + value * 0.8, magnetic ? 2 : 1, magnetic ? 4 : 3));
  const ang = Math.atan2(ny, nx);
  for (let i = 0; i < streaks; i++) {
    const speed = speedBase * rand(0.9, 1.25);
    const life = clamp(dist / Math.max(1, speed), 0.06, 0.16);
    particles.push({
      kind: 'spark',
      x: from.x + rand(-4, 4),
      y: from.y + rand(-4, 4),
      vx: nx * speed,
      vy: ny * speed,
      r: rand(1, 2.2),
      len: rand(10, 18),
      rot: ang,
      life,
      maxLife: life,
      color: mixColor(color, 0xffffff, 0.35 + Math.random() * 0.25),
      alpha: rand(0.12, 0.22),
      lineWidth: rand(1.1, 2.0),
    });
  }
}

function spawnBoostRing(particles: Particle[], at: Vec2f, color: number, r: number, dna: WormClass): void {
  const life = rand(0.12, 0.22);
  const ringColor =
    dna === 'iron'
      ? mixColor(color, 0xffb15a, 0.65)
      : dna === 'shadow'
        ? mixColor(0x00e5ff, 0xb000ff, Math.random())
        : mixColor(color, 0xa55cff, 0.45);
  particles.push({
    kind: 'ring',
    x: at.x,
    y: at.y,
    vx: 0,
    vy: 0,
    r,
    life,
    maxLife: life,
    color: ringColor,
    alpha: rand(0.06, 0.14) * (dna === 'shadow' ? 1.25 : 1),
    lineWidth: rand(1.1, 2.0),
    grow: rand(120, 200),
  });
}

function spawnBoostParticle(
  particles: Particle[],
  head: Vec2f,
  neck: Vec2f,
  color: number,
  headR: number,
  bodyR: number,
  dna: WormClass,
  skill: MutationId | undefined,
  skillActive: boolean,
): void {
  const ang = Math.atan2(head.y - neck.y, head.x - neck.x);
  const sideA = ang + Math.PI / 2;
  const spread = rand(-bodyR * 0.55, bodyR * 0.55);
  const back = {
    x: head.x - Math.cos(ang) * (headR * 0.95),
    y: head.y - Math.sin(ang) * (headR * 0.95),
  };

  const x = back.x + Math.cos(sideA) * spread + rand(-2, 2);
  const y = back.y + Math.sin(sideA) * spread + rand(-2, 2);

  const siege = skillActive && skill === 'ultimate_iron_charge';
  const singularity = skillActive && skill === 'ultimate_magnetic_magnet';

  if (dna === 'iron') {
    // Smoke
    const smokeSpeed = rand(60, 160);
    const smokeLife = rand(0.35, 0.65);
    particles.push({
      kind: 'dot',
      x,
      y,
      vx: -Math.cos(ang) * smokeSpeed + rand(-18, 18),
      vy: -Math.sin(ang) * smokeSpeed + rand(-18, 18),
      r: rand(4.2, 9.8),
      life: smokeLife,
      maxLife: smokeLife,
      color: 0x0b0d12,
      alpha: rand(0.06, 0.12),
    });

    // Sparks
    const sparkChance = siege ? 0.75 : 0.35;
    if (Math.random() < sparkChance) {
      const speed = rand(220, 420);
      const life = rand(0.08, 0.2);
      particles.push({
        kind: 'spark',
        x: x + rand(-1, 1),
        y: y + rand(-1, 1),
        vx: -Math.cos(ang) * speed + rand(-40, 40),
        vy: -Math.sin(ang) * speed + rand(-40, 40),
        r: rand(1, 2.2),
        len: rand(10, 22),
        rot: ang + rand(-0.9, 0.9),
        life,
        maxLife: life,
        color: siege ? 0xff3b2f : mixColor(color, 0xffb15a, 0.65),
        alpha: rand(0.18, 0.32),
        lineWidth: rand(1.2, 2.2),
      });
    }
    return;
  }

  if (dna === 'shadow') {
    // Data fragments
    const speed = rand(200, 380);
    const life = rand(0.12, 0.28);
    particles.push({
      kind: 'spark',
      x,
      y,
      vx: -Math.cos(ang) * speed + rand(-60, 60),
      vy: -Math.sin(ang) * speed + rand(-60, 60),
      r: rand(1, 2),
      len: rand(10, 22),
      rot: ang + rand(-0.8, 0.8),
      life,
      maxLife: life,
      color: mixColor(0x00e5ff, 0xb000ff, Math.random()),
      alpha: rand(0.14, 0.28),
      lineWidth: rand(1.2, 2.1),
    });
    return;
  }

  // Magnetic shimmer
  const speed = rand(90, 210);
  const life = rand(0.22, 0.5);
  particles.push({
    kind: 'dot',
    x,
    y,
    vx: -Math.cos(ang) * speed + rand(-30, 30),
    vy: -Math.sin(ang) * speed + rand(-30, 30),
    r: rand(2.0, singularity ? 5.4 : 4.2),
    life,
    maxLife: life,
    color: mixColor(color, 0xa55cff, singularity ? 0.65 : 0.35),
    alpha: rand(0.08, singularity ? 0.2 : 0.16),
  });
}

async function main() {
  const uiRootEl = document.getElementById('ui');
  const menuEl = document.getElementById('menu');
  const hudEl = document.getElementById('hud');
  const deathEl = document.getElementById('death');
  const leaderboardEl = document.getElementById('leaderboard');
  const statsEl = document.getElementById('stats');
  const minimapEl = document.getElementById('minimap') as HTMLCanvasElement | null;
  const classPrevEl = document.getElementById('classPrev');
  const classNextEl = document.getElementById('classNext');
  const classNameEl = document.getElementById('className');
  const classDescEl = document.getElementById('classDesc');
  const classRecommendEl = document.getElementById('classRecommend');
  const classPanelEl = document.getElementById('classPanel');
  const classRadarEl = document.getElementById('classRadar') as HTMLCanvasElement | null;
  const classSwipeAreaEl = document.getElementById('classSwipeArea');
  const nameInputEl = document.getElementById('nameInput') as HTMLInputElement | null;
  const classSelectEl = document.getElementById('classSelect') as HTMLSelectElement | null;
  const playBtnEl = document.getElementById('playBtn');
  const respawnBtnEl = document.getElementById('respawnBtn');
  const deathTextEl = document.getElementById('deathText');
  const evoHudEl = document.getElementById('evoHud');
  const evoFillEl = document.getElementById('evoFill');
  const evoTextEl = document.getElementById('evoText');
  const skillBtnEl = document.getElementById('skillBtn');
  const mutationOverlayEl = document.getElementById('mutationOverlay');
  const mutationStageEl = document.getElementById('mutationStage');
  const mutationCardsEl = document.getElementById('mutationCards');
  const sixthSenseEl = document.getElementById('sixthSense');
  const bestScoreEl = document.getElementById('bestScore');
  const lastScoreEl = document.getElementById('lastScore');

  if (
    !uiRootEl ||
    !menuEl ||
    !hudEl ||
    !deathEl ||
    !leaderboardEl ||
    !statsEl ||
    !classPrevEl ||
    !classNextEl ||
    !classNameEl ||
    !classDescEl ||
    !classRecommendEl ||
    !classPanelEl ||
    !classRadarEl ||
    !classSwipeAreaEl ||
    !nameInputEl ||
    !classSelectEl ||
    !playBtnEl ||
    !respawnBtnEl ||
    !deathTextEl ||
    !evoHudEl ||
    !evoFillEl ||
    !evoTextEl ||
    !skillBtnEl ||
    !mutationOverlayEl ||
    !mutationStageEl ||
    !mutationCardsEl ||
    !sixthSenseEl
  ) {
    throw new Error('UI 요소를 찾지 못했습니다.');
  }

  const uiRoot = uiRootEl as HTMLDivElement;
  const menu = menuEl as HTMLDivElement;
  const hud = hudEl as HTMLDivElement;
  const death = deathEl as HTMLDivElement;
  const leaderboard = leaderboardEl as HTMLDivElement;
  const stats = statsEl as HTMLDivElement;
  const classPrev = classPrevEl as HTMLButtonElement;
  const classNext = classNextEl as HTMLButtonElement;
  const className = classNameEl as HTMLDivElement;
  const classDesc = classDescEl as HTMLDivElement;
  const classRecommend = classRecommendEl as HTMLDivElement;
  const classPanel = classPanelEl as HTMLDivElement;
  const classRadar = classRadarEl as HTMLCanvasElement;
  const classSwipeArea = classSwipeAreaEl as HTMLDivElement;
  const nameInput = nameInputEl as HTMLInputElement;
  const classSelect = classSelectEl as HTMLSelectElement;
  const playBtn = playBtnEl as HTMLButtonElement;
  const respawnBtn = respawnBtnEl as HTMLButtonElement;
  const deathText = deathTextEl as HTMLDivElement;
  const minimapCtx = minimapEl?.getContext('2d') ?? undefined;
  const classRadarCtx = classRadar.getContext('2d');
  if (!classRadarCtx) throw new Error('classRadar Canvas 2D context를 만들 수 없습니다.');

  const evoHud = evoHudEl as HTMLDivElement;
  const evoFill = evoFillEl as HTMLDivElement;
  const evoText = evoTextEl as HTMLDivElement;
  const skillBtn = skillBtnEl as HTMLButtonElement;
  const mutationOverlay = mutationOverlayEl as HTMLDivElement;
  const mutationStage = mutationStageEl as HTMLDivElement;
  const mutationCards = mutationCardsEl as HTMLDivElement;
  const sixthSense = sixthSenseEl as HTMLDivElement;
  const bestScoreText = bestScoreEl as HTMLDivElement | null;
  const lastScoreText = lastScoreEl as HTMLDivElement | null;
  let minimapAcc = 0;

  const storedName = localStorage.getItem('mewdle_name');
  if (storedName) nameInput.value = storedName;
  const storedClass = localStorage.getItem('mewdle_class') as WormClass | null;
  if (storedClass && ['iron', 'shadow', 'magnetic'].includes(storedClass)) {
    classSelect.value = storedClass;
  }

  const BEST_SCORE_KEY = 'mewdle_bestScore';
  const LAST_SCORE_KEY = 'mewdle_lastScore';

  const readStoredScore = (key: string): number => {
    const raw = localStorage.getItem(key);
    if (!raw) return 0;
    const n = Number(raw);
    return Number.isFinite(n) ? n : 0;
  };

  const renderMenuStats = (): void => {
    if (bestScoreText) bestScoreText.textContent = formatScore(readStoredScore(BEST_SCORE_KEY));
    if (lastScoreText) lastScoreText.textContent = formatScore(readStoredScore(LAST_SCORE_KEY));
  };

  renderMenuStats();

  // Lobby class UI
  const todayPick = recommendedClassForToday();
  classRecommend.textContent = `오늘의 추천 클래스: ${titleForClass(todayPick)} (+10% Bonus)`;

  const clampClass = (dna: WormClass): WormClass => (CLASS_ORDER.includes(dna) ? dna : 'shadow');

  let lobbyClass: WormClass = clampClass((classSelect.value as WormClass) || 'shadow');
  const LOBBY_PREVIEW_ID = '__lobby_preview__';
  let lobbyPreviewRender: PlayerRender | undefined;
  const LOBBY_PREVIEW_SEGMENTS = 72;
  const lobbyPreviewPose: Vec2[] = Array.from({ length: LOBBY_PREVIEW_SEGMENTS }, () => ({ x: 0, y: 0 }));

  const lobbyPreviewColorFor = (dna: WormClass): number =>
    dna === 'iron' ? 0xffb15a : dna === 'shadow' ? 0x00e5ff : 0x8cff00;

  const applyLobbyPreviewStyle = (): void => {
    if (!lobbyPreviewRender) return;
    lobbyPreviewRender.dna = lobbyClass;
    lobbyPreviewRender.color = lobbyPreviewColorFor(lobbyClass);
    lobbyPreviewRender.name = '';
    lobbyPreviewRender.mutations = [];
    lobbyPreviewRender.armor = lobbyClass === 'iron' ? 2 : 0;
    lobbyPreviewRender.stealth = false;
    lobbyPreviewRender.phase = false;
    lobbyPreviewRender.skillActive = false;
    lobbyPreviewRender.boosting = lobbyClass !== 'iron';
  };

  const updateLobby = (dna: WormClass, persist = true): void => {
    lobbyClass = clampClass(dna);
    classSelect.value = lobbyClass;
    className.textContent = titleForClass(lobbyClass);
    classDesc.textContent = descForClass(lobbyClass);

    const accentRgb =
      lobbyClass === 'iron' ? '224, 123, 57' : lobbyClass === 'shadow' ? '0, 229, 255' : '140, 255, 0';
    const accent = `rgba(${accentRgb}, 0.95)`;
    menu.style.setProperty('--accent', accent);
    menu.style.setProperty('--accent-soft', `rgba(${accentRgb}, 0.18)`);
    menu.style.setProperty('--accent-border', `rgba(${accentRgb}, 0.28)`);
    drawHexRadar(classRadarCtx, CLASS_META[lobbyClass].stats, accent);

    if (persist) localStorage.setItem('mewdle_class', lobbyClass);
    applyLobbyPreviewStyle();
  };

  updateLobby(lobbyClass, false);

  let lobbySwapTimer: number | undefined;
  const triggerLobbySwap = (dir: -1 | 1): void => {
    classPanel.dataset.dir = dir === 1 ? 'next' : 'prev';
    classPanel.classList.remove('swap');
    // Restart keyframes reliably.
    void classPanel.offsetWidth;
    classPanel.classList.add('swap');
    if (lobbyPreviewRender) lobbyPreviewRender.spawnFx = Math.max(lobbyPreviewRender.spawnFx, 0.22);
    if (lobbySwapTimer) window.clearTimeout(lobbySwapTimer);
    lobbySwapTimer = window.setTimeout(() => classPanel.classList.remove('swap'), 820);
  };

  const stepLobby = (dir: -1 | 1): void => {
    const idx = Math.max(0, CLASS_ORDER.indexOf(lobbyClass));
    const next = (idx + dir + CLASS_ORDER.length) % CLASS_ORDER.length;
    updateLobby(CLASS_ORDER[next] ?? 'shadow');
    triggerLobbySwap(dir);
  };

  classPrev.addEventListener('click', () => stepLobby(-1));
  classNext.addEventListener('click', () => stepLobby(1));

  const menuLeft = menu.querySelector('.menu-left') as HTMLDivElement | null;

  const bindLobbySwipe = (el: HTMLElement): void => {
    let swipePointerId: number | undefined;
    let swipeStartX: number | undefined;

    el.addEventListener('pointerdown', (e) => {
      if (menu.classList.contains('hidden')) return;
      const target = e.target as HTMLElement | null;
      if (target?.closest('button, input, select, textarea')) return;

      swipePointerId = e.pointerId;
      swipeStartX = e.clientX;
      try {
        el.setPointerCapture(e.pointerId);
      } catch {
        // ignore
      }
    });

    el.addEventListener('pointerup', (e) => {
      if (swipePointerId !== e.pointerId) return;
      if (swipeStartX === undefined) return;
      const dx = e.clientX - swipeStartX;

      swipePointerId = undefined;
      swipeStartX = undefined;
      try {
        el.releasePointerCapture(e.pointerId);
      } catch {
        // ignore
      }

      if (Math.abs(dx) < 24) return;
      stepLobby(dx > 0 ? -1 : 1);
    });

    el.addEventListener('pointercancel', (e) => {
      if (swipePointerId !== e.pointerId) return;
      swipePointerId = undefined;
      swipeStartX = undefined;
      try {
        el.releasePointerCapture(e.pointerId);
      } catch {
        // ignore
      }
    });
  };

  bindLobbySwipe(classSwipeArea);
  if (menuLeft) bindLobbySwipe(menuLeft);

  const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio ?? 1, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  document.body.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  const fogColor = 0x0d0f14;
  scene.background = new THREE.Color(fogColor);
  scene.fog = new THREE.Fog(fogColor, 5200, 15000);

  const camera3 = new THREE.PerspectiveCamera(48, window.innerWidth / window.innerHeight, 0.1, 26000);
  camera3.position.set(-900, 1150, 900);
  camera3.lookAt(0, 0, 0);

  const world = new THREE.Group();
  scene.add(world);

  // Build a default world grid immediately so the lobby has a nice backdrop.
  // (The server will send the authoritative size in `welcome`, but this project uses a fixed world size anyway.)
  const initialGrid = createWorldGrid({ width: 16000, height: 16000 }, renderer.capabilities.getMaxAnisotropy());
  initialGrid.name = 'grid';
  world.add(initialGrid);

  // Lighting tuned for "MOBA-ish" readability (clear silhouettes + grounded scene).
  const hemi = new THREE.HemisphereLight(0x86a1ff, 0x07080c, 0.48);
  const key = new THREE.DirectionalLight(0xffffff, 1.05);
  key.position.set(-820, 1600, 900);
  const rim = new THREE.DirectionalLight(0xffc58a, 0.28);
  rim.position.set(920, 900, -720);
  scene.add(hemi, key, rim);

  const tmpObj = new THREE.Object3D();
  const tmpColor = new THREE.Color();
  const tmpDir = new THREE.Vector3();
  const up = new THREE.Vector3(0, 1, 0);
  const tmpQuat = new THREE.Quaternion();

  const FOOD_MAX_INST = 2400;
  const foodGeometry = new THREE.SphereGeometry(1, 12, 12);
  ensureVertexColorOnes(foodGeometry);
  const foodGlowTexture = createGlowCircleTexture();
  foodGlowTexture.colorSpace = THREE.SRGBColorSpace;

  const foodGlowGeometry = new THREE.CircleGeometry(1, 32);
  foodGlowGeometry.rotateX(-Math.PI / 2);
  ensureVertexColorOnes(foodGlowGeometry);

  const foodGlowMesh = new THREE.InstancedMesh(
    foodGlowGeometry,
    new THREE.MeshBasicMaterial({
      map: foodGlowTexture,
      color: 0xffffff,
      vertexColors: true,
      transparent: true,
      opacity: 0.75,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      toneMapped: false,
    }),
    FOOD_MAX_INST,
  );
  // Ensure instance colors exist; otherwise vertex colors default to black in WebGL.
  foodGlowMesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(FOOD_MAX_INST * 3), 3);
  foodGlowMesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
  foodGlowMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  foodGlowMesh.frustumCulled = false;
  foodGlowMesh.count = 0;
  foodGlowMesh.renderOrder = 2;
  world.add(foodGlowMesh);

  const foodMesh = new THREE.InstancedMesh(
    foodGeometry,
    new THREE.MeshBasicMaterial({
      color: 0xffffff,
      vertexColors: true,
      toneMapped: false,
    }),
    FOOD_MAX_INST,
  );
  // Ensure instance colors exist; otherwise vertex colors default to black in WebGL.
  foodMesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(FOOD_MAX_INST * 3), 3);
  foodMesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
  foodMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  foodMesh.frustumCulled = false;
  foodMesh.count = 0;
  foodMesh.renderOrder = 3;
  world.add(foodMesh);

  const GAS_MAX_INST = 800;
  const gasMesh = new THREE.InstancedMesh(
    new THREE.SphereGeometry(1, 16, 12),
    new THREE.MeshBasicMaterial({ color: 0x0b0d12, transparent: true, opacity: 0.15, depthWrite: false }),
    GAS_MAX_INST,
  );
  gasMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  gasMesh.frustumCulled = false;
  gasMesh.count = 0;
  world.add(gasMesh);

  const blackHoleGroup = new THREE.Group();
  world.add(blackHoleGroup);

  const blackHoleCoreGeometry = new THREE.CircleGeometry(0.58, 64);
  blackHoleCoreGeometry.rotateX(-Math.PI / 2);
  const blackHoleRingGeometry = new THREE.RingGeometry(0.58, 1.0, 96);
  blackHoleRingGeometry.rotateX(-Math.PI / 2);

  type BlackHoleRender = { group: THREE.Group; core: THREE.Mesh; ring: THREE.Mesh };
  const blackHoleRenders = new Map<string, BlackHoleRender>();

  const aimIndicatorGeometry = new THREE.RingGeometry(0.82, 1.0, 84);
  aimIndicatorGeometry.rotateX(-Math.PI / 2);
  const aimIndicatorMaterial = new THREE.MeshBasicMaterial({
    color: 0x9dff00,
    transparent: true,
    opacity: 0.55,
    depthWrite: false,
  });
  const aimIndicator = new THREE.Mesh(aimIndicatorGeometry, aimIndicatorMaterial);
  aimIndicator.visible = false;
  blackHoleGroup.add(aimIndicator);

  const actorRoot = new THREE.Group();
  world.add(actorRoot);

  const PARTICLE_MAX = 5000;
  const particlePositions = new Float32Array(PARTICLE_MAX * 3);
  const particleColors = new Float32Array(PARTICLE_MAX * 4);
  const particleSizes = new Float32Array(PARTICLE_MAX);

  const particleGeometry = new THREE.BufferGeometry();
  const particlePosAttr = new THREE.BufferAttribute(particlePositions, 3);
  particlePosAttr.setUsage(THREE.DynamicDrawUsage);
  const particleColorAttr = new THREE.BufferAttribute(particleColors, 4);
  particleColorAttr.setUsage(THREE.DynamicDrawUsage);
  const particleSizeAttr = new THREE.BufferAttribute(particleSizes, 1);
  particleSizeAttr.setUsage(THREE.DynamicDrawUsage);
  particleGeometry.setAttribute('position', particlePosAttr);
  particleGeometry.setAttribute('color', particleColorAttr);
  particleGeometry.setAttribute('size', particleSizeAttr);
  particleGeometry.setDrawRange(0, 0);

  const particleMaterial = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    depthTest: true,
    blending: THREE.AdditiveBlending,
    vertexShader: `
      attribute float size;
      attribute vec4 color;
      varying vec4 vColor;
      void main() {
        vColor = color;
        vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
        gl_Position = projectionMatrix * mvPosition;
        gl_PointSize = size;
      }
    `,
    fragmentShader: `
      varying vec4 vColor;
      void main() {
        vec2 uv = gl_PointCoord - vec2(0.5);
        float d = length(uv);
        float alpha = 1.0 - smoothstep(0.35, 0.5, d);
        gl_FragColor = vec4(vColor.rgb, vColor.a * alpha);
      }
    `,
  });

  const particlePoints = new THREE.Points(particleGeometry, particleMaterial);
  particlePoints.frustumCulled = false;
  world.add(particlePoints);

  let myId: string | undefined;
  let serverConfig: WelcomePayload | undefined;

  let foods: FoodState[] = [];
type FoodVisual = {
  id: string;
  x: number;
  y: number;
  tx: number;
  ty: number;
  r: number;
  tr: number;
  color: number;
  value: number;
  present: boolean;
  alpha: number;
  sucked: boolean;
  suckLift: number;
};
  const foodVisuals = new Map<string, FoodVisual>();
  let prevFoodMap = new Map<string, FoodState>();
  const playerRenders = new Map<string, PlayerRender>();
  const decoyRenders = new Map<string, PlayerRender>();

  const particles: Particle[] = [];
  let boostSpawnAcc = 0;
  let boostRingAcc = 0;
  let skillFxAcc = 0;

  const camera = { x: 0, y: 0, zoom: 1 };
  let shake = 0;

  let lastLen = 0;
  let latestState: StatePayload | undefined;
  let gas: GasState[] = [];
  let decoys: DecoyState[] = [];
  let blackHoles: BlackHoleState[] = [];
  const prevHeads = new Map<string, { x: number; y: number; t: number }>();
  const headVels = new Map<string, { vx: number; vy: number }>();
  const sixthSenseTmp = new THREE.Vector3();

  let mutationOpen = false;
  let pendingChoices: MutationChoice[] = [];

  const WORM_MAX_INST = 360;
  const wormBodyRoundGeometry = new THREE.CapsuleGeometry(1, 1, 6, 12);
  const wormBodyHexGeometry = new THREE.CylinderGeometry(1, 1, 1, 6, 1, false);
  const wormBodyTriGeometry = new THREE.CylinderGeometry(1, 1, 1, 3, 1, false);
  const wormSpineGeometry = new THREE.CylinderGeometry(1, 1, 1, 10, 1, false);
  ensureVertexColorOnes(wormBodyRoundGeometry);
  ensureVertexColorOnes(wormBodyHexGeometry);
  ensureVertexColorOnes(wormBodyTriGeometry);
  ensureVertexColorOnes(wormSpineGeometry);
  const auraGeometry = new THREE.RingGeometry(0.84, 1.0, 72);

  const runeTexture = createRuneCircleTexture();
  runeTexture.colorSpace = THREE.SRGBColorSpace;

  const magicCircleGeometry = new THREE.RingGeometry(0.78, 1.12, 96);
  magicCircleGeometry.rotateX(-Math.PI / 2);

  const SCARF_WIDTH = 1.35;
  const SCARF_LENGTH = 9.2;
  const SCARF_SEGMENTS = 22;

  const createScarfMesh = (): THREE.Mesh => {
    const geo = new THREE.PlaneGeometry(SCARF_WIDTH, SCARF_LENGTH, 6, SCARF_SEGMENTS);
    geo.rotateX(-Math.PI / 2);
    geo.translate(0, 0, -SCARF_LENGTH / 2);
    const pos = geo.getAttribute('position') as THREE.BufferAttribute | null;
    if (pos) {
      geo.userData.basePos = new Float32Array(pos.array as Float32Array);
      geo.userData.len = SCARF_LENGTH;
    }

    const mat = new THREE.MeshBasicMaterial({
      color: 0x00e5ff,
      transparent: true,
      opacity: 0,
      side: THREE.DoubleSide,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      toneMapped: false,
    });

    const mesh = new THREE.Mesh(geo, mat);
    mesh.renderOrder = 2;
    mesh.visible = false;
    return mesh;
  };

  const createMagicCircleMesh = (): THREE.Mesh => {
    const mat = new THREE.MeshBasicMaterial({
      map: runeTexture,
      color: 0xffffff,
      transparent: true,
      opacity: 0,
      side: THREE.DoubleSide,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      toneMapped: false,
    });
    const mesh = new THREE.Mesh(magicCircleGeometry, mat);
    mesh.renderOrder = 1;
    mesh.visible = false;
    return mesh;
  };

  const animateScarf = (mesh: THREE.Mesh, t: number, seed: number, intensity: number): void => {
    const geo = mesh.geometry as THREE.BufferGeometry;
    const pos = geo.getAttribute('position') as THREE.BufferAttribute | undefined;
    const base = geo.userData.basePos as Float32Array | undefined;
    const len = (geo.userData.len as number | undefined) ?? SCARF_LENGTH;
    if (!pos || !base) return;

    const arr = pos.array as Float32Array;
    const speed = 7.6 + intensity * 7.2;
    const sideAmp = 0.12 + intensity * 0.28;
    const liftAmp = 0.14 + intensity * 0.24;
    const curlAmp = 0.08 + intensity * 0.22;
    const flickerAmp = 0.03 + intensity * 0.07;
    const halfW = SCARF_WIDTH / 2;
    for (let i = 0; i < pos.count; i++) {
      const bi = i * 3;
      const bx = base[bi + 0] ?? 0;
      const by = base[bi + 1] ?? 0;
      const bz = base[bi + 2] ?? 0;

      const f = clamp(-bz / len, 0, 1);
      const env = f * f;
      const xNorm = halfW > 0 ? clamp(bx / halfW, -1, 1) : 0;
      const edge = Math.abs(xNorm);
      const edgeEnv = edge * edge;

      const phase = t * speed + bz * 2.25 + seed * 11.2;
      const flame = Math.sin(phase + xNorm * 1.6 + Math.sin(phase * 1.7) * 0.35) * sideAmp * env;
      const curl = Math.sin(t * (3.0 + intensity * 1.2) + bz * 3.6 + seed * 7.0) * xNorm * curlAmp * env * (0.5 + edgeEnv);
      const flicker = Math.sin(t * (11.0 + intensity * 8.0) + bz * 5.2 + seed * 13.0 + bx * 4.0) * flickerAmp * env;

      const lift = (0.4 + 0.6 * Math.sin(phase * 1.1 + seed * 2.0)) * liftAmp * env;
      const flutter = Math.sin(phase * 0.6 + bx * 3.0 + seed * 1.7) * (0.06 + intensity * 0.08) * env;

      arr[bi + 0] = bx + flame + curl + flicker;
      arr[bi + 1] = by + lift + flutter;
      arr[bi + 2] = bz;
    }
    pos.needsUpdate = true;
  };

  const shadowGeometry = new THREE.CircleGeometry(1, 42);
  shadowGeometry.rotateX(-Math.PI / 2);
  const shadowTexture = createSoftCircleTexture();
  const shadowMaterialBase = new THREE.MeshBasicMaterial({
    map: shadowTexture,
    color: 0xffffff,
    transparent: true,
    opacity: 0.18,
    depthWrite: false,
  });

  const nameFont = '700 14px system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, "Noto Sans KR", sans-serif';
  const namePadX = 10;
  const namePadY = 6;

  function makeNameTexture(text: string): { texture: THREE.CanvasTexture; w: number; h: number } {
    const safe = text.length > 0 ? text : 'Unknown';
    const dpr = Math.min(window.devicePixelRatio ?? 1, 2);

    const measure = document.createElement('canvas');
    const mctx = measure.getContext('2d');
    if (!mctx) throw new Error('Canvas 2D context를 만들 수 없습니다.');
    mctx.font = nameFont;
    const metrics = mctx.measureText(safe);

    const w = Math.ceil(metrics.width + namePadX * 2);
    const h = Math.ceil(14 + namePadY * 2);

    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.ceil(w * dpr));
    canvas.height = Math.max(1, Math.ceil(h * dpr));

    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Canvas 2D context를 만들 수 없습니다.');
    ctx.scale(dpr, dpr);

    ctx.font = nameFont;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.lineWidth = 4;
    ctx.strokeStyle = 'rgba(0, 0, 0, 0.9)';
    ctx.strokeText(safe, w / 2, h / 2);

    ctx.fillStyle = 'rgba(234, 240, 255, 0.95)';
    ctx.fillText(safe, w / 2, h / 2);

    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.needsUpdate = true;
    texture.minFilter = THREE.LinearFilter;
    texture.magFilter = THREE.LinearFilter;
    return { texture, w, h };
  }

  function setNameSprite(render: PlayerRender, text: string): void {
    const next = text.length > 0 ? text : 'Unknown';
    if (render.nameKey === next) return;
    render.nameKey = next;

    const mat = render.nameSprite.material as THREE.SpriteMaterial;
    if (mat.map) mat.map.dispose();
    const { texture, w, h } = makeNameTexture(next);
    mat.map = texture;
    mat.needsUpdate = true;
    render.nameSprite.scale.set(w, h, 1);
  }

  function ensurePlayerRender(id: string): PlayerRender {
    const existing = playerRenders.get(id);
    if (existing) return existing;

    const group = new THREE.Group();
    actorRoot.add(group);

    const material = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      vertexColors: true,
      roughness: 0.38,
      metalness: 0.12,
      transparent: true,
      opacity: 1,
    });
    material.emissive = new THREE.Color(0x000000);
    material.emissiveIntensity = 0.0;

    const body = new THREE.InstancedMesh(wormBodyRoundGeometry, material, WORM_MAX_INST);
    // Ensure instance colors exist; otherwise vertex colors default to black in WebGL.
    body.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(WORM_MAX_INST * 3), 3);
    body.instanceColor.setUsage(THREE.DynamicDrawUsage);
    body.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    body.frustumCulled = false;
    body.count = 0;
    body.renderOrder = 3;

    const spineMaterial = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      vertexColors: true,
      roughness: 0.14,
      metalness: 0.0,
      transparent: true,
      opacity: 0,
      depthWrite: false,
    });
    spineMaterial.emissive = new THREE.Color(0x000000);
    spineMaterial.emissiveIntensity = 0.0;

    const spine = new THREE.InstancedMesh(wormSpineGeometry, spineMaterial, WORM_MAX_INST);
    // Shadow spine also uses per-instance colors.
    spine.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(WORM_MAX_INST * 3), 3);
    spine.instanceColor.setUsage(THREE.DynamicDrawUsage);
    spine.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    spine.frustumCulled = false;
    spine.count = 0;
    spine.visible = false;
    spine.renderOrder = 2;

    const head = new THREE.Group();
    head.renderOrder = 4;

    const scarf = createScarfMesh();
    const magicCircle = createMagicCircleMesh();

    const shadowMat = shadowMaterialBase.clone();
    const shadow = new THREE.Mesh(shadowGeometry, shadowMat);
    shadow.position.y = 0.02;
    shadow.renderOrder = 0;

    const auraMat = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 0,
      side: THREE.DoubleSide,
      depthWrite: false,
      blending: THREE.NormalBlending,
    });
    const aura = new THREE.Mesh(auraGeometry, auraMat);
    aura.rotation.x = -Math.PI / 2;
    aura.position.y = 0.03;
    aura.renderOrder = 1;

    const nameSprite = new THREE.Sprite(
      new THREE.SpriteMaterial({ transparent: true, depthWrite: false, depthTest: false }),
    );
    nameSprite.center.set(0.5, 0);
    nameSprite.scale.set(1, 1, 1);
    nameSprite.renderOrder = 10;

    group.add(shadow);
    group.add(aura);
    group.add(magicCircle);
    group.add(scarf);
    group.add(spine);
    group.add(body);
    group.add(head);
    group.add(nameSprite);

    const seed = hashString32(id);
  const render: PlayerRender = {
      group,
      body,
      spine,
      material,
      spineMaterial,
      head,
      headMaterials: [],
      shadow,
      aura,
      nameSprite,
      nameKey: '',
      segs: [],
      targetSegs: [],
      name: '',
      color: 0xffffff,
      boosting: false,
      dna: 'shadow',
      armor: 0,
      stealth: false,
      phase: false,
      mutations: [],
      skillActive: false,
      isDecoy: false,
      spawnFx: 1,
      eatFx: 0,
      heading: 0,
      headingValid: false,
      bank: 0,
      scarf,
      magicCircle,
      visualLen: 0,
      skinSeed: seed,
      skinPalette: [],
      skinStripe: 8,
      skinOffset: ((seed >>> 8) & 0xffff) / 0xffff,
      styleDna: 'shadow',
      styleColor: 0,
      prevArmor: 0,
      prevStealth: false,
    };
    playerRenders.set(id, render);
    return render;
  }

  // Lobby 3D preview worm (uses the same rendering pipeline, but is never driven by server state).
  lobbyPreviewRender = ensurePlayerRender(LOBBY_PREVIEW_ID);
  lobbyPreviewRender.group.name = 'lobbyPreview';
  lobbyPreviewRender.spawnFx = 0;
  lobbyPreviewRender.nameSprite.visible = false;
  applyLobbyPreviewStyle();

  function ensureDecoyRender(id: string): PlayerRender {
    const existing = decoyRenders.get(id);
    if (existing) return existing;

    const group = new THREE.Group();
    actorRoot.add(group);

    const material = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      vertexColors: true,
      roughness: 0.42,
      metalness: 0.08,
      transparent: true,
      opacity: 0.72,
    });
    material.emissive = new THREE.Color(0x000000);
    material.emissiveIntensity = 0.0;

    const body = new THREE.InstancedMesh(wormBodyRoundGeometry, material, WORM_MAX_INST);
    // Ensure instance colors exist; otherwise vertex colors default to black in WebGL.
    body.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(WORM_MAX_INST * 3), 3);
    body.instanceColor.setUsage(THREE.DynamicDrawUsage);
    body.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    body.frustumCulled = false;
    body.count = 0;
    body.renderOrder = 3;

    const spineMaterial = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      vertexColors: true,
      roughness: 0.14,
      metalness: 0.0,
      transparent: true,
      opacity: 0,
      depthWrite: false,
    });
    spineMaterial.emissive = new THREE.Color(0x000000);
    spineMaterial.emissiveIntensity = 0.0;

    const spine = new THREE.InstancedMesh(wormSpineGeometry, spineMaterial, WORM_MAX_INST);
    spine.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(WORM_MAX_INST * 3), 3);
    spine.instanceColor.setUsage(THREE.DynamicDrawUsage);
    spine.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    spine.frustumCulled = false;
    spine.count = 0;
    spine.visible = false;
    spine.renderOrder = 2;

    const head = new THREE.Group();
    head.renderOrder = 4;

    const scarf = createScarfMesh();
    const magicCircle = createMagicCircleMesh();

    const shadowMat = shadowMaterialBase.clone();
    const shadow = new THREE.Mesh(shadowGeometry, shadowMat);
    shadow.position.y = 0.02;
    shadow.renderOrder = 0;

    const auraMat = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 0,
      side: THREE.DoubleSide,
      depthWrite: false,
      blending: THREE.NormalBlending,
    });
    const aura = new THREE.Mesh(auraGeometry, auraMat);
    aura.rotation.x = -Math.PI / 2;
    aura.position.y = 0.03;
    aura.renderOrder = 1;

    const nameSprite = new THREE.Sprite(
      new THREE.SpriteMaterial({ transparent: true, depthWrite: false, depthTest: false }),
    );
    nameSprite.center.set(0.5, 0);
    nameSprite.scale.set(1, 1, 1);
    nameSprite.renderOrder = 10;

    group.add(shadow);
    group.add(aura);
    group.add(magicCircle);
    group.add(scarf);
    group.add(spine);
    group.add(body);
    group.add(head);
    group.add(nameSprite);

    const seed = hashString32(id);
    const render: PlayerRender = {
      group,
      body,
      spine,
      material,
      spineMaterial,
      head,
      headMaterials: [],
      shadow,
      aura,
      nameSprite,
      nameKey: '',
      segs: [],
      targetSegs: [],
      name: '',
      color: 0xffffff,
      boosting: false,
      dna: 'shadow',
      armor: 0,
      stealth: false,
      phase: false,
      mutations: [],
      skillActive: false,
      isDecoy: true,
      ownerId: undefined,
      spawnFx: 0.5,
      eatFx: 0,
      heading: 0,
      headingValid: false,
      bank: 0,
      scarf,
      magicCircle,
      visualLen: 0,
      skinSeed: seed,
      skinPalette: [],
      skinStripe: 8,
      skinOffset: ((seed >>> 8) & 0xffff) / 0xffff,
      styleDna: 'shadow',
      styleColor: 0,
      prevArmor: 0,
      prevStealth: false,
    };
    decoyRenders.set(id, render);
    return render;
  }

  const forward = new THREE.Vector3(0, 0, 1);

  const ironHeadBodyGeometry = new THREE.BoxGeometry(1.25, 0.9, 1.45);
  const ironHeadShieldGeometry = new THREE.BoxGeometry(1.35, 0.95, 0.32);
  ironHeadShieldGeometry.translate(0, 0, 0.86);

  const shadowHeadOuterGeometry = new THREE.ConeGeometry(0.75, 2.05, 3, 1, false);
  shadowHeadOuterGeometry.rotateX(Math.PI / 2);
  shadowHeadOuterGeometry.translate(0, 0, 0.86);
  const shadowHeadInnerGeometry = new THREE.ConeGeometry(0.45, 1.6, 3, 1, false);
  shadowHeadInnerGeometry.rotateX(Math.PI / 2);
  shadowHeadInnerGeometry.translate(0, 0, 0.78);

  const magneticHeadGeometry = new THREE.SphereGeometry(0.95, 18, 14);
  const magneticMouthGeometry = new THREE.CylinderGeometry(0.95, 0.7, 0.55, 24, 1, true);
  magneticMouthGeometry.rotateX(Math.PI / 2);
  magneticMouthGeometry.translate(0, 0, 0.9);
  const magneticMouthDiscGeometry = new THREE.CircleGeometry(0.55, 24);
  magneticMouthDiscGeometry.translate(0, 0, 1.05);
  const arcanaOrbGeometry = new THREE.SphereGeometry(0.92, 22, 16);
  const arcanaRingGeometry = new THREE.TorusGeometry(1.2, 0.07, 10, 40);
  arcanaRingGeometry.rotateX(Math.PI / 2);

  function buildSkin(dna: WormClass, seed: number, baseColor: number): { palette: number[]; stripe: number } {
    const seedJitter = (((seed >>> 0) & 0xff) / 255 - 0.5) * 0.08;

    if (dna === 'iron') {
      const whiteSteel = 0xf0f4f8;
      const darkJoint = 0x2b303b;
      const accent = mixColor(0xffd700, baseColor, 0.55 + seedJitter * 0.5);
      return { palette: [whiteSteel, whiteSteel, darkJoint, whiteSteel, accent, darkJoint], stripe: 4 };
    }

    if (dna === 'shadow') {
      const matBlack = 0x111111;
      const neon1 = mixColor(baseColor, 0x00e5ff, 0.55 + seedJitter * 0.4);
      const neon2 = mixColor(baseColor, 0xb000ff, 0.55 - seedJitter * 0.4);
      return { palette: [matBlack, matBlack, matBlack, neon1, matBlack, neon2], stripe: 8 };
    }

    // magnetic
    const cosmicBlue = 0x191970;
    const starLight = 0xe0ffff;
    const nebula = mixColor(0xff007f, baseColor, 0.4 + seedJitter * 0.35);
    return { palette: [cosmicBlue, cosmicBlue, nebula, cosmicBlue, starLight, nebula], stripe: 10 };
  }

  function clearHead(render: PlayerRender): void {
    for (const m of render.headMaterials) m.dispose();
    render.headMaterials.length = 0;
    while (render.head.children.length > 0) render.head.remove(render.head.children[0]!);
  }

  function applyClassVisual(render: PlayerRender): void {
    if (render.styleDna === render.dna && render.styleColor === render.color) return;
    render.styleDna = render.dna;
    render.styleColor = render.color;

    render.body.geometry = render.dna === 'iron' ? wormBodyHexGeometry : wormBodyRoundGeometry;

    // Flat shading helps the tank read as plated/armored.
    render.material.flatShading = render.dna === 'iron';
    render.material.needsUpdate = true;

    render.spine.visible = false;
    if (render.scarf) render.scarf.visible = render.dna === 'shadow';
    if (render.magicCircle) render.magicCircle.visible = render.dna === 'magnetic';

    const skin = buildSkin(render.dna, render.skinSeed, render.color);
    render.skinPalette = skin.palette;
    render.skinStripe = skin.stripe;

    clearHead(render);

    const makeHeadMat = (color: number): THREE.MeshStandardMaterial => {
      const m = new THREE.MeshStandardMaterial({
        color,
        roughness: 0.45,
        metalness: 0.05,
        transparent: true,
        opacity: 1,
      });
      m.emissive = new THREE.Color(0x000000);
      m.emissiveIntensity = 0.0;
      return m;
    };

    if (render.dna === 'iron') {
      const primary = makeHeadMat(0xf0f4f8);
      const accent = makeHeadMat(0xffd700);
      render.headMaterials.push(primary, accent);

      const headBody = new THREE.Mesh(ironHeadBodyGeometry, primary);
      const shield = new THREE.Mesh(ironHeadShieldGeometry, accent);
      headBody.renderOrder = 4;
      shield.renderOrder = 4;
      render.head.add(headBody, shield);
    } else if (render.dna === 'shadow') {
      const outer = makeHeadMat(0x0b0d12);
      const inner = makeHeadMat(0x00e5ff);
      outer.roughness = 0.18;
      outer.metalness = 0.0;
      inner.roughness = 0.08;
      inner.metalness = 0.0;
      render.headMaterials.push(outer, inner);

      const outerMesh = new THREE.Mesh(shadowHeadOuterGeometry, outer);
      const innerMesh = new THREE.Mesh(shadowHeadInnerGeometry, inner);
      outerMesh.renderOrder = 4;
      innerMesh.renderOrder = 4;
      render.head.add(outerMesh, innerMesh);
    } else {
      const orb = makeHeadMat(0x191970);
      const rune = makeHeadMat(0xff007f);
      orb.roughness = 0.18;
      orb.metalness = 0.0;
      rune.roughness = 0.14;
      rune.metalness = 0.0;
      render.headMaterials.push(orb, rune);

      const orbMesh = new THREE.Mesh(arcanaOrbGeometry, orb);
      const ringMesh = new THREE.Mesh(arcanaRingGeometry, rune);
      orbMesh.renderOrder = 4;
      ringMesh.renderOrder = 4;
      render.head.add(orbMesh, ringMesh);
    }
  }

  function destroyMissingPlayers(players: Record<string, PlayerState>): void {
    for (const [id, render] of playerRenders) {
      if (id === LOBBY_PREVIEW_ID) continue;
      if (players[id]) continue;
      const head = render.segs[0] ?? render.targetSegs[0];
      if (head) {
        const count = Math.round(clamp(render.segs.length * 0.85, 18, 70));
        spawnBurst(particles, head, render.color, count);
      }
      disposeRender(render);
      playerRenders.delete(id);
    }
  }

  function destroyMissingDecoys(live: DecoyState[]): void {
    const liveIds = new Set(live.map((d) => d.id));
    for (const [id, render] of decoyRenders) {
      if (liveIds.has(id)) continue;
      const head = render.segs[0] ?? render.targetSegs[0];
      if (head) {
        spawnBurst(particles, head, render.color, 18);
      }
      disposeRender(render);
      decoyRenders.delete(id);
    }
  }

  function ensureBlackHoleRender(id: string): BlackHoleRender {
    const existing = blackHoleRenders.get(id);
    if (existing) return existing;

    const group = new THREE.Group();
    blackHoleGroup.add(group);

    const coreMat = new THREE.MeshBasicMaterial({
      color: 0x06070a,
      transparent: true,
      opacity: 0.95,
      depthWrite: false,
    });
    const core = new THREE.Mesh(blackHoleCoreGeometry, coreMat);
    core.position.y = 0.025;
    core.renderOrder = 2;

    const ringMat = new THREE.MeshBasicMaterial({
      color: 0xb000ff,
      transparent: true,
      opacity: 0.72,
      side: THREE.DoubleSide,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    const ring = new THREE.Mesh(blackHoleRingGeometry, ringMat);
    ring.position.y = 0.03;
    ring.renderOrder = 3;

    group.add(core);
    group.add(ring);

    const render: BlackHoleRender = { group, core, ring };
    blackHoleRenders.set(id, render);
    return render;
  }

  function disposeBlackHoleRender(render: BlackHoleRender): void {
    blackHoleGroup.remove(render.group);
    (render.core.material as THREE.Material).dispose();
    (render.ring.material as THREE.Material).dispose();
  }

  function destroyMissingBlackHoles(live: BlackHoleState[]): void {
    const liveIds = new Set(live.map((h) => h.id));
    for (const [id, render] of blackHoleRenders) {
      if (liveIds.has(id)) continue;
      disposeBlackHoleRender(render);
      blackHoleRenders.delete(id);
    }
  }

  function disposeRender(render: PlayerRender): void {
    actorRoot.remove(render.group);
    render.material.dispose();
    render.spineMaterial.dispose();
    for (const m of render.headMaterials) m.dispose();
    render.headMaterials.length = 0;
    (render.shadow.material as THREE.Material).dispose();
    (render.aura.material as THREE.Material).dispose();
    if (render.scarf) {
      render.group.remove(render.scarf);
      render.scarf.geometry.dispose();
      (render.scarf.material as THREE.Material).dispose();
      render.scarf = undefined;
    }
    if (render.magicCircle) {
      render.group.remove(render.magicCircle);
      (render.magicCircle.material as THREE.Material).dispose();
      render.magicCircle = undefined;
    }
    const nameMat = render.nameSprite.material as THREE.SpriteMaterial;
    if (nameMat.map) nameMat.map.dispose();
    nameMat.dispose();
  }

  function ingestState(state: StatePayload): void {
    latestState = state;

    // Sixth Sense uses velocities from server snapshots (head deltas).
    const now = state.now;
    const liveIds = new Set(Object.keys(state.players));
    for (const id of prevHeads.keys()) {
      if (liveIds.has(id)) continue;
      prevHeads.delete(id);
      headVels.delete(id);
    }
    for (const id of Object.keys(state.players)) {
      const p = state.players[id]!;
      const head = p.segments[0];
      if (!head) continue;
      const prev = prevHeads.get(id);
      if (prev) {
        const dt = (now - prev.t) / 1000;
        if (dt > 0) {
          headVels.set(id, { vx: (head.x - prev.x) / dt, vy: (head.y - prev.y) / dt });
        }
      }
      prevHeads.set(id, { x: head.x, y: head.y, t: now });
    }

    const nextFoodMap = new Map<string, FoodState>();
    for (const v of foodVisuals.values()) v.present = false;
    for (const f of state.foods) {
      nextFoodMap.set(f.id, f);

      const existing = foodVisuals.get(f.id);
      if (existing) {
        existing.tx = f.x;
        existing.ty = f.y;
        existing.tr = f.r;
        existing.color = f.color;
        existing.value = f.value;
        existing.present = true;
        existing.sucked = false;
        existing.suckLift = 0;
      } else {
        foodVisuals.set(f.id, {
          id: f.id,
          x: f.x,
          y: f.y,
          tx: f.x,
          ty: f.y,
          r: f.r,
          tr: f.r,
          color: f.color,
          value: f.value,
          present: true,
          alpha: 0,
          sucked: false,
          suckLift: 0,
        });
      }
    }

    // Food pop FX: only trigger if a head is close enough (foods may stream in/out).
    if (prevFoodMap.size > 0) {
      const popR = 1700;
      const popR2 = popR * popR;
      let spawned = 0;
      for (const [id, prev] of prevFoodMap) {
        if (nextFoodMap.has(id)) continue;
        const dx = prev.x - camera.x;
        const dy = prev.y - camera.y;
        if (dx * dx + dy * dy > popR2) continue;

        let eater: PlayerState | undefined;
        let eaterHead: Vec2 | undefined;
        for (const p of Object.values(state.players)) {
          const head = p.segments[0];
          if (!head) continue;
          const headR = headRadiusForLength(p.segments.length);
          const eatR = headR + prev.r + 18;
          const hx = head.x - prev.x;
          const hy = head.y - prev.y;
          if (hx * hx + hy * hy <= eatR * eatR) {
            eater = p;
            eaterHead = head;
            break;
          }
        }
        if (!eater || !eaterHead) continue;

        const from = { x: prev.x, y: prev.y };
        const to = { x: eaterHead.x, y: eaterHead.y };
        spawnBurst(particles, from, prev.color, 4 + prev.value * 2);
        spawnRing(particles, from, prev.color, Math.max(12, prev.r * (2.4 + prev.value * 1.1)));
        spawnEatSuction(particles, from, to, prev.color, eater.dna, prev.value);

        if (eater.dna === 'magnetic') {
          const v = foodVisuals.get(id);
          if (v) {
            const length = eater.segments.length;
            const headMul = 1.12; // magnetic
            const headBase = headRadiusForLength(length) * headMul;

            let fx = 1;
            let fy = 0;
            const neck = eater.segments[1];
            if (neck) {
              const dx = to.x - neck.x;
              const dy = to.y - neck.y;
              const d2 = dx * dx + dy * dy;
              if (d2 > 0.001) {
                const inv = 1 / Math.sqrt(d2);
                fx = dx * inv;
                fy = dy * inv;
              }
            } else {
              const dx = to.x - from.x;
              const dy = to.y - from.y;
              const d2 = dx * dx + dy * dy;
              if (d2 > 0.001) {
                const inv = 1 / Math.sqrt(d2);
                fx = dx * inv;
                fy = dy * inv;
              }
            }

            // Aim slightly "inside" the head so the food visibly gets swallowed.
            v.tx = to.x + fx * headBase * 0.22;
            v.ty = to.y + fy * headBase * 0.22;
            v.tr = Math.max(0.6, prev.r * 0.08);
            v.sucked = true;
            v.suckLift = clamp(headBase * 0.95, 18, 76);
          }
          spawnRing(particles, to, mixColor(prev.color, 0xa55cff, 0.35), Math.max(10, prev.r * 1.8));
        }

        const eaterRender = ensurePlayerRender(eater.id);
        eaterRender.eatFx = 1;
        spawned++;
        if (spawned >= 46) break;
      }
    }

    prevFoodMap = nextFoodMap;
    foods = state.foods;
    gas = state.gas;
    decoys = state.decoys;
    blackHoles = state.blackHoles ?? [];

    for (const hole of blackHoles) {
      const render = ensureBlackHoleRender(hole.id);
      const remaining = hole.expiresAt - now;
      const fade = clamp(remaining / 700, 0, 1);

      render.group.position.set(hole.x, 0.02, hole.y);
      const outer = hole.r * 0.55;
      render.group.scale.set(outer, 1, outer);

      const coreMat = render.core.material as THREE.MeshBasicMaterial;
      coreMat.opacity = 0.35 + fade * 0.6;
      const ringMat = render.ring.material as THREE.MeshBasicMaterial;
      ringMat.opacity = 0.18 + fade * 0.62;
    }

    destroyMissingBlackHoles(blackHoles);

    for (const id of Object.keys(state.players)) {
      const p = state.players[id]!;
      const render = ensurePlayerRender(id);
      const prevArmor = render.prevArmor;
      const prevStealth = render.prevStealth;
      syncTargetSegments(render, p.segments);
      render.name = p.name;
      render.color = p.color;
      render.boosting = p.boost;
      render.dna = p.dna;
      render.armor = p.armor;
      render.stealth = p.stealth;
      render.phase = p.phase;
      render.mutations = p.mutations;
      render.skillActive = p.skillActive;
      render.isDecoy = false;
      render.ownerId = undefined;

      const head = p.segments[0];
      if (head && p.dna === 'iron' && p.armor < prevArmor) {
        const fxColor = 0xffb15a;
        spawnBurst(particles, { x: head.x, y: head.y }, fxColor, 42);
        spawnRing(particles, { x: head.x, y: head.y }, fxColor, headRadiusForLength(p.segments.length) * 2.4);
        shake = Math.max(shake, 0.55);
      }

      if (head && p.dna === 'shadow' && p.stealth && !prevStealth && id === myId) {
        spawnBurst(particles, { x: head.x, y: head.y }, mixColor(0x00e5ff, 0xb000ff, Math.random()), 26);
        spawnRing(particles, { x: head.x, y: head.y }, 0x00e5ff, headRadiusForLength(p.segments.length) * 2.0);
      }

      render.prevArmor = p.armor;
      render.prevStealth = p.stealth;
    }

    destroyMissingPlayers(state.players);

    for (const d of state.decoys) {
      const render = ensureDecoyRender(d.id);
      syncTargetSegments(render, d.segments);
      render.name = d.name;
      render.color = d.color;
      render.boosting = false;
      render.dna = d.dna;
      render.armor = 0;
      render.stealth = false;
      render.phase = false;
      render.mutations = [];
      render.skillActive = false;
      render.isDecoy = true;
      render.ownerId = d.ownerId;
      render.visualLen = d.originalLen;
      render.prevArmor = 0;
      render.prevStealth = false;
    }

    destroyMissingDecoys(state.decoys);

    // HUD (update at server tick rate)
    const me = myId ? state.players[myId] : undefined;
    const playerCount = Object.keys(state.players).length;
    const myLen = me?.segments.length ?? 0;
    const myScore = me?.score ?? 0;
    const boostOn = me?.boost ?? false;
    const myClass = me?.dna ?? 'shadow';
    const classLabel = myClass === 'iron' ? 'Iron Worm' : myClass === 'shadow' ? 'Shadow Snake' : 'Magnetic Slug';

    let rankLine = '';
    if (myId && me) {
      const sorted = Object.values(state.players)
        .map((p) => ({ id: p.id, score: p.score }))
        .sort((a, b) => b.score - a.score);
      const idx = sorted.findIndex((p) => p.id === myId);
      if (idx >= 0) {
        rankLine = `<div>Rank: ${idx + 1}/${sorted.length}</div>`;
      }
    }

    stats.innerHTML = `<div style="font-weight:800;margin-bottom:6px">mewdle</div>
      <div>Players: ${playerCount}</div>
      <div>Score: ${formatScore(myScore)}</div>
      <div>Class: ${classLabel}</div>
      ${rankLine}
      <div>Boost: ${boostOn ? 'ON' : 'OFF'}</div>`;

    leaderboard.innerHTML = buildLeaderboardHtml(state.leaderboard, myId);

    // Evolution HUD
    if (me && me.evoStage < 3 && me.nextEvoScore > 0) {
      const prev = me.evoStage <= 0 ? 0 : (EVO_THRESHOLDS[me.evoStage - 1] ?? 0);
      const next = me.nextEvoScore;
      const ratio = clamp((myScore - prev) / Math.max(1, next - prev), 0, 1);
      evoFill.style.width = `${ratio * 100}%`;
      evoText.textContent = `${stageLabel(me.evoStage + 1)}까지 ${Math.max(0, next - myScore)}점`;
      evoHud.classList.remove('hidden');
    } else {
      evoHud.classList.add('hidden');
    }

    // Skill button
    const skill = me ? findSkillMutation(me.mutations) : undefined;
    if (me && skill) {
      const totalCd = skillCooldownMs(me.dna, skill) ?? 20000;
      const cd = Math.max(0, me.skillCdMs);
      const progress = clamp(1 - cd / Math.max(1, totalCd), 0, 1);
      const ready = cd <= 0;
      const usable = skill === 'shadow_phantom_decoy' ? progress > 0.01 : ready;

      const accent =
        me.dna === 'iron'
          ? { a: 'rgba(224, 123, 57, 0.9)', soft: 'rgba(224, 123, 57, 0.14)', border: 'rgba(224, 123, 57, 0.32)' }
          : me.dna === 'shadow'
            ? { a: 'rgba(0, 229, 255, 0.9)', soft: 'rgba(0, 229, 255, 0.14)', border: 'rgba(0, 229, 255, 0.32)' }
            : { a: 'rgba(140, 255, 0, 0.9)', soft: 'rgba(140, 255, 0, 0.14)', border: 'rgba(140, 255, 0, 0.32)' };
      skillBtn.style.setProperty('--accent', accent.a);
      skillBtn.style.setProperty('--accent-soft', accent.soft);
      skillBtn.style.setProperty('--accent-border', accent.border);

      skillBtn.style.setProperty('--p', `${progress * 100}%`);
      skillBtn.dataset.ready = ready ? 'true' : 'false';
      skillBtn.dataset.usable = usable ? 'true' : 'false';
      skillBtn.classList.remove('hidden');

      if (ready && !prevSkillReady) {
        if (skillReadyPopTimer) window.clearTimeout(skillReadyPopTimer);
        skillBtn.classList.remove('ready-pop');
        void skillBtn.offsetWidth;
        skillBtn.classList.add('ready-pop');
        skillReadyPopTimer = window.setTimeout(() => skillBtn.classList.remove('ready-pop'), 320);
      }
      prevSkillReady = ready;
    } else {
      skillBtn.classList.add('hidden');
      prevSkillReady = false;
      skillBtn.classList.remove('ready-pop');
      delete skillBtn.dataset.usable;
      if (skillReadyPopTimer) window.clearTimeout(skillReadyPopTimer);
      skillReadyPopTimer = undefined;
    }

    if (me?.segments[0] && myLen > lastLen) {
      const head = me.segments[0];
      const growth = myLen - lastLen;
      spawnBurst(particles, { x: head.x, y: head.y }, me.color, clamp(growth * 4, 6, 26));
      spawnRing(particles, { x: head.x, y: head.y }, me.color, headRadiusForLength(myLen) * (0.9 + clamp(growth, 1, 10) * 0.06));
      shake = Math.min(1, shake + 0.12 + clamp(growth, 1, 12) * 0.01);
    }
    lastLen = myLen;
  }

  let uiPlaying = false;
  let deathFading = false;
  let deathFadeToMenuTimer: number | undefined;
  let deathFadeOverlayTimer: number | undefined;

  function setUiPlaying(playing: boolean): void {
    uiPlaying = playing;
    menu.classList.toggle('hidden', playing);
    hud.classList.toggle('hidden', !playing);

    if (playing) {
      deathFading = false;
      uiRoot.classList.remove('deathfade');
      if (deathFadeToMenuTimer) window.clearTimeout(deathFadeToMenuTimer);
      if (deathFadeOverlayTimer) window.clearTimeout(deathFadeOverlayTimer);
      deathFadeToMenuTimer = undefined;
      deathFadeOverlayTimer = undefined;
    }

    if (!playing) {
      evoHud.classList.add('hidden');
      skillBtn.classList.add('hidden');
      mutationOverlay.classList.add('hidden');
      mutationOpen = false;
      pendingChoices = [];
      uiRoot.classList.remove('gas');
      sixthSense.classList.add('hidden');
      while (sixthSense.firstChild) sixthSense.removeChild(sixthSense.firstChild);
      death.classList.add('hidden');
    }
  }

  let socket: Socket<ServerToClientEvents, ClientToServerEvents> | undefined;
  let targetAngle = 0;
  let boosting = false;
  let inputTimer: number | undefined;
  let lastSentAngle = 0;
  let lastSentBoost = false;
  let lastSentAt = 0;
  let joinName = 'Unknown';
  let joinClass: WormClass = 'shadow';
  let disconnected = false;
  let prevSkillReady = false;
  let skillReadyPopTimer: number | undefined;
  let skillHeld = false;
  let skillHeldByKey = false;
  let skillHoldPointerId: number | undefined;
  let skillAiming = false;
  let skillAimPointerId: number | undefined;
  let skillAimStartX = 0;
  let skillAimStartY = 0;
  let skillAimMoved = false;
  let skillAimTarget: Vec2f | undefined;

  function sendInput(force = false): void {
    if (!socket || !socket.connected) return;

    const now = performance.now();
    const since = now - lastSentAt;
    const angleDiff = Math.abs(normalizeAngle(targetAngle - lastSentAngle));

    if (!force && since < 1000 / 60) return;
    if (!force && angleDiff < 0.004 && boosting === lastSentBoost && since < 140) return;

    socket.emit('input', { angle: targetAngle, boost: boosting });
    lastSentAngle = targetAngle;
    lastSentBoost = boosting;
    lastSentAt = now;
  }

  function hideMutationOverlay(): void {
    mutationOverlay.classList.add('hidden');
    mutationOpen = false;
    pendingChoices = [];
  }

  function chooseMutation(choice: MutationChoice | undefined): void {
    if (!choice) return;
    if (!socket || !socket.connected) return;
    hideMutationOverlay();
    socket.emit('chooseMutation', { id: choice.id });
  }

  function showMutationOffer(offer: MutationOfferPayload): void {
    mutationOpen = true;
    pendingChoices = offer.choices.slice(0, 3);

    mutationStage.textContent = stageLabel(offer.stage);
    mutationCards.replaceChildren();

    for (let i = 0; i < pendingChoices.length; i++) {
      const choice = pendingChoices[i]!;

      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'mutation-card';

      const rarity = document.createElement('div');
      rarity.className = 'rarity';
      rarity.textContent = `${i + 1} • ${choice.rarity.toUpperCase()}`;

      const name = document.createElement('div');
      name.className = 'name';
      name.textContent = choice.name;

      const desc = document.createElement('div');
      desc.className = 'desc';
      desc.textContent = choice.desc;

      btn.appendChild(rarity);
      btn.appendChild(name);
      btn.appendChild(desc);
      btn.addEventListener('click', () => chooseMutation(choice));
      mutationCards.appendChild(btn);
    }

    mutationOverlay.classList.remove('hidden');

    // "Spit out" animation: cards emerge from the player's head position (~1s).
    window.requestAnimationFrame(() => {
      const w = window.innerWidth;
      const h = window.innerHeight;
      let spawnX = w * 0.5;
      let spawnY = h * 0.5;

      const me = myId && latestState ? latestState.players[myId] : undefined;
      const head = me?.segments?.[0];
      if (head) {
        const tmp = new THREE.Vector3(head.x, 0, head.y).project(camera3);
        spawnX = (tmp.x * 0.5 + 0.5) * w;
        spawnY = (-tmp.y * 0.5 + 0.5) * h;
      }

      for (let i = 0; i < mutationCards.children.length; i++) {
        const card = mutationCards.children[i] as HTMLButtonElement;
        const rect = card.getBoundingClientRect();
        const cx = rect.left + rect.width / 2;
        const cy = rect.top + rect.height / 2;
        const dx = spawnX - cx;
        const dy = spawnY - cy;
        card.style.setProperty('--from-x', `${dx}px`);
        card.style.setProperty('--from-y', `${dy}px`);
        card.style.animationDelay = `${i * 70}ms`;
        card.classList.add('spit');
      }
    });
  }

  function getMySkillState():
    | { me: PlayerState; skill: MutationId; cd: number; totalCd: number; progress: number }
    | undefined {
    const me = myId && latestState ? latestState.players[myId] : undefined;
    if (!me) return undefined;
    const skill = findSkillMutation(me.mutations);
    if (!skill) return undefined;
    const totalCd = skillCooldownMs(me.dna, skill) ?? 20000;
    const cd = Math.max(0, me.skillCdMs);
    const progress = clamp(1 - cd / Math.max(1, totalCd), 0, 1);
    return { me, skill, cd, totalCd, progress };
  }

  function emitSkill(action: 'tap' | 'start' | 'end', target?: Vec2f): boolean {
    if (!socket || !socket.connected) return false;
    if (mutationOpen) return false;
    if (target) {
      socket.emit('ability', { type: 'skill', action, x: target.x, y: target.y });
    } else {
      socket.emit('ability', { type: 'skill', action });
    }
    return true;
  }

  function startSkillHold(): void {
    if (skillHeld) return;
    const s = getMySkillState();
    if (!s) return;
    if (s.skill !== 'shadow_phantom_decoy') return;
    if (s.progress <= 0.01) return;
    if (!emitSkill('start')) return;
    skillHeld = true;
  }

  function endSkillHold(): void {
    if (skillHeld) emitSkill('end');
    skillHeld = false;
    skillHeldByKey = false;
    skillHoldPointerId = undefined;
  }

  function tryTapSkill(target?: Vec2f): void {
    const s = getMySkillState();
    if (!s) return;
    if (s.skill === 'shadow_phantom_decoy') return;
    if (s.cd > 0) return;
    emitSkill('tap', target);
  }

  function resetVisualState(): void {
    latestState = undefined;
    lastLen = 0;
    foods = [];
    foodVisuals.clear();
    gas = [];
    decoys = [];
    blackHoles = [];
    prevFoodMap = new Map<string, FoodState>();
    boostSpawnAcc = 0;
    boostRingAcc = 0;
    skillFxAcc = 0;
    skillHeld = false;
    skillHeldByKey = false;
    skillHoldPointerId = undefined;
    skillAiming = false;
    skillAimPointerId = undefined;
    skillAimMoved = false;
    skillAimTarget = undefined;
    particles.length = 0;
    shake = 0;
    camera.x = 0;
    camera.y = 0;
    camera.zoom = 1;
    foodGlowMesh.count = 0;
    foodGlowMesh.instanceMatrix.needsUpdate = true;
    if (foodGlowMesh.instanceColor) foodGlowMesh.instanceColor.needsUpdate = true;
    foodMesh.count = 0;
    foodMesh.instanceMatrix.needsUpdate = true;
    if (foodMesh.instanceColor) foodMesh.instanceColor.needsUpdate = true;
    gasMesh.count = 0;
    gasMesh.instanceMatrix.needsUpdate = true;
    particleGeometry.setDrawRange(0, 0);
    particlePosAttr.needsUpdate = true;
    particleColorAttr.needsUpdate = true;
    particleSizeAttr.needsUpdate = true;
    evoHud.classList.add('hidden');
    skillBtn.classList.add('hidden');
    skillBtn.classList.remove('ready-pop');
    delete skillBtn.dataset.usable;
    prevSkillReady = false;
    if (skillReadyPopTimer) window.clearTimeout(skillReadyPopTimer);
    skillReadyPopTimer = undefined;
    hideMutationOverlay();
    uiRoot.classList.remove('gas');
    sixthSense.classList.add('hidden');
    while (sixthSense.firstChild) sixthSense.removeChild(sixthSense.firstChild);
    prevHeads.clear();
    headVels.clear();
    aimIndicator.visible = false;

    for (const [, render] of playerRenders) {
      disposeRender(render);
    }
    playerRenders.clear();

    for (const [, render] of decoyRenders) {
      disposeRender(render);
    }
    decoyRenders.clear();

    for (const [, render] of blackHoleRenders) {
      disposeBlackHoleRender(render);
    }
    blackHoleRenders.clear();
  }

  function startInputLoop(tickRate: number): void {
    if (!socket) return;
    if (inputTimer) window.clearInterval(inputTimer);
    const tickMs = Math.max(12, Math.round(1000 / Math.max(1, tickRate)));
    lastSentAngle = targetAngle;
    lastSentBoost = boosting;
    lastSentAt = 0;
    inputTimer = window.setInterval(() => {
      if (!socket || !socket.connected) return;
      sendInput();
    }, tickMs);
  }

  function connect(name: string, dna: WormClass): void {
    joinName = name;
    joinClass = dna;

    if (!socket) {
      socket = io();

      socket.on('connect', () => {
        disconnected = false;
        respawnBtn.textContent = '다시하기';
        myId = socket?.id;
        socket?.emit('respawn');
        socket?.emit('join', { name: joinName, dna: joinClass });
      });

    socket.on('welcome', (payload) => {
      serverConfig = payload;
      myId = payload.id;

      // Build background grid once we know the world size.
      const existingGrid = world.getObjectByName('grid');
      if (!existingGrid) {
        const grid = createWorldGrid(payload.world, renderer.capabilities.getMaxAnisotropy());
        grid.name = 'grid';
        world.add(grid);
      }

      startInputLoop(payload.tickRate);
    });

    socket.on('state', (payload) => {
      ingestState(payload);
      // Death UX is handled via a fade-back-to-menu transition.
      // Keep the "death" panel reserved for disconnect/reconnect errors only.
      death.classList.add('hidden');
    });

    socket.on('mutationOffer', (offer) => {
      showMutationOffer(offer);
    });

    socket.on('dead', (payload) => {
      hideMutationOverlay();
      endSkillHold();
      cancelSkillAim();
      uiRoot.classList.remove('gas');
      deathText.textContent = `점수: ${formatScore(payload.score)} (${payload.reason})`;
      try {
        localStorage.setItem(LAST_SCORE_KEY, String(payload.score));
        const best = Math.max(payload.score, readStoredScore(BEST_SCORE_KEY));
        localStorage.setItem(BEST_SCORE_KEY, String(best));
        renderMenuStats();
      } catch {
        // ignore
      }
      death.classList.add('hidden');
      const me = myId ? playerRenders.get(myId) : undefined;
      const head = me?.segs[0] ?? me?.targetSegs[0];
      if (head && me) {
        const isWallCrash = payload.reason.includes('벽') || payload.reason.includes('경계');
        const len = Math.max(me.targetSegs.length, me.segs.length);
        const headR = headRadiusForLength(len);
        spawnBurst(particles, head, me.color, isWallCrash ? 180 : 90);
        spawnRing(particles, head, me.color, headR * (isWallCrash ? 4.2 : 3.0));
        shake = Math.max(shake, isWallCrash ? 1.6 : 1);
      }

      // Fade back to the main menu while keeping the world rendering (spectator state keeps streaming).
      boosting = false;
      sendInput(true);
      deathFading = true;
      uiRoot.classList.add('deathfade');
      if (deathFadeOverlayTimer) window.clearTimeout(deathFadeOverlayTimer);

      // Show the main menu immediately and let it fade in under the overlay.
      setUiPlaying(false);

      deathFadeOverlayTimer = window.setTimeout(() => {
        deathFading = false;
        uiRoot.classList.remove('deathfade');
        deathFadeOverlayTimer = undefined;
      }, 650);
    });

      socket.on('disconnect', () => {
        if (inputTimer) window.clearInterval(inputTimer);
        inputTimer = undefined;
        disconnected = true;
        respawnBtn.textContent = '재접속';
        deathText.textContent = '서버와 연결이 끊어졌습니다.';
        death.classList.toggle('hidden', false);
        resetVisualState();
      });

      socket.on('connect_error', () => {
        disconnected = true;
        respawnBtn.textContent = '재접속';
        deathText.textContent = '서버에 연결할 수 없습니다.';
        death.classList.toggle('hidden', false);
      });
    }

    if (!socket.connected) {
      socket.connect();
      return;
    }

    socket.emit('respawn');
    socket.emit('join', { name: joinName, dna: joinClass });
  }

  function start(): void {
    const name = (nameInput.value ?? '').trim().slice(0, 16);
    const dna = (classSelect.value as WormClass) || 'shadow';
    localStorage.setItem('mewdle_name', name);
    localStorage.setItem('mewdle_class', dna);
    setUiPlaying(true);
    nameInput.blur();
    connect(name.length > 0 ? name : 'Unknown', dna);
  }

  playBtn.addEventListener('click', () => start());
  nameInput.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    start();
  });

  respawnBtn.addEventListener('click', () => {
    if (disconnected || !socket || !socket.connected) {
      const stored = localStorage.getItem('mewdle_name');
      const storedDna = (localStorage.getItem('mewdle_class') as WormClass | null) ?? joinClass;
      connect((stored ?? joinName).trim().slice(0, 16) || 'Unknown', storedDna);
      return;
    }

    respawnBtn.textContent = '다시하기';
    death.classList.toggle('hidden', true);
    hideMutationOverlay();
    uiRoot.classList.remove('gas');
    socket.emit('respawn');
  });

  // Input (3D: raycast to ground plane)
  const raycaster = new THREE.Raycaster();
  const pointerNdc = new THREE.Vector2();
  const groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  const groundHit = new THREE.Vector3();
  const cornerHit = new THREE.Vector3();

  const updateTargetAngle = (clientX: number, clientY: number): void => {
    const rect = renderer.domElement.getBoundingClientRect();
    const x = (clientX - rect.left) / rect.width;
    const y = (clientY - rect.top) / rect.height;
    pointerNdc.x = x * 2 - 1;
    pointerNdc.y = -(y * 2 - 1);
    raycaster.setFromCamera(pointerNdc, camera3);
    if (!raycaster.ray.intersectPlane(groundPlane, groundHit)) return;
    targetAngle = Math.atan2(groundHit.z - camera.y, groundHit.x - camera.x);
  };

  const SKILL_AIM_DRAG_PX = 12;

  const raycastWorld = (clientX: number, clientY: number): Vec2f | undefined => {
    const rect = renderer.domElement.getBoundingClientRect();
    const x = (clientX - rect.left) / rect.width;
    const y = (clientY - rect.top) / rect.height;
    pointerNdc.x = x * 2 - 1;
    pointerNdc.y = -(y * 2 - 1);
    raycaster.setFromCamera(pointerNdc, camera3);
    if (!raycaster.ray.intersectPlane(groundPlane, groundHit)) return undefined;
    return { x: groundHit.x, y: groundHit.z };
  };

  const clampToArena2d = (pos: Vec2f, margin: number): Vec2f => {
    const worldCfg: WorldConfig = latestState?.world ?? serverConfig?.world ?? { width: 16000, height: 16000 };
    const arenaR = Math.max(0, worldCfg.width / 2 - margin);
    const d2 = pos.x * pos.x + pos.y * pos.y;
    if (d2 === 0 || d2 <= arenaR * arenaR) return pos;
    const d = Math.sqrt(d2) || 1;
    const k = arenaR / d;
    return { x: pos.x * k, y: pos.y * k };
  };

  const clampSingularityTarget = (pos: Vec2f): Vec2f => {
    const s = getMySkillState();
    const head = s?.me.segments[0];
    if (!head) return pos;

    let out = pos;
    const dx = out.x - head.x;
    const dy = out.y - head.y;
    const d2 = dx * dx + dy * dy;
    if (d2 > SINGULARITY_MAX_RANGE * SINGULARITY_MAX_RANGE) {
      const d = Math.sqrt(d2) || 1;
      out = { x: head.x + (dx / d) * SINGULARITY_MAX_RANGE, y: head.y + (dy / d) * SINGULARITY_MAX_RANGE };
    }
    out = clampToArena2d(out, SINGULARITY_RADIUS + 40);
    return out;
  };

  const cancelSkillAim = (): void => {
    skillAiming = false;
    skillAimPointerId = undefined;
    skillAimMoved = false;
    skillAimTarget = undefined;
    aimIndicator.visible = false;
  };

  skillBtn.addEventListener('pointerdown', (e: PointerEvent) => {
    if (!menu.classList.contains('hidden')) return;
    if (mutationOpen) return;
    if (e.button !== 0) return;

    const s = getMySkillState();
    if (!s) return;

    if (s.skill === 'shadow_phantom_decoy') {
      if (s.progress <= 0.01) return;
      skillHoldPointerId = e.pointerId;
      startSkillHold();
      try {
        skillBtn.setPointerCapture(e.pointerId);
      } catch {
        // ignore
      }
      e.preventDefault();
      return;
    }

    if (s.skill === 'ultimate_magnetic_magnet') {
      if (s.cd > 0) return;
      skillAiming = true;
      skillAimPointerId = e.pointerId;
      skillAimStartX = e.clientX;
      skillAimStartY = e.clientY;
      skillAimMoved = false;
      skillAimTarget = undefined;
      aimIndicator.visible = false;
      try {
        skillBtn.setPointerCapture(e.pointerId);
      } catch {
        // ignore
      }
      e.preventDefault();
      return;
    }

    if (s.cd > 0) return;
    emitSkill('tap');
    e.preventDefault();
  });

  skillBtn.addEventListener('pointermove', (e: PointerEvent) => {
    if (!skillAiming) return;
    if (skillAimPointerId !== e.pointerId) return;

    const ddx = e.clientX - skillAimStartX;
    const ddy = e.clientY - skillAimStartY;
    if (!skillAimMoved && ddx * ddx + ddy * ddy > SKILL_AIM_DRAG_PX * SKILL_AIM_DRAG_PX) {
      skillAimMoved = true;
    }

    const hit = raycastWorld(e.clientX, e.clientY);
    if (!hit) return;
    skillAimTarget = clampSingularityTarget(hit);

    if (skillAimMoved && skillAimTarget) {
      aimIndicator.visible = true;
      aimIndicator.position.set(skillAimTarget.x, 0.035, skillAimTarget.y);
      aimIndicator.scale.set(SINGULARITY_RADIUS, 1, SINGULARITY_RADIUS);
    } else {
      aimIndicator.visible = false;
    }
  });

  const onSkillPointerUp = (e: PointerEvent): void => {
    if (skillHoldPointerId === e.pointerId) {
      endSkillHold();
      try {
        skillBtn.releasePointerCapture(e.pointerId);
      } catch {
        // ignore
      }
    }

    if (skillAiming && skillAimPointerId === e.pointerId) {
      try {
        skillBtn.releasePointerCapture(e.pointerId);
      } catch {
        // ignore
      }
      const target = skillAimMoved ? skillAimTarget : undefined;
      cancelSkillAim();
      tryTapSkill(target);
    }
  };

  skillBtn.addEventListener('pointerup', onSkillPointerUp);
  skillBtn.addEventListener('pointercancel', (e: PointerEvent) => {
    if (skillHoldPointerId === e.pointerId) endSkillHold();
    if (skillAiming && skillAimPointerId === e.pointerId) cancelSkillAim();
  });

  renderer.domElement.addEventListener('pointermove', (e: PointerEvent) => {
    if (!menu.classList.contains('hidden')) return;
    updateTargetAngle(e.clientX, e.clientY);
    sendInput();
  });

  // Global steering fallback (some right-click / pointer-capture paths can stop canvas pointermove from firing).
  window.addEventListener('pointermove', (e: PointerEvent) => {
    if (!menu.classList.contains('hidden')) return;
    updateTargetAngle(e.clientX, e.clientY);
    sendInput();
  });

  // Prevent the browser context menu when using right-click for skills.
  renderer.domElement.addEventListener('contextmenu', (e) => {
    e.preventDefault();
  });

  const resize = (): void => {
    const w = window.innerWidth;
    const h = window.innerHeight;
    renderer.setPixelRatio(Math.min(window.devicePixelRatio ?? 1, 2));
    renderer.setSize(w, h);
    camera3.aspect = w / h;
    camera3.updateProjectionMatrix();
  };
  window.addEventListener('resize', resize);

  window.addEventListener('keydown', (e) => {
    if (!mutationOverlay.classList.contains('hidden')) {
      if (e.code === 'Digit1') {
        chooseMutation(pendingChoices[0]);
        e.preventDefault();
        return;
      } else if (e.code === 'Digit2') {
        chooseMutation(pendingChoices[1]);
        e.preventDefault();
        return;
      } else if (e.code === 'Digit3') {
        chooseMutation(pendingChoices[2]);
        e.preventDefault();
        return;
      }
    }

    if (e.code !== 'Space') return;
    if (!menu.classList.contains('hidden')) return;
    boosting = true;
    sendInput(true);
    e.preventDefault();
  });

  window.addEventListener('keydown', (e) => {
    if (e.code !== 'KeyE') return;
    if (!menu.classList.contains('hidden')) return;
    if (e.repeat) return;
    const s = getMySkillState();
    if (!s) return;
    if (s.skill === 'shadow_phantom_decoy') {
      if (s.progress <= 0.01) return;
      skillHeldByKey = true;
      startSkillHold();
    } else {
      tryTapSkill();
    }
    e.preventDefault();
  });

  window.addEventListener('keyup', (e) => {
    if (e.code !== 'KeyE') return;
    if (skillHeldByKey) endSkillHold();
  });

  window.addEventListener('keyup', (e) => {
    if (e.code !== 'Space') return;
    boosting = false;
    sendInput(true);
  });

  // Mouse-event fallback for right-click skills on browsers/environments where pointer events are unreliable.
  const MOUSE_FALLBACK_POINTER_ID = -1;
  const RIGHT_CLICK_FALLBACK_MS = 80;
  let lastPointerRightDownAt = 0;
  let lastPointerRightUpAt = 0;

  window.addEventListener('pointerdown', (e) => {
    if (!menu.classList.contains('hidden')) return;

    const rightDown = e.button === 2 || (e.buttons & 2) === 2;
    if (rightDown) {
      lastPointerRightDownAt = performance.now();
      e.preventDefault();
      if (mutationOpen) return;
      const s = getMySkillState();
      if (!s) return;

      if (s.skill === 'shadow_phantom_decoy') {
        if (s.progress <= 0.01) return;
        skillHoldPointerId = e.pointerId;
        startSkillHold();
        e.preventDefault();
        return;
      }

      if (s.skill === 'ultimate_magnetic_magnet') {
        if (s.cd > 0) return;
        skillAiming = true;
        skillAimPointerId = e.pointerId;
        skillAimStartX = e.clientX;
        skillAimStartY = e.clientY;
        skillAimMoved = false;
        skillAimTarget = undefined;

        const hit = raycastWorld(e.clientX, e.clientY);
        if (hit) {
          skillAimTarget = clampSingularityTarget(hit);
          skillAimMoved = true; // right-click uses point & click (and drag) targeting
        }

        if (skillAimMoved && skillAimTarget) {
          aimIndicator.visible = true;
          aimIndicator.position.set(skillAimTarget.x, 0.035, skillAimTarget.y);
          aimIndicator.scale.set(SINGULARITY_RADIUS, 1, SINGULARITY_RADIUS);
        } else {
          aimIndicator.visible = false;
        }

        e.preventDefault();
        return;
      }

      tryTapSkill();
      e.preventDefault();
      return;
    }

    if (e.button === 0) {
      if (e.target !== renderer.domElement) return;
      boosting = true;
      sendInput(true);
      return;
    }
  });

  window.addEventListener('pointerup', (e) => {
    if (e.button === 0) {
      boosting = false;
      sendInput(true);
      return;
    }

    if (e.button === 2) {
      lastPointerRightUpAt = performance.now();
      if (skillHoldPointerId === e.pointerId) {
        endSkillHold();
      }
      if (skillAiming && skillAimPointerId === e.pointerId) {
        const target = skillAimTarget;
        cancelSkillAim();
        tryTapSkill(target);
      }
    }
  });

  window.addEventListener('pointermove', (e: PointerEvent) => {
    if (!menu.classList.contains('hidden')) return;
    if (!skillAiming) return;
    if (skillAimPointerId !== e.pointerId) return;

    const ddx = e.clientX - skillAimStartX;
    const ddy = e.clientY - skillAimStartY;
    if (!skillAimMoved && ddx * ddx + ddy * ddy > SKILL_AIM_DRAG_PX * SKILL_AIM_DRAG_PX) {
      skillAimMoved = true;
    }

    const hit = raycastWorld(e.clientX, e.clientY);
    if (!hit) return;
    skillAimTarget = clampSingularityTarget(hit);

    if (skillAimMoved && skillAimTarget) {
      aimIndicator.visible = true;
      aimIndicator.position.set(skillAimTarget.x, 0.035, skillAimTarget.y);
      aimIndicator.scale.set(SINGULARITY_RADIUS, 1, SINGULARITY_RADIUS);
    } else {
      aimIndicator.visible = false;
    }
  });

  window.addEventListener('mousedown', (e: MouseEvent) => {
    if (e.button !== 2) return;
    if (!menu.classList.contains('hidden')) return;
    if (performance.now() - lastPointerRightDownAt < RIGHT_CLICK_FALLBACK_MS) return;
    e.preventDefault();
    if (mutationOpen) return;

    const s = getMySkillState();
    if (!s) return;

    if (s.skill === 'shadow_phantom_decoy') {
      if (s.progress <= 0.01) return;
      skillHoldPointerId = MOUSE_FALLBACK_POINTER_ID;
      startSkillHold();
      e.preventDefault();
      return;
    }

    if (s.skill === 'ultimate_magnetic_magnet') {
      if (s.cd > 0) return;
      skillAiming = true;
      skillAimPointerId = MOUSE_FALLBACK_POINTER_ID;
      skillAimStartX = e.clientX;
      skillAimStartY = e.clientY;
      skillAimMoved = false;
      skillAimTarget = undefined;

      const hit = raycastWorld(e.clientX, e.clientY);
      if (hit) {
        skillAimTarget = clampSingularityTarget(hit);
        skillAimMoved = true;
      }

      if (skillAimMoved && skillAimTarget) {
        aimIndicator.visible = true;
        aimIndicator.position.set(skillAimTarget.x, 0.035, skillAimTarget.y);
        aimIndicator.scale.set(SINGULARITY_RADIUS, 1, SINGULARITY_RADIUS);
      } else {
        aimIndicator.visible = false;
      }

      e.preventDefault();
      return;
    }

    tryTapSkill();
    e.preventDefault();
  });

  window.addEventListener('mouseup', (e: MouseEvent) => {
    if (e.button !== 2) return;
    if (performance.now() - lastPointerRightUpAt < RIGHT_CLICK_FALLBACK_MS) return;

    if (skillHoldPointerId !== undefined) {
      endSkillHold();
    }
    if (skillAiming) {
      const target = skillAimTarget;
      cancelSkillAim();
      tryTapSkill(target);
    }
  });

  window.addEventListener('mousemove', (e: MouseEvent) => {
    if (!menu.classList.contains('hidden')) return;
    if (!skillAiming) return;
    if (skillAimPointerId !== MOUSE_FALLBACK_POINTER_ID) return;

    const ddx = e.clientX - skillAimStartX;
    const ddy = e.clientY - skillAimStartY;
    if (!skillAimMoved && ddx * ddx + ddy * ddy > SKILL_AIM_DRAG_PX * SKILL_AIM_DRAG_PX) {
      skillAimMoved = true;
    }

    const hit = raycastWorld(e.clientX, e.clientY);
    if (!hit) return;
    skillAimTarget = clampSingularityTarget(hit);

    if (skillAimMoved && skillAimTarget) {
      aimIndicator.visible = true;
      aimIndicator.position.set(skillAimTarget.x, 0.035, skillAimTarget.y);
      aimIndicator.scale.set(SINGULARITY_RADIUS, 1, SINGULARITY_RADIUS);
    } else {
      aimIndicator.visible = false;
    }
  });

  // Block the browser context menu during gameplay (right-click is used for skills).
  window.addEventListener('contextmenu', (e) => {
    if (!menu.classList.contains('hidden')) return;
    e.preventDefault();
  });

  window.addEventListener('blur', () => {
    boosting = false;
    sendInput(true);
    endSkillHold();
    cancelSkillAim();
  });

  // Render loop (rAF): smooth positions + 3D update.
  const camOffset = new THREE.Vector3(-900, 1150, 900);
  const camPos = new THREE.Vector3();
  const camTarget = new THREE.Vector3();
  const camForward = new THREE.Vector3();
  const camUp = new THREE.Vector3();
  const camRollQuat = new THREE.Quaternion();
  let cameraBank = 0;
  let meHeading = 0;
  let meHeadingValid = false;
  let lastFrame = performance.now();

  const tick = (): void => {
    const now = performance.now();
    const dt = Math.min(0.05, (now - lastFrame) / 1000);
    lastFrame = now;
    const t = now / 1000;

    const screenW = window.innerWidth;
    const screenH = window.innerHeight;
    const inMenu = !menu.classList.contains('hidden');

    const meRender = myId ? playerRenders.get(myId) : undefined;
    const meHead = meRender?.segs[0];
    const meState = myId && latestState ? latestState.players[myId] : undefined;
    const meTargetHead = meState?.segments[0];
    const myLen = meState?.segments.length ?? 0;
    const myDna = meState?.dna;
    const meSkill = meState ? findSkillMutation(meState.mutations) : undefined;
    const meSkillActive = meState?.skillActive ?? false;
    const eagleStacks = countMutation(meState?.mutations, 'eagle_eye');
    const fovMul = 1 + 0.15 * clamp(eagleStacks, 0, 3);
    const meBoostingVisual = boosting && myLen > MIN_SEGMENTS;

    if (meHead || meTargetHead) {
      const hx = meTargetHead?.x ?? meHead?.x ?? 0;
      const hy = meTargetHead?.y ?? meHead?.y ?? 0;
      const fovCapScale = myDna === 'magnetic' ? 1 / 1.2 : 1;
      const minZoom = Math.max((CAMERA_BASE_MIN_ZOOM * fovCapScale) / fovMul, CAMERA_ABS_MIN_ZOOM * fovCapScale);
      const baseZoom = clamp((1.38 - myLen / 210) / fovMul, minZoom, 1.32);
      const targetZoom = baseZoom * (meBoostingVisual ? 0.96 : 1);

      const camK = 14;
      const zK = 11;
      const a = smoothFactor(camK, dt);
      const za = smoothFactor(zK, dt);
      camera.x = lerp(camera.x, hx, a);
      camera.y = lerp(camera.y, hy, a);
      camera.zoom = lerp(camera.zoom, targetZoom, za);
    } else if (inMenu) {
      // Menu feels better with a tighter default camera, even before joining.
      const menuZoom = 1.28;
      camera.zoom = lerp(camera.zoom, menuZoom, smoothFactor(6, dt));
    }

    const zoom = camera.zoom;

    shake = Math.max(0, shake - dt * 2.3);
    const shakeAmp = shake * 10;
    const shakeX = Math.sin(t * 47.2) * shakeAmp;
    const shakeZ = Math.cos(t * 53.9) * shakeAmp;

    // Camera banking (roll) based on actual turn rate (derived from head/neck).
    let cameraBankTarget = 0;
    const h0 = meState?.segments[0];
    const h1 = meState?.segments[1];
    if (menu.classList.contains('hidden') && h0 && h1) {
      const dx = h0.x - h1.x;
      const dy = h0.y - h1.y;
      const d2 = dx * dx + dy * dy;
      if (d2 > 0.001) {
        const headingNow = Math.atan2(dy, dx);
        const prev = meHeadingValid ? meHeading : headingNow;
        const dHeading = normalizeAngle(headingNow - prev);
        meHeading = headingNow;
        meHeadingValid = true;

        const safeDt = Math.max(dt, 1 / 120);
        const turnRate = dHeading / safeDt;
        const classMul = myDna === 'shadow' ? 1.1 : myDna === 'iron' ? 0.92 : 1;
        const maxBank = CAMERA_BANK_MAX * classMul;
        cameraBankTarget = clamp(-turnRate / CAMERA_BANK_TURN_RATE_FOR_MAX, -1, 1) * maxBank;
      } else {
        meHeadingValid = false;
      }
    } else {
      meHeadingValid = false;
    }
    cameraBank = lerp(cameraBank, cameraBankTarget, smoothFactor(CAMERA_BANK_K, dt));

    camera3.zoom = zoom;
    camPos.set(camera.x + camOffset.x + shakeX, camOffset.y, camera.y + camOffset.z + shakeZ);
    camTarget.set(camera.x + shakeX * 0.1, 0, camera.y + shakeZ * 0.1);
    camForward.subVectors(camTarget, camPos);
    if (camForward.lengthSq() > 0.000001) camForward.normalize();
    else camForward.set(0, -1, 0);
    camRollQuat.setFromAxisAngle(camForward, cameraBank);
    camUp.copy(up).applyQuaternion(camRollQuat);
    camera3.up.copy(camUp);
    camera3.position.copy(camPos);
    camera3.lookAt(camTarget);
    camera3.updateProjectionMatrix();

    // View bounds (perspective): raycast screen corners onto the ground plane.
    let minX = Number.POSITIVE_INFINITY;
    let maxX = Number.NEGATIVE_INFINITY;
    let minY = Number.POSITIVE_INFINITY;
    let maxY = Number.NEGATIVE_INFINITY;

    const cornerNdc: Array<[number, number]> = [
      [-1, -1],
      [1, -1],
      [-1, 1],
      [1, 1],
    ];

    for (const [nx, ny] of cornerNdc) {
      pointerNdc.set(nx, ny);
      raycaster.setFromCamera(pointerNdc, camera3);
      if (!raycaster.ray.intersectPlane(groundPlane, cornerHit)) continue;
      minX = Math.min(minX, cornerHit.x);
      maxX = Math.max(maxX, cornerHit.x);
      minY = Math.min(minY, cornerHit.z);
      maxY = Math.max(maxY, cornerHit.z);
    }

    if (!Number.isFinite(minX) || !Number.isFinite(maxX) || !Number.isFinite(minY) || !Number.isFinite(maxY)) {
      const viewHalfW = screenW / 2 / zoom;
      const viewHalfH = screenH / 2 / zoom;
      minX = camera.x - viewHalfW;
      maxX = camera.x + viewHalfW;
      minY = camera.y - viewHalfH;
      maxY = camera.y + viewHalfH;
    }

    const view = { minX, maxX, minY, maxY };

    // Sixth Sense: edge warning for off-screen fast approaches.
    const hasSixthSense = countMutation(meState?.mutations, 'sixth_sense') > 0;
    const meSenseHead = meTargetHead ?? meHead;
    if (latestState && myId && hasSixthSense && meSenseHead) {
      const horizonSec = 3.2;
      const maxDist = 5200;
      const margin = 28;
      const threats: Array<{ x: number; y: number; urgency: number }> = [];

      for (const id in latestState.players) {
        if (id === myId) continue;
        const p = latestState.players[id]!;
        const head = p.segments[0];
        if (!head) continue;
        const vel = headVels.get(id);
        if (!vel) continue;

        const dx = meSenseHead.x - head.x;
        const dy = meSenseHead.y - head.y;
        const dist = Math.hypot(dx, dy);
        if (dist <= 1 || dist > maxDist) continue;

        const speed = Math.hypot(vel.vx, vel.vy);
        if (!p.boost && speed < 200) continue;

        const approach = (vel.vx * dx + vel.vy * dy) / dist;
        if (approach <= 0) continue;
        const tti = dist / approach;
        if (tti > horizonSec) continue;

        sixthSenseTmp.set(head.x, 0, head.y).project(camera3);
        if (Math.abs(sixthSenseTmp.x) <= 1 && Math.abs(sixthSenseTmp.y) <= 1) continue;

        const sx = (sixthSenseTmp.x * 0.5 + 0.5) * screenW;
        const sy = (-sixthSenseTmp.y * 0.5 + 0.5) * screenH;
        threats.push({
          x: clamp(sx, margin, screenW - margin),
          y: clamp(sy, margin, screenH - margin),
          urgency: clamp(1 - tti / horizonSec, 0, 1),
        });
      }

      threats.sort((a, b) => b.urgency - a.urgency);
      const count = Math.min(4, threats.length);
      if (count === 0) {
        sixthSense.classList.add('hidden');
        while (sixthSense.firstChild) sixthSense.removeChild(sixthSense.firstChild);
      } else {
        sixthSense.classList.remove('hidden');
        while (sixthSense.children.length < count) {
          const el = document.createElement('div');
          el.className = 'ping';
          el.textContent = '!';
          sixthSense.appendChild(el);
        }
        while (sixthSense.children.length > count) {
          sixthSense.removeChild(sixthSense.lastChild!);
        }
        for (let i = 0; i < count; i++) {
          const el = sixthSense.children[i] as HTMLDivElement;
          const threat = threats[i]!;
          el.style.left = `${threat.x}px`;
          el.style.top = `${threat.y}px`;
          el.style.setProperty('--a', String(clamp(0.35 + threat.urgency * 0.65, 0.35, 1)));
          el.style.setProperty('--i', String(i));
        }
      }
    } else {
      sixthSense.classList.add('hidden');
      while (sixthSense.firstChild) sixthSense.removeChild(sixthSense.firstChild);
    }

    // Lobby 3D preview pose: keep it framed on the left while the menu panel sits on the right.
    if (inMenu && lobbyPreviewRender) {
      const viewW = view.maxX - view.minX;
      const viewH = view.maxY - view.minY;
      let cx = (view.minX + view.maxX) * 0.5 - viewW * 0.16;
      let cy = (view.minY + view.maxY) * 0.5 + viewH * 0.11;

      // Anchor the preview roughly at 2/5 of the screen width (and slightly below center) so it sits inside the left showcase.
      const anchor = raycastWorld(screenW * 0.4, screenH * 0.56);
      if (anchor) {
        cx = anchor.x;
        cy = anchor.y;
      }

      const seed = lobbyPreviewRender.skinOffset;
      const turns = lobbyClass === 'iron' ? 1.15 : lobbyClass === 'shadow' ? 1.35 : 1.25;
      const outerR = lobbyClass === 'iron' ? 340 : lobbyClass === 'shadow' ? 300 : 320;
      const innerR = lobbyClass === 'iron' ? 110 : lobbyClass === 'shadow' ? 90 : 120;
      const spin = -t * (lobbyClass === 'iron' ? 0.12 : lobbyClass === 'shadow' ? 0.18 : 0.16);
      const wiggle = lobbyClass === 'iron' ? 0.04 : lobbyClass === 'shadow' ? 0.085 : 0.07;

      for (let i = 0; i < lobbyPreviewPose.length; i++) {
        const f = lobbyPreviewPose.length <= 1 ? 0 : i / (lobbyPreviewPose.length - 1);
        const r = lerp(outerR, innerR, f) * (1 + Math.sin(t * 1.05 + f * 7.0 + seed * 6.0) * 0.03);
        const a = spin + f * turns * Math.PI * 2 + Math.sin(t * 0.8 + f * 6.2 + seed * 10.0) * wiggle;
        lobbyPreviewPose[i]!.x = cx + Math.cos(a) * r;
        lobbyPreviewPose[i]!.y = cy + Math.sin(a) * r;
      }
      syncTargetSegments(lobbyPreviewRender, lobbyPreviewPose);
    }

    // Smooth players
    const headAlpha = smoothFactor(48, dt);
    const bodyAlpha = smoothFactor(24, dt);
    const relaxAlpha = smoothFactor(12, dt) * 0.18;

    for (const [id, render] of playerRenders) {
      render.spawnFx = Math.max(0, render.spawnFx - dt * 1.4);
      render.eatFx = Math.max(0, render.eatFx - dt * 4);

      if (render.segs.length > 0) {
        const tail = render.segs[render.segs.length - 1]!;
        if (!render.tailTip) {
          render.tailTip = { x: tail.x, y: tail.y };
        } else {
          const dx = render.tailTip.x - tail.x;
          const dy = render.tailTip.y - tail.y;
          if (dx * dx + dy * dy > 900 * 900) {
            render.tailTip.x = tail.x;
            render.tailTip.y = tail.y;
          } else {
            const a = smoothFactor(6, dt); // ~0.5s to settle
            render.tailTip.x = lerp(render.tailTip.x, tail.x, a);
            render.tailTip.y = lerp(render.tailTip.y, tail.y, a);
          }
        }
      }

      if (render.targetSegs.length > 0) {
        if (render.visualLen <= 0) {
          render.visualLen = render.targetSegs.length;
        } else {
          render.visualLen = lerp(render.visualLen, render.targetSegs.length, smoothFactor(6, dt));
        }
      }

      const len = render.segs.length;
      for (let i = 0; i < render.segs.length; i++) {
        const cur = render.segs[i]!;
        const target = render.targetSegs[i];
        if (!target) continue;

        if (i === 0) {
          const a = id === myId ? headAlpha : headAlpha * 0.92;
          cur.x = lerp(cur.x, target.x, a);
          cur.y = lerp(cur.y, target.y, a);
          continue;
        }

        const f = len <= 1 ? 1 : i / (len - 1);
        const aBase = bodyAlpha * (0.92 - f * 0.28);
        const a = id === myId ? aBase : aBase * 0.92;
        cur.x = lerp(cur.x, target.x, a);
        cur.y = lerp(cur.y, target.y, a);
      }

      // Light curvature relaxation so the body feels "soft" like slither.io.
      if (render.segs.length > 2) {
        for (let i = 1; i < render.segs.length - 1; i++) {
          const prev = render.segs[i - 1]!;
          const next = render.segs[i + 1]!;
          const cur = render.segs[i]!;
          cur.x = lerp(cur.x, (prev.x + next.x) * 0.5, relaxAlpha);
          cur.y = lerp(cur.y, (prev.y + next.y) * 0.5, relaxAlpha);
        }
      }
    }

    for (const [, render] of decoyRenders) {
      render.spawnFx = Math.max(0, render.spawnFx - dt * 1.8);
      render.eatFx = Math.max(0, render.eatFx - dt * 4);

      if (render.segs.length > 0) {
        const tail = render.segs[render.segs.length - 1]!;
        if (!render.tailTip) {
          render.tailTip = { x: tail.x, y: tail.y };
        } else {
          const dx = render.tailTip.x - tail.x;
          const dy = render.tailTip.y - tail.y;
          if (dx * dx + dy * dy > 900 * 900) {
            render.tailTip.x = tail.x;
            render.tailTip.y = tail.y;
          } else {
            const a = smoothFactor(6, dt);
            render.tailTip.x = lerp(render.tailTip.x, tail.x, a);
            render.tailTip.y = lerp(render.tailTip.y, tail.y, a);
          }
        }
      }

      const len = render.segs.length;
      for (let i = 0; i < render.segs.length; i++) {
        const cur = render.segs[i]!;
        const target = render.targetSegs[i];
        if (!target) continue;

        if (i === 0) {
          const a = headAlpha * 0.88;
          cur.x = lerp(cur.x, target.x, a);
          cur.y = lerp(cur.y, target.y, a);
          continue;
        }

        const f = len <= 1 ? 1 : i / (len - 1);
        const a = bodyAlpha * (0.9 - f * 0.26);
        cur.x = lerp(cur.x, target.x, a);
        cur.y = lerp(cur.y, target.y, a);
      }

      if (render.segs.length > 2) {
        for (let i = 1; i < render.segs.length - 1; i++) {
          const prev = render.segs[i - 1]!;
          const next = render.segs[i + 1]!;
          const cur = render.segs[i]!;
          cur.x = lerp(cur.x, (prev.x + next.x) * 0.5, relaxAlpha);
          cur.y = lerp(cur.y, (prev.y + next.y) * 0.5, relaxAlpha);
        }
      }
    }

    // Foods (culled)
    let foodCount = 0;
    const foodMargin = 720;
    const foodPosA = smoothFactor(20, dt);
    const foodPosSuckA = smoothFactor(46, dt);
    const foodFadeInA = smoothFactor(22, dt);
    const foodFadeOutA = smoothFactor(12, dt);
    const foodFadeSuckA = smoothFactor(18, dt);
    for (const [id, f] of foodVisuals) {
      // Smooth food positions & presence to avoid "stream pop" flicker.
      if (f.present) f.sucked = false;
      const posA = f.sucked ? foodPosSuckA : foodPosA;
      const fadeA = f.present ? foodFadeInA : f.sucked ? foodFadeSuckA : foodFadeOutA;
      f.x = lerp(f.x, f.tx, posA);
      f.y = lerp(f.y, f.ty, posA);
      f.r = lerp(f.r, f.tr, posA);
      f.alpha = lerp(f.alpha, f.present ? 1 : 0, fadeA);
      if (!f.present && f.alpha <= 0.02) {
        foodVisuals.delete(id);
        continue;
      }

      if (foodCount >= FOOD_MAX_INST) continue;
      if (!isInsideView(f.x, f.y, view, foodMargin)) continue;

      const phase = foodPhase(f.id);
      // Slow, smooth "breathing" glow (avoid fast flicker).
      const pulse = 0.985 + 0.015 * Math.sin(t * 0.55 + phase * 0.85);
      const shimmer = 0.5 + 0.5 * Math.sin(t * 0.75 + phase * 0.35);
      const fadeSize = 0.6 + 0.4 * f.alpha;

      let renderX = f.x;
      let renderY = f.y;
      let swallowE = 0;
      if (f.sucked) {
        const dx = f.tx - f.x;
        const dy = f.ty - f.y;
        const dist = Math.hypot(dx, dy);
        const swallow = clamp(1 - dist / 220, 0, 1);
        swallowE = 1 - Math.pow(1 - swallow, 3);

        const inv = dist > 0.001 ? 1 / dist : 0;
        const ux = dist > 0.001 ? dx * inv : 1;
        const uy = dist > 0.001 ? dy * inv : 0;
        const sx = -uy;
        const sy = ux;
        const swirlAmp = (1 - swallowE) * Math.min(22, dist * 0.18);
        const swirl = Math.sin(t * 13.0 + phase * 1.7) * swirlAmp;
        renderX += sx * swirl;
        renderY += sy * swirl;
      }

      const coreR = f.r * (0.84 + f.value * 0.05) * pulse * fadeSize;
      const glowMul = f.sucked ? 1 - swallowE * 0.85 : 1;
      const glowPulse = 0.97 + 0.03 * Math.sin(t * 0.45 + phase * 0.6);
      const glowR =
        f.r * (2.05 + f.value * 0.38) * glowPulse * (0.45 + 0.55 * f.alpha) * glowMul;

      const liftMax = f.suckLift > 0 ? f.suckLift : 26;
      const coreLift = f.sucked ? swallowE * liftMax : 0;
      const glowLift = coreLift * 0.18;

      const coreColor = shade(mixColor(f.color, 0xffffff, 0.22), (0.38 + 0.62 * f.alpha) * (0.95 + shimmer * 0.08));
      const glowColor = shade(
        mixColor(f.color, 0xffffff, 0.72),
        (0.22 + 0.78 * f.alpha) * (0.82 + shimmer * 0.22) * (f.sucked ? 1 - swallowE * 0.85 : 1),
      );

      // Glow (ground disc)
      tmpObj.position.set(renderX, 0.28 + f.r * 0.04 + glowLift, renderY);
      tmpObj.quaternion.identity();
      tmpObj.scale.set(glowR, glowR, glowR);
      tmpObj.updateMatrix();
      foodGlowMesh.setMatrixAt(foodCount, tmpObj.matrix);
      tmpColor.setHex(glowColor);
      foodGlowMesh.setColorAt(foodCount, tmpColor);

      // Core (sphere)
      tmpObj.position.set(renderX, Math.max(1, coreR * 0.98) + coreLift, renderY);
      tmpObj.quaternion.identity();
      tmpObj.scale.set(coreR, coreR, coreR);
      tmpObj.updateMatrix();
      foodMesh.setMatrixAt(foodCount, tmpObj.matrix);
      tmpColor.setHex(coreColor);
      foodMesh.setColorAt(foodCount, tmpColor);

      foodCount++;
    }
    foodGlowMesh.count = foodCount;
    foodGlowMesh.instanceMatrix.needsUpdate = true;
    if (foodGlowMesh.instanceColor) foodGlowMesh.instanceColor.needsUpdate = true;
    foodMesh.count = foodCount;
    foodMesh.instanceMatrix.needsUpdate = true;
    if (foodMesh.instanceColor) foodMesh.instanceColor.needsUpdate = true;

    // Gas (culled)
    let gasCount = 0;
    const gasMargin = 620;
    const gasPos = meRender?.segs[0] ?? meTargetHead;
    let insideGas = false;
    for (const g of gas) {
      if (gasCount >= GAS_MAX_INST) break;
      if (!isInsideView(g.x, g.y, view, g.r + gasMargin)) continue;

      tmpObj.position.set(g.x, Math.max(1, g.r * 0.12), g.y);
      tmpObj.scale.set(g.r, g.r * 0.35, g.r);
      tmpObj.updateMatrix();
      gasMesh.setMatrixAt(gasCount, tmpObj.matrix);
      gasCount++;

      if (gasPos) {
        const dx = gasPos.x - g.x;
        const dy = gasPos.y - g.y;
        if (dx * dx + dy * dy <= g.r * g.r) insideGas = true;
      }
    }
    gasMesh.count = gasCount;
    gasMesh.instanceMatrix.needsUpdate = true;

    if (!menu.classList.contains('hidden')) {
      uiRoot.classList.remove('gas');
    } else {
      uiRoot.classList.toggle('gas', insideGas);
    }

    // Players (culled) - check segments so long tails don't become "invisible walls".
    const playerShowMargin = 1200;
    const playerHideMargin = 1700;
    for (const [id, render] of playerRenders) {
      const segsForCull = render.targetSegs.length > 0 ? render.targetSegs : render.segs;
      if (segsForCull.length === 0) continue;

      if (id === LOBBY_PREVIEW_ID) {
        render.group.visible = inMenu;
        if (!render.group.visible) continue;
      } else {
        const margin = render.group.visible ? playerHideMargin : playerShowMargin;
        const visible = id === myId || isAnySegmentInsideView(segsForCull, view, margin);
        render.group.visible = visible;
        if (!visible) continue;
      }

      const head = render.segs[0] ?? render.targetSegs[0];
      if (!head) continue;

      const boostingVisual = id === myId ? meBoostingVisual : render.boosting;
      const stealthVisual = id === myId ? false : render.stealth;
      const phaseVisual = id === myId ? false : render.phase;
      const skill = findSkillMutation(render.mutations);

      if (id !== LOBBY_PREVIEW_ID) {
        setNameSprite(render, render.name);
      } else {
        render.nameSprite.visible = false;
      }
      applyClassVisual(render);

      const length = Math.max(1, render.visualLen || render.segs.length);
      const siege = render.skillActive && skill === 'ultimate_iron_charge';
      const singularity = render.skillActive && skill === 'ultimate_magnetic_magnet';

      const sizeMul = siege ? 1.5 : 1;
      const bodyMul = render.dna === 'shadow' ? 0.78 : render.dna === 'iron' ? 1.06 : 1.18;
      const headMul = render.dna === 'shadow' ? 0.92 : render.dna === 'iron' ? 1.02 : 1.12;
      const bodyBase = bodyRadiusForLength(length) * bodyMul * sizeMul;
      const headBase = headRadiusForLength(length) * headMul * sizeMul;

      const palette = render.skinPalette.length > 0 ? render.skinPalette : [render.color];
      const stripe = Math.max(1, render.skinStripe);

      const ironSteel = palette[0] ?? 0xf0f4f8;
      const ironJoint = palette[2] ?? 0x2b303b;
      const ironAccent = palette[4] ?? 0xffd700;

      const mageBase = palette[0] ?? 0x191970;
      const mageNebula = palette[2] ?? 0xff007f;
      const mageStar = palette[4] ?? 0xe0ffff;

      const shadowNeonA = palette[3] ?? 0x00e5ff;
      const shadowNeonB = palette[5] ?? 0xb000ff;
      const shadowNeon = mixColor(
        shadowNeonA,
        shadowNeonB,
        0.5 + 0.5 * Math.sin(t * 1.7 + length * 0.04 + render.skinOffset * 8.0),
      );

      let visMul = phaseVisual ? 0.18 : stealthVisual ? 0.28 : 1;
      const baseAlphaMul = render.dna === 'shadow' ? 0.8 : render.dna === 'magnetic' ? 0.96 : 1;
      const spawnAlpha = clamp(1 - render.spawnFx * 0.45, 0.35, 1);
      const opacity = clamp((boostingVisual ? 0.985 : 0.96) * baseAlphaMul * visMul * spawnAlpha, 0, 1);
      const bodyOpacity = render.dna === 'shadow' ? opacity * 0.78 : opacity;

      if (render.dna === 'iron') {
        render.material.metalness = 0.92;
        render.material.roughness = 0.42;
      } else if (render.dna === 'shadow') {
        render.material.metalness = 0.05;
        render.material.roughness = 0.38;
      } else {
        render.material.metalness = 0.0;
        render.material.roughness = 0.2;
      }

      render.material.opacity = bodyOpacity;
      if (render.dna === 'shadow') {
        render.material.transparent = true;
        render.material.depthWrite = false;
        render.material.emissive.setHex(shadowNeon);
        render.material.emissiveIntensity = clamp(
          (boostingVisual ? 0.42 : 0.28) * visMul * spawnAlpha + (render.skillActive ? 0.12 : 0),
          0,
          1.0,
        );
      } else {
        render.material.transparent = opacity < 1;
        render.material.depthWrite = opacity >= 1;
        const baseGlow = render.dna === 'iron' ? 0.035 : 0.055;
        render.material.emissive.setHex(0xffffff);
        render.material.emissiveIntensity = clamp(baseGlow * spawnAlpha + (boostingVisual ? 0.02 : 0), 0, 0.12);
      }

      if (render.dna === 'iron') {
        const primary = render.headMaterials[0];
        const accent = render.headMaterials[1];
        if (primary) {
          primary.color.setHex(ironSteel);
          primary.metalness = 0.8;
          primary.roughness = 0.42;
        }
        if (accent) {
          accent.color.setHex(siege ? 0xff3b2f : ironAccent);
          accent.metalness = 0.75;
          accent.roughness = 0.38;
        }
      } else if (render.dna === 'shadow') {
        const outer = render.headMaterials[0];
        const inner = render.headMaterials[1];
        if (outer) {
          outer.color.setHex(0x0b0d12);
          outer.metalness = 0.0;
          outer.roughness = 0.18;
          outer.emissive.setHex(0x000000);
          outer.emissiveIntensity = 0.0;
        }
        if (inner) {
          inner.color.setHex(shadowNeon);
          inner.metalness = 0.0;
          inner.roughness = 0.08;
          inner.emissive.setHex(shadowNeon);
          inner.emissiveIntensity = clamp((boostingVisual ? 0.85 : 0.6) * visMul * spawnAlpha, 0, 1.25);
        }
      } else {
        const orb = render.headMaterials[0];
        const rune = render.headMaterials[1];
        if (orb) {
          const depth = 0.55 + 0.45 * Math.sin(t * 0.95 + length * 0.03 + render.skinOffset * 7.0);
          orb.color.setHex(mixColor(mageBase, mageNebula, depth * 0.22));
          orb.metalness = 0.0;
          orb.roughness = 0.16;
          orb.emissive.setHex(mixColor(mageStar, mageNebula, 0.28));
          orb.emissiveIntensity = clamp(0.05 * spawnAlpha, 0, 0.12);
        }
        if (rune) {
          const pulse = 0.5 + 0.5 * Math.sin(t * 2.15 + length * 0.02 + render.skinOffset * 6.0);
          const c = mixColor(mageNebula, mageStar, 0.3 + pulse * 0.55);
          rune.color.setHex(c);
          rune.metalness = 0.0;
          rune.roughness = 0.12;
          rune.emissive.setHex(c);
          rune.emissiveIntensity = clamp((0.85 + (singularity ? 0.55 : 0)) * spawnAlpha, 0, 2.4);
        }
      }

      const headOpacity = render.dna === 'shadow' ? clamp(bodyOpacity + 0.12, 0, 1) : bodyOpacity;
      for (const m of render.headMaterials) {
        m.opacity = headOpacity;
        m.transparent = render.dna === 'shadow' || opacity < 1;
        m.depthWrite = render.dna !== 'shadow' && opacity >= 1;
      }

      // Cyber Ninja spec: keep the body clean (no visible inner skeleton).
      render.spineMaterial.opacity = 0;
      render.spineMaterial.transparent = true;
      render.spineMaterial.depthWrite = false;
      render.spineMaterial.emissive.setHex(0x000000);
      render.spineMaterial.emissiveIntensity = 0.0;

      // Contact shadow (grounded feel; hidden while invisible).
      const shadowMat = render.shadow.material as THREE.MeshBasicMaterial;
      render.shadow.position.set(head.x, 0.02, head.y);
      const shadowScale = headBase * (render.dna === 'iron' ? 1.5 : render.dna === 'magnetic' ? 1.55 : 1.45);
      render.shadow.scale.set(shadowScale, shadowScale, shadowScale);
      shadowMat.opacity = clamp(0.2 * spawnAlpha * (stealthVisual || phaseVisual ? 0 : 1), 0, 0.22);
      render.shadow.visible = shadowMat.opacity > 0.01;

      // Class aura (ground ring)
      const auraMat = render.aura.material as THREE.MeshBasicMaterial;
      render.aura.position.set(head.x, 0.03, head.y);
      render.aura.rotation.z = t * (render.dna === 'shadow' ? 2.0 : render.dna === 'magnetic' ? 1.2 : 0.8);
      let auraColor = render.dna === 'iron' ? ironAccent : render.dna === 'shadow' ? shadowNeon : mageNebula;
      let auraOpacity = 0;
      let auraScale = headBase * 2.2;

      if (stealthVisual || phaseVisual) {
        auraOpacity = 0;
      } else if (render.dna === 'iron') {
        auraColor = siege ? 0xff3b2f : mixColor(ironAccent, 0xffffff, 0.45);
        auraScale = headBase * (2.35 + render.armor * 0.22 + (boostingVisual ? 0.15 : 0));
        auraOpacity = (render.armor > 0 ? 0.16 + render.armor * 0.03 : 0.06) + (boostingVisual ? 0.05 : 0);
      } else if (render.dna === 'shadow') {
        auraColor = mixColor(0x00e5ff, 0xb000ff, 0.5 + 0.5 * Math.sin(t * 1.65 + length * 0.04));
        auraScale = headBase * (2.5 + (boostingVisual ? 0.3 : 0.0));
        auraOpacity = boostingVisual ? 0.14 : 0.06;
      } else {
        auraColor = mixColor(mageStar, mageNebula, 0.5 + 0.5 * Math.sin(t * 1.1 + length * 0.03 + render.skinOffset * 5));
        auraScale = headBase * (3.1 + (singularity ? 1.1 : 0));
        auraOpacity = 0.11 + (singularity ? 0.07 : 0.0);
      }

      // Eating pulse: quick "chomp" feedback for all classes.
      if (!stealthVisual && !phaseVisual && render.eatFx > 0) {
        const chew = Math.sin((1 - render.eatFx) * Math.PI);
        auraOpacity += chew * 0.12;
        auraScale *= 1 + chew * 0.08;
      }

      auraMat.color.setHex(auraColor);
      auraMat.opacity = clamp(auraOpacity * spawnAlpha, 0, 0.6);
      render.aura.scale.set(auraScale, auraScale, auraScale);
      render.aura.visible = auraMat.opacity > 0.01;

      // Head pose (silhouette first: 0.1s readability)
      const neck = render.segs[1] ?? render.targetSegs[1];
      let headDirOk = false;
      if (neck) {
        const dx = head.x - neck.x;
        const dy = head.y - neck.y;
        const d2 = dx * dx + dy * dy;
        if (d2 > 0.001) {
          const headingNow = Math.atan2(dy, dx);
          const prev = render.headingValid ? render.heading : headingNow;
          const dHeading = normalizeAngle(headingNow - prev);
          render.heading = headingNow;
          render.headingValid = true;

          const safeDt = Math.max(dt, 1 / 120);
          const turnRate = dHeading / safeDt;

          const classMul = render.dna === 'shadow' ? 1.25 : render.dna === 'iron' ? 0.9 : 1.05;
          const maxBank = WORM_BANK_MAX * classMul;
          const bankTarget = clamp(-turnRate / WORM_BANK_TURN_RATE_FOR_MAX, -1, 1) * maxBank;
          render.bank = lerp(render.bank, bankTarget, smoothFactor(WORM_BANK_K, dt));

          tmpDir.set(dx, 0, dy).normalize();
          render.head.quaternion.setFromUnitVectors(forward, tmpDir);
          if (Math.abs(render.bank) > 0.0001) {
            tmpQuat.setFromAxisAngle(tmpDir, render.bank);
            render.head.quaternion.premultiply(tmpQuat);
          }
          headDirOk = true;
        } else {
          render.headingValid = false;
        }
      }
      if (!headDirOk) {
        render.bank = lerp(render.bank, 0, smoothFactor(WORM_BANK_K, dt));
      }
      render.head.position.set(head.x, headBase * 0.95, head.y);
      const chew = render.eatFx > 0 ? Math.sin((1 - render.eatFx) * Math.PI) : 0;
      if (render.dna === 'iron') {
        render.head.scale.set(
          headBase * 1.22 * (1 + chew * 0.1),
          headBase * 0.86 * (1 - chew * 0.08),
          headBase * 1.28 * (1 + chew * 0.18),
        );
      } else if (render.dna === 'shadow') {
        render.head.scale.set(
          headBase * 0.92 * (1 + chew * 0.08),
          headBase * 0.7 * (1 - chew * 0.1),
          headBase * 1.45 * (1 + chew * 0.22),
        );
      } else {
        render.head.scale.set(
          headBase * 1.15 * (1 + chew * 0.12),
          headBase * 0.95 * (1 - chew * 0.07),
          headBase * 1.15 * (1 + chew * 0.26),
        );
      }

      // Class parts: Shadow scarf (Cyber Ninja) & Arcana rune circle (Mage).
      if (render.scarf) {
        const scarfActive = render.dna === 'shadow' && !stealthVisual && !phaseVisual && opacity > 0.02;
        render.scarf.visible = scarfActive;
        if (scarfActive) {
          let fx = 1;
          let fz = 0;
          if (neck) {
            const dx = head.x - neck.x;
            const dz = head.y - neck.y;
            const d2 = dx * dx + dz * dz;
            if (d2 > 0.001) {
              const inv = 1 / Math.sqrt(d2);
              fx = dx * inv;
              fz = dz * inv;
            }
          }

          const sx = -fz;
          const sz = fx;
          const swayBase = (0.26 + (boostingVisual ? 0.06 : 0)) * headBase;
          const sway = Math.sin(t * 2.35 + render.skinOffset * 14.0) * swayBase;
          const jitter = Math.sin(t * 9.2 + render.skinOffset * 31.0) * headBase * 0.05;

          render.scarf.quaternion.copy(render.head.quaternion);
          render.scarf.position.set(
            head.x - fx * headBase * 0.42 + sx * (sway + jitter),
            headBase * 1.22 +
              Math.sin(t * 6.8 + render.skinOffset * 11.0) * headBase * 0.12 +
              Math.sin(t * 11.5 + render.skinOffset * 21.0) * headBase * 0.05,
            head.y - fz * headBase * 0.42 + sz * (sway + jitter),
          );
          render.scarf.rotateX(-0.44 + Math.sin(t * 2.25 + render.skinOffset * 10.0) * 0.22);
          render.scarf.rotateY(
            Math.sin(t * 1.6 + render.skinOffset * 9.0) * 0.2 + Math.sin(t * 4.8 + render.skinOffset * 17.0) * 0.07,
          );
          render.scarf.rotateZ(Math.sin(t * 1.35 + render.skinOffset * 12.0) * 0.14);

          const scarfScale = headBase * (boostingVisual ? 0.92 : 0.84);
          render.scarf.scale.set(scarfScale, scarfScale, scarfScale);

          const mat = render.scarf.material as THREE.MeshBasicMaterial;
          mat.color.setHex(shadowNeon);
          mat.opacity = clamp((boostingVisual ? 0.66 : 0.5) * spawnAlpha * visMul, 0, 0.85);

          const intensity = clamp((boostingVisual ? 1 : 0.55) + (Math.abs(render.bank) / WORM_BANK_MAX) * 0.35, 0, 1);
          animateScarf(render.scarf, t, render.skinOffset, intensity);
        }
      }

      if (render.magicCircle) {
        const magicActive = render.dna === 'magnetic' && !stealthVisual && !phaseVisual && opacity > 0.02;
        render.magicCircle.visible = magicActive;
        if (magicActive) {
          render.magicCircle.position.set(head.x, 0.035, head.y);
          const spin = -t * (singularity ? 1.85 : 1.2) + render.skinOffset * 12.0;
          const tiltBase = singularity ? 0.26 : 0.18;
          const tiltWobble = singularity ? 0.08 : 0.05;
          const tilt = tiltBase + tiltWobble * Math.sin(t * 1.15 + render.skinOffset * 6.0 + length * 0.03);
          render.magicCircle.rotation.set(tilt, spin, tilt * 0.65);
          const pulse = 1 + 0.06 * Math.sin(t * 3.1 + render.skinOffset * 8.0 + length * 0.02);
          const mcScale = headBase * (singularity ? 4.6 : 3.7) * pulse;
          render.magicCircle.scale.set(mcScale, mcScale, mcScale);

          const mat = render.magicCircle.material as THREE.MeshBasicMaterial;
          const c = mixColor(0xe0ffff, 0xff007f, 0.5 + 0.5 * Math.sin(t * 1.1 + length * 0.05 + render.skinOffset * 6));
          mat.color.setHex(c);
          mat.opacity = clamp((0.18 + (singularity ? 0.07 : 0)) * spawnAlpha, 0, 0.42);
        }
      }

      // Body (organic tube via overlapping instanced segments)
      const segs = render.segs.length > 0 ? render.segs : render.targetSegs;
      const srcLen = segs.length;
      const maxPoints = id === myId ? 340 : 240;
      const pointCount = Math.min(WORM_MAX_INST, Math.min(maxPoints, srcLen));
      const denom = Math.max(1, pointCount - 1);
      const bodyCount = Math.max(0, pointCount - 1);

      const lengthMul = render.dna === 'iron' ? 1.22 : render.dna === 'shadow' ? 1.18 : 1.12;
      const spineMul = 0.32;

      for (let i = 0; i < bodyCount; i++) {
        const idxA = pointCount === srcLen ? i : Math.round((i / denom) * (srcLen - 1));
        const idxB = pointCount === srcLen ? i + 1 : Math.round(((i + 1) / denom) * (srcLen - 1));
        const a = segs[idxA]!;
        const b = segs[idxB]!;
        const fa = pointCount <= 1 ? 0 : i / denom;
        const fb = pointCount <= 1 ? 0 : (i + 1) / denom;
        const fMid = pointCount <= 1 ? 0 : (i + 0.5) / denom;

        let ra = i === 0 ? headBase : bodyBase * (0.94 - fa * 0.3);
        let rb = bodyBase * (0.94 - fb * 0.3);

        if (render.dna === 'magnetic') {
          const wave = 1 + 0.095 * Math.sin(t * 2.75 - fMid * 12.0 + render.skinOffset * 7.0);
          ra *= wave;
          rb *= wave;
        }

        const ax = a.x;
        const az = a.y;
        const ay = ra * 0.95;
        const bx = b.x;
        const bz = b.y;
        const by = rb * 0.95;

        tmpDir.set(bx - ax, by - ay, bz - az);
        const dist = tmpDir.length();
        if (dist <= 0.001) {
          tmpObj.position.set(ax, ay, az);
          tmpObj.quaternion.identity();
          tmpObj.scale.set(0, 0, 0);
          tmpObj.updateMatrix();
          render.body.setMatrixAt(i, tmpObj.matrix);
          tmpColor.setHex(0x000000);
          render.body.setColorAt(i, tmpColor);
          continue;
        }
        tmpDir.multiplyScalar(1 / dist);

        const segR = (ra + rb) * 0.5;
        let shapeX = render.dna === 'iron' ? 1.18 : render.dna === 'shadow' ? 0.76 : 1.02;
        let shapeZ = render.dna === 'iron' ? 1.06 : render.dna === 'shadow' ? 0.68 : 1.02;

        // Full Metal: vary plate thickness per segment so it reads as layered armor.
        let plateShade = 1;
        if (render.dna === 'iron') {
          const step = (i + Math.floor(render.skinOffset * 1000)) % 3;
          const plate = step === 0 ? 1.32 : step === 1 ? 1.12 : 1.24;
          const micro = 1 + 0.06 * Math.sin(i * 0.9 + render.skinOffset * 12.0);
          const mul = plate * micro;
          shapeX *= mul;
          shapeZ *= mul * 0.95;
          plateShade = step === 1 ? 0.92 : step === 2 ? 0.98 : 1.06;
        }

        let segColor: number;
        if (render.dna === 'magnetic') {
          // Arcana/Cosmic: deep space base + nebula waves + star speckles.
          const phase = t * 1.15 - fMid * 10.0 + render.skinOffset * 8.0;
          const blend = 0.5 + 0.5 * Math.sin(phase);
          segColor = mixColor(mageBase, mageNebula, 0.18 + blend * 0.58);
          const speck = 0.5 + 0.5 * Math.sin(t * 3.2 + fMid * 14.0 + render.skinOffset * 10.0);
          segColor = mixColor(segColor, mageStar, speck * 0.16);
        } else {
          const scroll = render.dna === 'shadow' ? t * 6.0 : 0;
          const band = Math.floor((i + scroll + render.skinOffset * 1000) / stripe);
          segColor = palette[((band % palette.length) + palette.length) % palette.length]!;
        }
        segColor = shade(segColor, 0.88 + 0.22 * (1 - fMid));
        if (render.dna === 'iron') segColor = shade(segColor, plateShade);
        if (boostingVisual) segColor = shade(segColor, render.dna === 'shadow' ? 1.12 : 1.06);
        if (siege) segColor = mixColor(segColor, 0xff3b2f, 0.28);
        if (singularity && render.dna === 'magnetic') {
          const swirl = 0.18 + 0.18 * Math.sin(t * 2.6 + fMid * 10.0);
          segColor = mixColor(segColor, mageNebula, swirl);
        }

        tmpObj.position.set((ax + bx) * 0.5, (ay + by) * 0.5, (az + bz) * 0.5);
        tmpObj.quaternion.setFromUnitVectors(up, tmpDir);
        if (render.bank !== 0) {
          const w = 1 - fMid;
          const roll = render.bank * w * w;
          if (Math.abs(roll) > 0.0001) {
            tmpQuat.setFromAxisAngle(tmpDir, roll);
            tmpObj.quaternion.premultiply(tmpQuat);
          }
        }
        tmpObj.scale.set(segR * shapeX, dist * lengthMul, segR * shapeZ);
        tmpObj.updateMatrix();
        render.body.setMatrixAt(i, tmpObj.matrix);
        tmpColor.setHex(segColor);
        render.body.setColorAt(i, tmpColor);
      }

      render.body.count = bodyCount;
      render.body.instanceMatrix.needsUpdate = true;
      if (render.body.instanceColor) render.body.instanceColor.needsUpdate = true;

      render.spine.count = 0;
      render.spine.instanceMatrix.needsUpdate = true;
      if (render.spine.instanceColor) render.spine.instanceColor.needsUpdate = true;

      render.nameSprite.position.set(head.x, headBase * 2.15, head.y);
      const camDist = Math.hypot(head.x - camera.x, head.y - camera.y);
      const baseNameAlpha = clamp(1 - camDist / 1800, 0.15, 1);
      const nameMat = render.nameSprite.material as THREE.SpriteMaterial;
      nameMat.opacity = baseNameAlpha * spawnAlpha * (stealthVisual || phaseVisual ? 0 : 1);
      render.nameSprite.visible = nameMat.opacity > 0.02;
    }

    // Decoys (culled)
    for (const [, render] of decoyRenders) {
      const segsForCull = render.targetSegs.length > 0 ? render.targetSegs : render.segs;
      if (segsForCull.length === 0) continue;

      const margin = render.group.visible ? playerHideMargin : playerShowMargin;
      const visible = isAnySegmentInsideView(segsForCull, view, margin);
      render.group.visible = visible;
      if (!visible) continue;

      const head = render.segs[0] ?? render.targetSegs[0];
      if (!head) continue;

      setNameSprite(render, render.name);
      applyClassVisual(render);

      const length = Math.max(1, render.visualLen || render.segs.length);
      const bodyMul = render.dna === 'shadow' ? 0.78 : render.dna === 'iron' ? 1.06 : 1.18;
      const headMul = render.dna === 'shadow' ? 0.92 : render.dna === 'iron' ? 1.02 : 1.12;
      const bodyBase = bodyRadiusForLength(length) * bodyMul;
      const headBase = headRadiusForLength(length) * headMul;

      const palette = render.skinPalette.length > 0 ? render.skinPalette : [render.color];
      const stripe = Math.max(1, render.skinStripe);

      const ironSteel = palette[0] ?? 0xf0f4f8;
      const ironJoint = palette[2] ?? 0x2b303b;
      const ironAccent = palette[4] ?? 0xffd700;

      const mageBase = palette[0] ?? 0x191970;
      const mageNebula = palette[2] ?? 0xff007f;
      const mageStar = palette[4] ?? 0xe0ffff;

      const shadowNeonA = palette[3] ?? 0x00e5ff;
      const shadowNeonB = palette[5] ?? 0xb000ff;
      const shadowNeon = mixColor(
        shadowNeonA,
        shadowNeonB,
        0.5 + 0.5 * Math.sin(t * 2.05 + length * 0.06 + render.skinOffset * 7.0),
      );

      const shimmer = 0.92 + 0.08 * Math.sin(t * 18.3 + length * 0.11);
      const spawnAlpha = clamp(0.92 - render.spawnFx * 0.35, 0.45, 0.92);
      const opacity = clamp(0.82 * shimmer * spawnAlpha, 0, 1);
      const bodyOpacity = render.dna === 'shadow' ? opacity * 0.78 : opacity;

      if (render.dna === 'iron') {
        render.material.metalness = 0.88;
        render.material.roughness = 0.46;
      } else if (render.dna === 'shadow') {
        render.material.metalness = 0.05;
        render.material.roughness = 0.42;
      } else {
        render.material.metalness = 0.0;
        render.material.roughness = 0.22;
      }

      render.material.opacity = bodyOpacity;
      render.material.transparent = true;
      render.material.depthWrite = false;
      if (render.dna === 'shadow') {
        render.material.emissive.setHex(shadowNeon);
        render.material.emissiveIntensity = clamp(0.35 * shimmer * spawnAlpha, 0, 0.9);
      } else {
        render.material.emissive.setHex(0x000000);
        render.material.emissiveIntensity = 0.0;
      }

      if (render.dna === 'iron') {
        const primary = render.headMaterials[0];
        const accent = render.headMaterials[1];
        if (primary) {
          primary.color.setHex(ironSteel);
          primary.metalness = 0.8;
          primary.roughness = 0.46;
        }
        if (accent) {
          accent.color.setHex(ironAccent);
          accent.metalness = 0.75;
          accent.roughness = 0.4;
        }
      } else if (render.dna === 'shadow') {
        const outer = render.headMaterials[0];
        const inner = render.headMaterials[1];
        if (outer) outer.color.setHex(0x0b0d12);
        if (inner) {
          inner.color.setHex(shadowNeon);
          inner.emissive.setHex(shadowNeon);
          inner.emissiveIntensity = clamp(0.85 * shimmer * spawnAlpha, 0, 1.4);
        }
      } else {
        const orb = render.headMaterials[0];
        const rune = render.headMaterials[1];
        if (orb) {
          const depth = 0.55 + 0.45 * Math.sin(t * 0.9 + length * 0.03 + render.skinOffset * 7.0);
          orb.color.setHex(mixColor(mageBase, mageNebula, depth * 0.22));
          orb.emissive.setHex(mixColor(mageStar, mageNebula, 0.26));
          orb.emissiveIntensity = clamp(0.04 * shimmer * spawnAlpha, 0, 0.1);
        }
        if (rune) {
          const pulse = 0.5 + 0.5 * Math.sin(t * 2.05 + length * 0.02 + render.skinOffset * 6.0);
          const c = mixColor(mageNebula, mageStar, 0.3 + pulse * 0.55);
          rune.color.setHex(c);
          rune.emissive.setHex(c);
          rune.emissiveIntensity = clamp(0.75 * shimmer * spawnAlpha, 0, 1.8);
        }
      }

      const headOpacity = render.dna === 'shadow' ? clamp(bodyOpacity + 0.12, 0, 1) : bodyOpacity;
      for (const m of render.headMaterials) {
        m.opacity = headOpacity;
        m.transparent = true;
        m.depthWrite = false;
      }

      render.spineMaterial.opacity = 0;
      render.spineMaterial.transparent = true;
      render.spineMaterial.depthWrite = false;
      render.spineMaterial.emissive.setHex(0x000000);
      render.spineMaterial.emissiveIntensity = 0.0;

      const shadowMat = render.shadow.material as THREE.MeshBasicMaterial;
      render.shadow.position.set(head.x, 0.02, head.y);
      render.shadow.scale.set(headBase * 1.45, headBase * 1.45, headBase * 1.45);
      shadowMat.opacity = clamp(0.13 * shimmer * spawnAlpha, 0, 0.18);
      render.shadow.visible = shadowMat.opacity > 0.01;

      const auraMat = render.aura.material as THREE.MeshBasicMaterial;
      render.aura.position.set(head.x, 0.03, head.y);
      render.aura.rotation.z = t * (render.dna === 'shadow' ? 2.2 : render.dna === 'magnetic' ? 1.4 : 0.9) + length * 0.01;
      const auraColor = render.dna === 'iron' ? ironAccent : render.dna === 'shadow' ? shadowNeon : mageNebula;
      const auraScale = headBase * (render.dna === 'magnetic' ? 3.1 : 2.3);
      auraMat.color.setHex(auraColor);
      auraMat.opacity = clamp(0.09 * shimmer * spawnAlpha, 0, 0.35);
      render.aura.scale.set(auraScale, auraScale, auraScale);
      render.aura.visible = auraMat.opacity > 0.01;

      const neck = render.segs[1] ?? render.targetSegs[1];
      let headDirOk = false;
      if (neck) {
        const dx = head.x - neck.x;
        const dy = head.y - neck.y;
        const d2 = dx * dx + dy * dy;
        if (d2 > 0.001) {
          const headingNow = Math.atan2(dy, dx);
          const prev = render.headingValid ? render.heading : headingNow;
          const dHeading = normalizeAngle(headingNow - prev);
          render.heading = headingNow;
          render.headingValid = true;

          const safeDt = Math.max(dt, 1 / 120);
          const turnRate = dHeading / safeDt;

          const classMul = render.dna === 'shadow' ? 1.25 : render.dna === 'iron' ? 0.9 : 1.05;
          const maxBank = WORM_BANK_MAX * classMul;
          const bankTarget = clamp(-turnRate / WORM_BANK_TURN_RATE_FOR_MAX, -1, 1) * maxBank;
          render.bank = lerp(render.bank, bankTarget, smoothFactor(WORM_BANK_K, dt));

          tmpDir.set(dx, 0, dy).normalize();
          render.head.quaternion.setFromUnitVectors(forward, tmpDir);
          if (Math.abs(render.bank) > 0.0001) {
            tmpQuat.setFromAxisAngle(tmpDir, render.bank);
            render.head.quaternion.premultiply(tmpQuat);
          }
          headDirOk = true;
        } else {
          render.headingValid = false;
        }
      }
      if (!headDirOk) {
        render.bank = lerp(render.bank, 0, smoothFactor(WORM_BANK_K, dt));
      }
      render.head.position.set(head.x, headBase * 0.95, head.y);
      const chew = render.eatFx > 0 ? Math.sin((1 - render.eatFx) * Math.PI) : 0;
      if (render.dna === 'iron') {
        render.head.scale.set(
          headBase * 1.2 * (1 + chew * 0.1),
          headBase * 0.86 * (1 - chew * 0.08),
          headBase * 1.25 * (1 + chew * 0.18),
        );
      } else if (render.dna === 'shadow') {
        render.head.scale.set(
          headBase * 0.92 * (1 + chew * 0.08),
          headBase * 0.7 * (1 - chew * 0.1),
          headBase * 1.4 * (1 + chew * 0.22),
        );
      } else {
        render.head.scale.set(
          headBase * 1.12 * (1 + chew * 0.12),
          headBase * 0.95 * (1 - chew * 0.07),
          headBase * 1.12 * (1 + chew * 0.26),
        );
      }

      if (render.scarf) {
        const scarfActive = render.dna === 'shadow' && opacity > 0.02;
        render.scarf.visible = scarfActive;
        if (scarfActive) {
          let fx = 1;
          let fz = 0;
          if (neck) {
            const dx = head.x - neck.x;
            const dz = head.y - neck.y;
            const d2 = dx * dx + dz * dz;
            if (d2 > 0.001) {
              const inv = 1 / Math.sqrt(d2);
              fx = dx * inv;
              fz = dz * inv;
            }
          }

          const sx = -fz;
          const sz = fx;
          const swayBase = headBase * 0.22;
          const sway = Math.sin(t * 2.25 + render.skinOffset * 12.0) * swayBase;
          const jitter = Math.sin(t * 8.4 + render.skinOffset * 27.0) * headBase * 0.04;

          render.scarf.quaternion.copy(render.head.quaternion);
          render.scarf.position.set(
            head.x - fx * headBase * 0.38 + sx * (sway + jitter),
            headBase * 1.16 +
              Math.sin(t * 6.4 + render.skinOffset * 9.0) * headBase * 0.1 +
              Math.sin(t * 10.8 + render.skinOffset * 19.0) * headBase * 0.04,
            head.y - fz * headBase * 0.38 + sz * (sway + jitter),
          );
          render.scarf.rotateX(-0.42 + Math.sin(t * 2.05 + render.skinOffset * 8.0) * 0.2);
          render.scarf.rotateY(
            Math.sin(t * 1.5 + render.skinOffset * 11.0) * 0.18 + Math.sin(t * 4.6 + render.skinOffset * 15.0) * 0.06,
          );
          render.scarf.rotateZ(Math.sin(t * 1.25 + render.skinOffset * 10.0) * 0.12);

          const scarfScale = headBase * 0.82;
          render.scarf.scale.set(scarfScale, scarfScale, scarfScale);

          const mat = render.scarf.material as THREE.MeshBasicMaterial;
          mat.color.setHex(shadowNeon);
          mat.opacity = clamp(0.52 * shimmer * spawnAlpha, 0, 0.75);

          const intensity = clamp(0.55 + (Math.abs(render.bank) / WORM_BANK_MAX) * 0.35, 0, 1);
          animateScarf(render.scarf, t, render.skinOffset, intensity);
        }
      }

      if (render.magicCircle) {
        const magicActive = render.dna === 'magnetic' && opacity > 0.02;
        render.magicCircle.visible = magicActive;
        if (magicActive) {
          render.magicCircle.position.set(head.x, 0.035, head.y);
          const spin = -t * 1.15 + render.skinOffset * 12.0;
          const tiltBase = 0.18;
          const tiltWobble = 0.05;
          const tilt = tiltBase + tiltWobble * Math.sin(t * 1.1 + render.skinOffset * 6.0 + length * 0.03);
          render.magicCircle.rotation.set(tilt, spin, tilt * 0.65);
          const pulse = 1 + 0.06 * Math.sin(t * 3.0 + render.skinOffset * 8.0 + length * 0.02);
          const mcScale = headBase * 3.35 * pulse;
          render.magicCircle.scale.set(mcScale, mcScale, mcScale);

          const mat = render.magicCircle.material as THREE.MeshBasicMaterial;
          const c = mixColor(0xe0ffff, 0xff007f, 0.5 + 0.5 * Math.sin(t * 1.05 + length * 0.05 + render.skinOffset * 6));
          mat.color.setHex(c);
          mat.opacity = clamp(0.16 * shimmer * spawnAlpha, 0, 0.35);
        }
      }

      const segs = render.segs.length > 0 ? render.segs : render.targetSegs;
      const srcLen = segs.length;
      const pointCount = Math.min(WORM_MAX_INST, Math.min(220, srcLen));
      const denom = Math.max(1, pointCount - 1);
      const bodyCount = Math.max(0, pointCount - 1);

      const lengthMul = render.dna === 'iron' ? 1.22 : render.dna === 'shadow' ? 1.18 : 1.12;
      const spineMul = 0.32;

      for (let i = 0; i < bodyCount; i++) {
        const idxA = pointCount === srcLen ? i : Math.round((i / denom) * (srcLen - 1));
        const idxB = pointCount === srcLen ? i + 1 : Math.round(((i + 1) / denom) * (srcLen - 1));
        const a = segs[idxA]!;
        const b = segs[idxB]!;
        const fa = pointCount <= 1 ? 0 : i / denom;
        const fb = pointCount <= 1 ? 0 : (i + 1) / denom;
        const fMid = pointCount <= 1 ? 0 : (i + 0.5) / denom;

        let ra = i === 0 ? headBase : bodyBase * (0.94 - fa * 0.3);
        let rb = bodyBase * (0.94 - fb * 0.3);
        if (render.dna === 'magnetic') {
          const wave = 1 + 0.085 * Math.sin(t * 2.75 - fMid * 12.0 + render.skinOffset * 7.0);
          ra *= wave;
          rb *= wave;
        }
        if (chew > 0) {
          const digest = 1 + 0.055 * chew * Math.sin(t * 8.0 - fMid * 10.0 + render.skinOffset * 10.0);
          ra *= digest;
          rb *= digest;
        }

        const ax = a.x;
        const az = a.y;
        const ay = ra * 0.95;
        const bx = b.x;
        const bz = b.y;
        const by = rb * 0.95;

        tmpDir.set(bx - ax, by - ay, bz - az);
        const dist = tmpDir.length();
        if (dist <= 0.001) {
          tmpObj.position.set(ax, ay, az);
          tmpObj.quaternion.identity();
          tmpObj.scale.set(0, 0, 0);
          tmpObj.updateMatrix();
          render.body.setMatrixAt(i, tmpObj.matrix);
          tmpColor.setHex(0x000000);
          render.body.setColorAt(i, tmpColor);
          continue;
        }
        tmpDir.multiplyScalar(1 / dist);

        const segR = (ra + rb) * 0.5;
        let shapeX = render.dna === 'iron' ? 1.18 : render.dna === 'shadow' ? 0.76 : 1.02;
        let shapeZ = render.dna === 'iron' ? 1.06 : render.dna === 'shadow' ? 0.68 : 1.02;

        let plateShade = 1;
        if (render.dna === 'iron') {
          const step = (i + Math.floor(render.skinOffset * 1000)) % 3;
          const plate = step === 0 ? 1.3 : step === 1 ? 1.1 : 1.22;
          const micro = 1 + 0.06 * Math.sin(i * 0.9 + render.skinOffset * 12.0);
          const mul = plate * micro;
          shapeX *= mul;
          shapeZ *= mul * 0.95;
          plateShade = step === 1 ? 0.92 : step === 2 ? 0.98 : 1.06;
        }

        let segColor: number;
        if (render.dna === 'magnetic') {
          const phase = t * 1.15 - fMid * 10.0 + render.skinOffset * 8.0;
          const blend = 0.5 + 0.5 * Math.sin(phase);
          segColor = mixColor(mageBase, mageNebula, 0.18 + blend * 0.58);
          const speck = 0.5 + 0.5 * Math.sin(t * 3.2 + fMid * 14.0 + render.skinOffset * 10.0);
          segColor = mixColor(segColor, mageStar, speck * 0.16);
        } else {
          const scroll = render.dna === 'shadow' ? t * 6.0 : 0;
          const band = Math.floor((i + scroll + render.skinOffset * 1000) / stripe);
          segColor = palette[((band % palette.length) + palette.length) % palette.length]!;
        }
        segColor = shade(segColor, (0.84 + 0.2 * (1 - fMid)) * (0.92 + shimmer * 0.12));
        if (render.dna === 'iron') segColor = shade(segColor, plateShade);

        let midX = (ax + bx) * 0.5;
        let midZ = (az + bz) * 0.5;
        // Soft body wiggle (purely visual) to avoid "rigid chain" feel.
        const hx = bx - ax;
        const hz = bz - az;
        const hLen = Math.hypot(hx, hz);
        if (hLen > 0.001) {
          const ux = hx / hLen;
          const uz = hz / hLen;
          const sx = -uz;
          const sz = ux;
          const envelope = Math.sin(fMid * Math.PI);
          const baseWiggle = render.dna === 'iron' ? 0.45 : render.dna === 'shadow' ? 0.85 : 0.65;
          const amp = Math.min(2.2, segR * 0.1) * baseWiggle * envelope * (render.boosting ? 1 : 0.7);
          const freq = render.dna === 'shadow' ? 8.6 : render.dna === 'magnetic' ? 6.8 : 4.8;
          const phase = t * freq + fMid * 11.0 + render.skinOffset * 8.0;
          const wiggle = Math.sin(phase) * amp;
          midX += sx * wiggle;
          midZ += sz * wiggle;
        }

        tmpObj.position.set(midX, (ay + by) * 0.5, midZ);
        tmpObj.quaternion.setFromUnitVectors(up, tmpDir);
        if (render.bank !== 0) {
          const w = 1 - fMid;
          const roll = render.bank * w * w;
          if (Math.abs(roll) > 0.0001) {
            tmpQuat.setFromAxisAngle(tmpDir, roll);
            tmpObj.quaternion.premultiply(tmpQuat);
          }
        }
        tmpObj.scale.set(segR * shapeX, dist * lengthMul, segR * shapeZ);
        tmpObj.updateMatrix();
        render.body.setMatrixAt(i, tmpObj.matrix);
        tmpColor.setHex(segColor);
        render.body.setColorAt(i, tmpColor);
      }

      render.body.count = bodyCount;
      render.body.instanceMatrix.needsUpdate = true;
      if (render.body.instanceColor) render.body.instanceColor.needsUpdate = true;

      render.spine.count = 0;
      render.spine.instanceMatrix.needsUpdate = true;
      if (render.spine.instanceColor) render.spine.instanceColor.needsUpdate = true;

      // Decoys don't need nameplates (keeps the read clean and saves work).
      render.nameSprite.visible = false;
    }

    // Minimap (10fps)
    if (latestState && minimapEl && minimapCtx) {
      minimapAcc += dt;
      if (minimapAcc >= 0.1) {
        minimapAcc = 0;

        const w = minimapEl.width;
        const h = minimapEl.height;
        minimapCtx.clearRect(0, 0, w, h);

        // Mask: hide the square minimap canvas so only the arena circle reads.
        minimapCtx.fillStyle = 'rgba(0, 0, 0, 1)';
        minimapCtx.fillRect(0, 0, w, h);

        const halfW = latestState.world.width / 2;
        const halfH = latestState.world.height / 2;
        const pad = 6;
        const innerW = w - pad * 2;
        const innerH = h - pad * 2;
        const cx = pad + innerW / 2;
        const cy = pad + innerH / 2;
        const arenaR = Math.min(innerW, innerH) / 2;

        const mapX = (x: number) => pad + clamp((x + halfW) / (halfW * 2), 0, 1) * innerW;
        const mapY = (y: number) => pad + clamp((y + halfH) / (halfH * 2), 0, 1) * innerH;

        minimapCtx.save();
        minimapCtx.beginPath();
        minimapCtx.arc(cx, cy, arenaR, 0, Math.PI * 2);
        minimapCtx.clip();

        // Inside plate
        minimapCtx.fillStyle = 'rgba(10, 12, 18, 0.55)';
        minimapCtx.fillRect(0, 0, w, h);

        // Players
        for (const [id, render] of playerRenders) {
          if (id === LOBBY_PREVIEW_ID) continue;
          if (id !== myId && (render.stealth || render.phase)) continue;
          const head = render.segs[0] ?? render.targetSegs[0];
          if (!head) continue;
          const x = mapX(head.x);
          const y = mapY(head.y);
          const baseR = id === myId ? 3.1 : 2.0;
          const len = render.visualLen || render.segs.length;
          const r = baseR + sizeExtraForLength(len) * 0.18;

          minimapCtx.globalAlpha = 0.9;
          minimapCtx.fillStyle = cssHexColor(render.color);
          minimapCtx.beginPath();
          minimapCtx.arc(x, y, r, 0, Math.PI * 2);
          minimapCtx.fill();

          if (id === myId) {
            minimapCtx.globalAlpha = 0.95;
            minimapCtx.strokeStyle = 'rgba(255, 255, 255, 0.9)';
            minimapCtx.lineWidth = 1.5;
            minimapCtx.beginPath();
            minimapCtx.arc(x, y, r + 2.1, 0, Math.PI * 2);
            minimapCtx.stroke();
          }
        }

        // Decoys
        for (const [, render] of decoyRenders) {
          const head = render.segs[0] ?? render.targetSegs[0];
          if (!head) continue;
          const x = mapX(head.x);
          const y = mapY(head.y);
          const baseR = 2.0;
          const len = render.visualLen || render.segs.length;
          const r = baseR + sizeExtraForLength(len) * 0.18;

          minimapCtx.globalAlpha = 0.9;
          minimapCtx.fillStyle = cssHexColor(render.color);
          minimapCtx.beginPath();
          minimapCtx.arc(x, y, r, 0, Math.PI * 2);
          minimapCtx.fill();
        }

        minimapCtx.restore();

        // Border
        minimapCtx.globalAlpha = 1;
        minimapCtx.strokeStyle = 'rgba(255, 255, 255, 0.42)';
        minimapCtx.lineWidth = 1.8;
        minimapCtx.beginPath();
        minimapCtx.arc(cx, cy, arenaR, 0, Math.PI * 2);
        minimapCtx.stroke();
      }
    }

    // Boost + skill FX (3D particles)
    if (meBoostingVisual && meRender?.segs[0] && meRender.segs[1]) {
      const myHeadR = headRadiusForLength(myLen);
      const myBodyR = bodyRadiusForLength(myLen);
      boostSpawnAcc += dt * 110;
      while (boostSpawnAcc >= 1) {
        boostSpawnAcc -= 1;
        spawnBoostParticle(
          particles,
          meRender.segs[0],
          meRender.segs[1],
          meRender.color,
          myHeadR,
          myBodyR,
          meRender.dna,
          meSkill,
          meSkillActive,
        );
      }

      boostRingAcc += dt;
      if (boostRingAcc >= 0.12) {
        boostRingAcc = 0;
        const head = meRender.segs[0];
        const neck = meRender.segs[1];
        const ang = Math.atan2(head.y - neck.y, head.x - neck.x);
        const back = {
          x: head.x - Math.cos(ang) * (myHeadR * 0.95),
          y: head.y - Math.sin(ang) * (myHeadR * 0.95),
        };
        spawnBoostRing(particles, back, meRender.color, myHeadR * 0.62, meRender.dna);
      }
    } else {
      boostSpawnAcc = 0;
      boostRingAcc = 0;
    }

    if (meRender?.segs[0] && meRender.segs[1] && meSkill && meSkillActive) {
      skillFxAcc += dt;
      if (skillFxAcc >= 0.065) {
        skillFxAcc = 0;
        const myHeadR = headRadiusForLength(myLen);
        const myBodyR = bodyRadiusForLength(myLen);

        if (meSkill === 'ultimate_iron_charge') {
          // Heat + sparks
          spawnBoostParticle(
            particles,
            meRender.segs[0],
            meRender.segs[1],
            meRender.color,
            myHeadR,
            myBodyR,
            meRender.dna,
            meSkill,
            true,
          );
          spawnBoostRing(particles, meRender.segs[0], 0xff3b2f, myHeadR * 1.05, 'iron');
        } else if (meSkill === 'ultimate_shadow_phase' || meSkill === 'shadow_phantom_decoy') {
          // Neon sparks
          spawnBoostParticle(
            particles,
            meRender.segs[0],
            meRender.segs[1],
            meRender.color,
            myHeadR,
            myBodyR,
            meRender.dna,
            meSkill,
            true,
          );
          spawnBoostRing(particles, meRender.segs[0], 0x00e5ff, myHeadR * 0.9, 'shadow');
        } else if (meSkill === 'ultimate_magnetic_magnet') {
          // Gravity pulses
          spawnBoostRing(particles, meRender.segs[0], meRender.color, myHeadR * 1.2, 'magnetic');
        } else if (meSkill === 'ultimate_magnetic_overcharge') {
          spawnBoostRing(particles, meRender.segs[0], 0xa55cff, myHeadR * 1.05, 'magnetic');
        } else if (meSkill === 'ultimate_shadow_dash') {
          spawnBoostRing(particles, meRender.segs[0], 0xb000ff, myHeadR * 0.95, 'shadow');
        } else if (meSkill === 'ultimate_shadow_smokescreen') {
          spawnBoostRing(particles, meRender.segs[0], 0x0b0d12, myHeadR * 1.1, 'shadow');
        } else if (meSkill === 'iron_bunker_down') {
          spawnBoostRing(particles, meRender.segs[0], 0xeaf0ff, myHeadR * 0.9, 'iron');
        }
      }
    } else {
      skillFxAcc = 0;
    }

    // Particles: update + upload to GPU
    for (let i = particles.length - 1; i >= 0; i--) {
      const p = particles[i]!;
      p.life -= dt;
      if (p.life <= 0) {
        particles.splice(i, 1);
        continue;
      }

      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.vx *= 0.94;
      p.vy *= 0.94;

      if (p.kind === 'ring') {
        const grow = p.grow ?? 0;
        p.r += grow * dt;
      }
    }

    const particleCount = Math.min(PARTICLE_MAX, particles.length);
    for (let i = 0; i < particleCount; i++) {
      const p = particles[i]!;
      const lt = p.life / p.maxLife;
      const alpha = p.kind === 'ring' ? p.alpha * lt : p.alpha * lt * lt;

      tmpColor.setHex(p.color);
      particlePositions[i * 3 + 0] = p.x;
      particlePositions[i * 3 + 1] = 6 + p.r * 0.12;
      particlePositions[i * 3 + 2] = p.y;

      particleColors[i * 4 + 0] = tmpColor.r;
      particleColors[i * 4 + 1] = tmpColor.g;
      particleColors[i * 4 + 2] = tmpColor.b;
      particleColors[i * 4 + 3] = clamp(alpha, 0, 0.85);

      const baseSizeWorld = p.kind === 'spark' ? (p.len ?? 16) * 0.55 : p.kind === 'ring' ? p.r * 1.1 : p.r * 1.9;
      particleSizes[i] = clamp(baseSizeWorld * zoom, 2, 96);
    }

    particleGeometry.setDrawRange(0, particleCount);
    particlePosAttr.needsUpdate = true;
    particleColorAttr.needsUpdate = true;
    particleSizeAttr.needsUpdate = true;

    renderer.render(scene, camera3);
    requestAnimationFrame(tick);
  };

  requestAnimationFrame(tick);

  /* Legacy PixiJS input + render loop (2D, removed)
  // Input
  app.stage.eventMode = 'static';
  app.stage.hitArea = app.screen;

  app.stage.on('pointermove', (e) => {
    const cx = app.screen.width / 2;
    const cy = app.screen.height / 2;
    targetAngle = Math.atan2(e.global.y - cy, e.global.x - cx);
    sendInput();
  });

  window.addEventListener('resize', () => {
    app.stage.hitArea = app.screen;
  });

  window.addEventListener('keydown', (e) => {
    if (!mutationOverlay.classList.contains('hidden')) {
      if (e.code === 'Digit1') {
        chooseMutation(pendingChoices[0]);
        e.preventDefault();
      } else if (e.code === 'Digit2') {
        chooseMutation(pendingChoices[1]);
        e.preventDefault();
      } else if (e.code === 'Digit3') {
        chooseMutation(pendingChoices[2]);
        e.preventDefault();
      }
      return;
    }

    if (e.code !== 'Space') return;
    if (!menu.classList.contains('hidden')) return;
    boosting = true;
    sendInput(true);
    e.preventDefault();
  });

  window.addEventListener('keydown', (e) => {
    if (e.code !== 'KeyE') return;
    if (!menu.classList.contains('hidden')) return;
    tryUseSkill();
    e.preventDefault();
  });

  window.addEventListener('keyup', (e) => {
    if (e.code !== 'Space') return;
    boosting = false;
    sendInput(true);
  });

  window.addEventListener('pointerdown', (e) => {
    if (!menu.classList.contains('hidden')) return;
    if (e.button !== 0) return;
    if (e.target !== app.canvas) return;
    boosting = true;
    sendInput(true);
  });

  window.addEventListener('pointerup', (e) => {
    if (e.button !== 0) return;
    boosting = false;
    sendInput(true);
  });

  window.addEventListener('blur', () => {
    boosting = false;
    sendInput(true);
  });

  // Render loop (60fps): smooth positions + FX.
  let lastFrame = performance.now();
  app.ticker.add(() => {
    const now = performance.now();
    const dt = Math.min(0.05, (now - lastFrame) / 1000);
    lastFrame = now;
    const t = now / 1000;

    if (!latestState) return;

    const meRender = myId ? playerRenders.get(myId) : undefined;
    const meHead = meRender?.segs[0];
    const meState = myId ? latestState.players[myId] : undefined;
    const meTargetHead = meState?.segments[0];
    const myLen = meState?.segments.length ?? 0;
    const myDna = meState?.dna;
    const meSkill = meState ? findSkillMutation(meState.mutations) : undefined;
    const meSkillActive = meState?.skillActive ?? false;
    const eagleStacks = countMutation(meState?.mutations, 'eagle_eye');
    const fovMul = 1 + 0.15 * clamp(eagleStacks, 0, 3);
    const meBoostingVisual = boosting && myLen > MIN_SEGMENTS;

    if (meHead || meTargetHead) {
      const hx = meTargetHead?.x ?? meHead?.x ?? 0;
      const hy = meTargetHead?.y ?? meHead?.y ?? 0;
      const fovCapScale = myDna === 'magnetic' ? 1 / 1.2 : 1;
      const minZoom = Math.max((CAMERA_BASE_MIN_ZOOM * fovCapScale) / fovMul, CAMERA_ABS_MIN_ZOOM * fovCapScale);
      const baseZoom = clamp((1.22 - myLen / 175) / fovMul, minZoom, 1.14);
      const targetZoom = baseZoom * (meBoostingVisual ? 0.96 : 1);

      const camK = 14;
      const zK = 11;
      const a = smoothFactor(camK, dt);
      const za = smoothFactor(zK, dt);
      camera.x = lerp(camera.x, hx, a);
      camera.y = lerp(camera.y, hy, a);
      camera.zoom = lerp(camera.zoom, targetZoom, za);
    }

    const zoom = camera.zoom;
    world.scale.set(zoom);
    shake = Math.max(0, shake - dt * 2.3);
    const shakeAmp = shake * 10;
    const shakeX = Math.sin(t * 47.2) * shakeAmp;
    const shakeY = Math.cos(t * 53.9) * shakeAmp;
    world.position.set(
      app.screen.width / 2 - camera.x * zoom + shakeX,
      app.screen.height / 2 - camera.y * zoom + shakeY,
    );

    const viewHalfW = app.screen.width / 2 / zoom;
    const viewHalfH = app.screen.height / 2 / zoom;
    const view = {
      minX: camera.x - viewHalfW,
      maxX: camera.x + viewHalfW,
      minY: camera.y - viewHalfH,
      maxY: camera.y + viewHalfH,
    };

    // Smooth players
    const headAlpha = smoothFactor(55, dt);
    const bodyAlpha = smoothFactor(32, dt);
    const relaxAlpha = smoothFactor(12, dt) * 0.12;

    for (const [id, render] of playerRenders) {
      render.spawnFx = Math.max(0, render.spawnFx - dt * 1.4);
      render.container.alpha = clamp(1 - render.spawnFx * 0.45, 0.35, 1);

      if (render.segs.length > 0) {
        const tail = render.segs[render.segs.length - 1]!;
        if (!render.tailTip) {
          render.tailTip = { x: tail.x, y: tail.y };
        } else {
          const dx = render.tailTip.x - tail.x;
          const dy = render.tailTip.y - tail.y;
          if (dx * dx + dy * dy > 900 * 900) {
            render.tailTip.x = tail.x;
            render.tailTip.y = tail.y;
          } else {
            const a = smoothFactor(6, dt); // ~0.5s to settle
            render.tailTip.x = lerp(render.tailTip.x, tail.x, a);
            render.tailTip.y = lerp(render.tailTip.y, tail.y, a);
          }
        }
      }

      if (render.targetSegs.length > 0) {
        if (render.visualLen <= 0) {
          render.visualLen = render.targetSegs.length;
        } else {
          render.visualLen = lerp(render.visualLen, render.targetSegs.length, smoothFactor(6, dt));
        }
      }

      const len = render.segs.length;
      for (let i = 0; i < render.segs.length; i++) {
        const cur = render.segs[i]!;
        const target = render.targetSegs[i];
        if (!target) continue;

        if (i === 0) {
          const a = id === myId ? headAlpha : headAlpha * 0.92;
          cur.x = lerp(cur.x, target.x, a);
          cur.y = lerp(cur.y, target.y, a);
          continue;
        }

        const f = len <= 1 ? 1 : i / (len - 1);
        const a = bodyAlpha * (0.95 - f * 0.35);
        cur.x = lerp(cur.x, target.x, a);
        cur.y = lerp(cur.y, target.y, a);
      }
      constrainChain(render.segs, SEGMENT_SPACING);

      if (render.segs.length > 2) {
        for (let i = 1; i < render.segs.length - 1; i++) {
          const prev = render.segs[i - 1]!;
          const next = render.segs[i + 1]!;
          const cur = render.segs[i]!;
          cur.x = lerp(cur.x, (prev.x + next.x) * 0.5, relaxAlpha);
          cur.y = lerp(cur.y, (prev.y + next.y) * 0.5, relaxAlpha);
        }
      }

      constrainChain(render.segs, SEGMENT_SPACING);
    }

    for (const [, render] of decoyRenders) {
      render.spawnFx = Math.max(0, render.spawnFx - dt * 1.8);
      render.container.alpha = clamp(0.92 - render.spawnFx * 0.35, 0.45, 0.92);

      if (render.segs.length > 0) {
        const tail = render.segs[render.segs.length - 1]!;
        if (!render.tailTip) {
          render.tailTip = { x: tail.x, y: tail.y };
        } else {
          const dx = render.tailTip.x - tail.x;
          const dy = render.tailTip.y - tail.y;
          if (dx * dx + dy * dy > 900 * 900) {
            render.tailTip.x = tail.x;
            render.tailTip.y = tail.y;
          } else {
            const a = smoothFactor(6, dt);
            render.tailTip.x = lerp(render.tailTip.x, tail.x, a);
            render.tailTip.y = lerp(render.tailTip.y, tail.y, a);
          }
        }
      }

      const len = render.segs.length;
      for (let i = 0; i < render.segs.length; i++) {
        const cur = render.segs[i]!;
        const target = render.targetSegs[i];
        if (!target) continue;

        if (i === 0) {
          const a = headAlpha * 0.88;
          cur.x = lerp(cur.x, target.x, a);
          cur.y = lerp(cur.y, target.y, a);
          continue;
        }

        const f = len <= 1 ? 1 : i / (len - 1);
        const a = bodyAlpha * (0.9 - f * 0.3);
        cur.x = lerp(cur.x, target.x, a);
        cur.y = lerp(cur.y, target.y, a);
      }
      constrainChain(render.segs, SEGMENT_SPACING);
    }

    // Foods (culled)
    foodGfx.clear();
    const foodMargin = 260;
    for (const f of foods) {
      if (!isInsideView(f.x, f.y, view, foodMargin)) continue;

      const phase = foodPhase(f.id);
      const pulse = 0.86 + 0.14 * Math.sin(t * 2.6 + phase);
      const coreR = f.r * pulse;
      const glowR = f.r * (1.9 + 0.25 * pulse);

      foodGfx.beginFill(f.color, 0.14);
      foodGfx.drawCircle(f.x, f.y, glowR);
      foodGfx.endFill();

      foodGfx.beginFill(f.color, 0.92);
      foodGfx.drawCircle(f.x, f.y, coreR);
      foodGfx.endFill();

      foodGfx.beginFill(0xffffff, 0.22);
      foodGfx.drawCircle(f.x - coreR * 0.28, f.y - coreR * 0.28, Math.max(1.2, coreR * 0.32));
      foodGfx.endFill();
    }

    // Gas (culled)
    gasGfx.clear();
    const gasMargin = 340;
    const gasPos = meRender?.segs[0] ?? meTargetHead;
    let insideGas = false;
    for (const g of gas) {
      if (!isInsideView(g.x, g.y, view, g.r + gasMargin)) continue;

      gasGfx.beginFill(0x000000, 0.08);
      gasGfx.drawCircle(g.x, g.y, g.r * 1.25);
      gasGfx.endFill();

      gasGfx.beginFill(0x0b0d12, 0.12);
      gasGfx.drawCircle(g.x, g.y, g.r);
      gasGfx.endFill();

      gasGfx.lineStyle(2, 0xffffff, 0.03);
      gasGfx.drawCircle(g.x, g.y, g.r + 2);
      gasGfx.lineStyle(0);

      if (gasPos) {
        const dx = gasPos.x - g.x;
        const dy = gasPos.y - g.y;
        if (dx * dx + dy * dy <= g.r * g.r) insideGas = true;
      }
    }

    if (!menu.classList.contains('hidden')) {
      uiRoot.classList.remove('gas');
    } else {
      uiRoot.classList.toggle('gas', insideGas);
    }

    glowGfx.clear();
    if (myDna === 'magnetic') {
      const head = meRender?.segs[0] ?? meTargetHead;
      if (head) {
        const myHeadR = headRadiusForLength(myLen);
        const pullR = meSkill === 'ultimate_magnetic_magnet' && meSkillActive ? 1080 : 520;
        const pullR2 = pullR * pullR;
        const maxLines = meSkill === 'ultimate_magnetic_magnet' && meSkillActive ? 120 : 70;
        let drawn = 0;

        for (const f of foods) {
          if (drawn >= maxLines) break;
          const dx = head.x - f.x;
          const dy = head.y - f.y;
          const d2 = dx * dx + dy * dy;
          if (d2 > pullR2 || d2 === 0) continue;
          if (!isInsideView(f.x, f.y, view, 160)) continue;

          const d = Math.sqrt(d2);
          const ux = dx / d;
          const uy = dy / d;
          const intensity = 1 - d / pullR;

          const c = mixColor(0x8cff00, 0xa55cff, 0.5 + 0.5 * Math.sin(t * 1.1 + foodPhase(f.id)));
          const a = clamp(0.02 + intensity * 0.05, 0, 0.1);

          glowGfx.beginPath();
          glowGfx.moveTo(f.x, f.y);
          glowGfx.lineTo(f.x + ux * (18 + intensity * 34), f.y + uy * (18 + intensity * 34));
          glowGfx.stroke({ width: 2, color: c, alpha: a });

          glowGfx.beginFill(c, a * 0.8);
          glowGfx.drawCircle(f.x + ux * (myHeadR * 0.2), f.y + uy * (myHeadR * 0.2), Math.max(1.2, f.r * 0.18));
          glowGfx.endFill();

          drawn++;
        }
      }
    }

    // Players (culled) - check segments so long tails don't become "invisible walls".
    const playerShowMargin = 900;
    const playerHideMargin = 1250;
    for (const [id, render] of playerRenders) {
      const segsForCull = render.targetSegs.length > 0 ? render.targetSegs : render.segs;
      if (segsForCull.length === 0) continue;

      const margin = render.container.visible ? playerHideMargin : playerShowMargin;
      const visible = id === myId || isAnySegmentInsideView(segsForCull, view, margin);
      render.container.visible = visible;
      if (!visible) continue;

      const head = render.segs[0] ?? render.targetSegs[0];
      if (!head) continue;

      const boostingVisual = id === myId ? meBoostingVisual : render.boosting;
      const stealthVisual = id === myId ? false : render.stealth;
      const phaseVisual = id === myId ? false : render.phase;
      const skill = findSkillMutation(render.mutations);
      drawWorm(
        render.body,
        render.segs,
        render.color,
        boostingVisual,
        id === myId,
        t,
        render.spawnFx,
        render.visualLen,
        render.tailTip,
        render.dna,
        render.armor,
        stealthVisual,
        phaseVisual,
        skill,
        render.skillActive,
        false,
      );

      const glowLen = render.visualLen || render.segs.length;
      const glowHeadR = headRadiusForLength(glowLen);
      const glowColor =
        render.dna === 'shadow'
          ? mixColor(0x00e5ff, 0xb000ff, 0.5 + 0.5 * Math.sin(t * 1.35 + glowLen * 0.05))
          : render.dna === 'iron'
            ? skill === 'ultimate_iron_charge' && render.skillActive
              ? 0xff3b2f
              : mixColor(render.color, 0xffb15a, 0.65)
            : mixColor(render.color, 0xa55cff, 0.55);
      const glowRadius = glowHeadR * (render.dna === 'shadow' ? 2.4 : render.dna === 'iron' ? 2.0 : 2.6);
      const glowAlpha =
        (boostingVisual ? 0.08 : 0.055) +
        (render.skillActive ? 0.06 : 0) +
        (id === myId ? 0.02 : 0) -
        (stealthVisual ? 0.06 : 0);
      if (glowAlpha > 0.01) {
        glowGfx.beginFill(glowColor, clamp(glowAlpha * (phaseVisual ? 0.25 : 1), 0, 0.22));
        glowGfx.drawCircle(head.x, head.y, glowRadius);
        glowGfx.endFill();
      }

      render.nameText.text = render.name;
      render.nameText.position.set(head.x, head.y - headRadiusForLength(render.visualLen || render.segs.length) - 6);

      const camDist = Math.hypot(head.x - camera.x, head.y - camera.y);
      const baseNameAlpha = clamp(1 - camDist / 1800, 0.15, 1);
      render.nameText.alpha = baseNameAlpha * (stealthVisual || phaseVisual ? 0 : 1);
    }

    // Decoys (culled)
    for (const [, render] of decoyRenders) {
      const segsForCull = render.targetSegs.length > 0 ? render.targetSegs : render.segs;
      if (segsForCull.length === 0) continue;

      const margin = render.container.visible ? playerHideMargin : playerShowMargin;
      const visible = isAnySegmentInsideView(segsForCull, view, margin);
      render.container.visible = visible;
      if (!visible) continue;

      const head = render.segs[0] ?? render.targetSegs[0];
      if (!head) continue;

      drawWorm(
        render.body,
        render.segs,
        render.color,
        false,
        false,
        t,
        render.spawnFx,
        render.visualLen,
        render.tailTip,
        render.dna,
        0,
        false,
        false,
        undefined,
        false,
        true,
      );

      const glowLen = render.visualLen || render.segs.length;
      const glowHeadR = headRadiusForLength(glowLen);
      const glowColor = mixColor(render.color, 0xb000ff, 0.4);
      const glowRadius = glowHeadR * 2.1;
      glowGfx.beginFill(glowColor, 0.045);
      glowGfx.drawCircle(head.x, head.y, glowRadius);
      glowGfx.endFill();

      render.nameText.text = render.name;
      render.nameText.position.set(head.x, head.y - headRadiusForLength(render.visualLen || render.segs.length) - 6);

      const camDist = Math.hypot(head.x - camera.x, head.y - camera.y);
      const baseNameAlpha = clamp(1 - camDist / 1800, 0.15, 1);
      render.nameText.alpha = baseNameAlpha * 0.85;
    }

    // Minimap (10fps)
    if (minimapCtx && minimapEl) {
      minimapAcc += dt;
      if (minimapAcc >= 0.1) {
        minimapAcc = 0;

        const w = minimapEl.width;
        const h = minimapEl.height;
        minimapCtx.clearRect(0, 0, w, h);

        minimapCtx.fillStyle = 'rgba(10, 12, 18, 0.55)';
        minimapCtx.fillRect(0, 0, w, h);

        const halfW = latestState.world.width / 2;
        const halfH = latestState.world.height / 2;
        const pad = 6;
        const innerW = w - pad * 2;
        const innerH = h - pad * 2;
        const cx = pad + innerW / 2;
        const cy = pad + innerH / 2;
        const arenaR = Math.min(innerW, innerH) / 2;

        const mapX = (x: number) => pad + clamp((x + halfW) / (halfW * 2), 0, 1) * innerW;
        const mapY = (y: number) => pad + clamp((y + halfH) / (halfH * 2), 0, 1) * innerH;

        minimapCtx.save();
        minimapCtx.beginPath();
        minimapCtx.arc(cx, cy, arenaR, 0, Math.PI * 2);
        minimapCtx.clip();

        // Viewport rectangle
        const vx1 = mapX(view.minX);
        const vy1 = mapY(view.minY);
        const vx2 = mapX(view.maxX);
        const vy2 = mapY(view.maxY);
        minimapCtx.strokeStyle = 'rgba(255, 255, 255, 0.55)';
        minimapCtx.lineWidth = 1;
        minimapCtx.strokeRect(vx1, vy1, vx2 - vx1, vy2 - vy1);

        // Players
        for (const [id, render] of playerRenders) {
          if (id !== myId && (render.stealth || render.phase)) continue;
          const head = render.segs[0] ?? render.targetSegs[0];
          if (!head) continue;
          const x = mapX(head.x);
          const y = mapY(head.y);
          const baseR = id === myId ? 3.1 : 2.0;
          const len = render.visualLen || render.segs.length;
          const r = baseR + sizeExtraForLength(len) * 0.18;

          minimapCtx.globalAlpha = 0.9;
          minimapCtx.fillStyle = cssHexColor(render.color);
          minimapCtx.beginPath();
          minimapCtx.arc(x, y, r, 0, Math.PI * 2);
          minimapCtx.fill();

          if (id === myId) {
            minimapCtx.globalAlpha = 0.95;
            minimapCtx.strokeStyle = 'rgba(255, 255, 255, 0.9)';
            minimapCtx.lineWidth = 1.5;
            minimapCtx.beginPath();
            minimapCtx.arc(x, y, r + 2.1, 0, Math.PI * 2);
            minimapCtx.stroke();
          }
        }

        // Decoys
        for (const [, render] of decoyRenders) {
          const head = render.segs[0] ?? render.targetSegs[0];
          if (!head) continue;
          const x = mapX(head.x);
          const y = mapY(head.y);
          const baseR = 2.0;
          const len = render.visualLen || render.segs.length;
          const r = baseR + sizeExtraForLength(len) * 0.18;

          minimapCtx.globalAlpha = 0.9;
          minimapCtx.fillStyle = cssHexColor(render.color);
          minimapCtx.beginPath();
          minimapCtx.arc(x, y, r, 0, Math.PI * 2);
          minimapCtx.fill();
        }

        minimapCtx.restore();

        // Border
        minimapCtx.globalAlpha = 1;
        minimapCtx.strokeStyle = 'rgba(255, 255, 255, 0.22)';
        minimapCtx.lineWidth = 1.4;
        minimapCtx.beginPath();
        minimapCtx.arc(cx, cy, arenaR, 0, Math.PI * 2);
        minimapCtx.stroke();
      }
    }

    // Particles
    if (meBoostingVisual && meRender?.segs[0] && meRender.segs[1]) {
      const myHeadR = headRadiusForLength(myLen);
      const myBodyR = bodyRadiusForLength(myLen);
      boostSpawnAcc += dt * 110;
      while (boostSpawnAcc >= 1) {
        boostSpawnAcc -= 1;
        spawnBoostParticle(
          particles,
          meRender.segs[0],
          meRender.segs[1],
          meRender.color,
          myHeadR,
          myBodyR,
          meRender.dna,
          meSkill,
          meSkillActive,
        );
      }

      boostRingAcc += dt;
      if (boostRingAcc >= 0.12) {
        boostRingAcc = 0;
        const head = meRender.segs[0];
        const neck = meRender.segs[1];
        const ang = Math.atan2(head.y - neck.y, head.x - neck.x);
        const back = {
          x: head.x - Math.cos(ang) * (myHeadR * 0.95),
          y: head.y - Math.sin(ang) * (myHeadR * 0.95),
        };
        spawnBoostRing(particles, back, meRender.color, myHeadR * 0.62, meRender.dna);
      }
    } else {
      boostSpawnAcc = 0;
      boostRingAcc = 0;
    }

    if (meRender?.segs[0] && meRender.segs[1] && meSkill && meSkillActive) {
      skillFxAcc += dt;
      if (skillFxAcc >= 0.065) {
        skillFxAcc = 0;
        const myHeadR = headRadiusForLength(myLen);
        const myBodyR = bodyRadiusForLength(myLen);

        if (meSkill === 'ultimate_iron_charge') {
          // Heat + sparks
          spawnBoostParticle(
            particles,
            meRender.segs[0],
            meRender.segs[1],
            meRender.color,
            myHeadR,
            myBodyR,
            meRender.dna,
            meSkill,
            true,
          );
        } else if (meSkill === 'iron_bunker_down') {
          spawnBoostRing(particles, meRender.segs[0], 0xeaf0ff, myHeadR * 0.8, 'iron');
        } else if (meSkill === 'shadow_phantom_decoy' || meSkill === 'ultimate_shadow_phase') {
          const head = meRender.segs[0];
          const a = rand(-Math.PI, Math.PI);
          const sp = rand(100, 260);
          const life = rand(0.12, 0.22);
          particles.push({
            kind: 'spark',
            x: head.x + rand(-6, 6),
            y: head.y + rand(-6, 6),
            vx: Math.cos(a) * sp,
            vy: Math.sin(a) * sp,
            r: 1,
            len: rand(10, 22),
            rot: a,
            life,
            maxLife: life,
            color: mixColor(0x00e5ff, 0xb000ff, Math.random()),
            alpha: rand(0.14, 0.26),
            lineWidth: rand(1.1, 2.0),
          });
        } else if (meSkill === 'ultimate_magnetic_magnet') {
          spawnBoostRing(particles, meRender.segs[0], meRender.color, myHeadR * 1.1, 'magnetic');
        }
      }
    } else {
      skillFxAcc = 0;
    }

    particleGfx.clear();
    for (let i = particles.length - 1; i >= 0; i--) {
      const p = particles[i]!;
      p.life -= dt;
      if (p.life <= 0) {
        particles.splice(i, 1);
        continue;
      }

      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.vx *= 0.94;
      p.vy *= 0.94;

      const lt = p.life / p.maxLife;
      if (p.kind === 'ring') {
        const grow = p.grow ?? 0;
        p.r += grow * dt;
        const a = p.alpha * lt;
        particleGfx.lineStyle(p.lineWidth ?? 2, p.color, a);
        particleGfx.drawCircle(p.x, p.y, p.r);
        particleGfx.lineStyle(0);
      } else if (p.kind === 'spark') {
        const a = p.alpha * lt * lt;
        const rot = p.rot ?? 0;
        const len = p.len ?? p.r * 6;
        const hx = Math.cos(rot) * (len * 0.5);
        const hy = Math.sin(rot) * (len * 0.5);
        particleGfx.beginPath();
        particleGfx.moveTo(p.x - hx, p.y - hy);
        particleGfx.lineTo(p.x + hx, p.y + hy);
        particleGfx.stroke({ width: p.lineWidth ?? 2, color: p.color, alpha: a, cap: 'round' });
      } else if (p.kind === 'square') {
        const a = p.alpha * lt * lt;
        particleGfx.beginFill(p.color, a);
        particleGfx.drawRect(p.x - p.r, p.y - p.r, p.r * 2, p.r * 2);
        particleGfx.endFill();
      } else {
        const a = p.alpha * lt * lt;
        particleGfx.beginFill(p.color, a);
        particleGfx.drawCircle(p.x, p.y, p.r);
        particleGfx.endFill();
      }
    }
  });

  */

  // Quick boot: focus name input on load.
  nameInput.focus();
}

void main();
