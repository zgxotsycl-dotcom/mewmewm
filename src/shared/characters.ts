import type { WormClass, WormSkin } from './protocol';

export type SkinDef = {
  title: string;
  role: WormClass;
  theme: string;
  desc: string;
  accent: number;
  palette: number[];
};

export const SKIN_ORDER: WormSkin[] = [
  'viper',
  'eel',
  'venom',
  'scarab',
  'frost',
  'plasma',
  'chrono',
  'mirage',
  'void',
];

export const SKIN_DEFS: Record<WormSkin, SkinDef> = {
  viper: {
    title: 'Viper',
    role: 'shadow',
    theme: 'Noxus',
    desc: 'Blood & steel. Red metal plating with an axe-blade crest.',
    accent: 0xd31f2a,
    palette: [0xd31f2a, 0x7a0b10, 0xffd34d, 0x2b0a0d, 0xff3b2f, 0xb3121c],
  },
  eel: {
    title: 'Eel',
    role: 'shadow',
    theme: 'Resistance',
    desc: 'Hydro-mech eel. Sleek body with blue current and electric sparks.',
    accent: 0x00b7ff,
    palette: [0x0e1220, 0x13233b, 0x00b7ff, 0x5cf2ff, 0x00e5ff, 0x2b8dff],
  },
  venom: {
    title: 'Venom',
    role: 'shadow',
    theme: 'Zaun',
    desc: 'Toxic rig. Gas-mask head with neon green hoses and stained metal.',
    accent: 0x86ff00,
    palette: [0x232a2e, 0x3b464d, 0x86ff00, 0x2fff8e, 0xa55cff, 0x1a1f22],
  },
  scarab: {
    title: 'Scarab',
    role: 'iron',
    theme: 'Shurima',
    desc: 'Ascended gold shell. Wide carapace plates with warm sun highlights.',
    accent: 0xffd34d,
    palette: [0xffd34d, 0xb98b2f, 0x2b303b, 0xffb15a, 0xf7f0d8, 0x8a5a15],
  },
  frost: {
    title: 'Frost',
    role: 'iron',
    theme: 'Freljord',
    desc: 'True ice. Translucent crystal with sharp ice shards.',
    accent: 0x7be7ff,
    palette: [0x7be7ff, 0xb7f6ff, 0x0d2533, 0x9fbaff, 0xffffff, 0x2bf7ff],
  },
  plasma: {
    title: 'Plasma',
    role: 'magnetic',
    theme: 'PROJECT',
    desc: 'Cybernetic drone. Matte black body with laser neon points.',
    accent: 0xff2df7,
    palette: [0x101018, 0x151a22, 0xff2df7, 0x00e5ff, 0xff3b2f, 0xffffff],
  },
  chrono: {
    title: 'Chrono',
    role: 'magnetic',
    theme: 'Hextech',
    desc: 'Brass & crystal. Clockwork rings and a glowing core.',
    accent: 0xffb15a,
    palette: [0xffb15a, 0x7a5a2b, 0x00e5ff, 0x9fbaff, 0xffd34d, 0x2b303b],
  },
  mirage: {
    title: 'Mirage',
    role: 'magnetic',
    theme: 'Arcade',
    desc: 'Hologram glitch. Iridescent highlights and pixel-cut parts.',
    accent: 0x9fbaff,
    palette: [0xff4dff, 0x00e5ff, 0x8cff00, 0xffd34d, 0xffffff, 0x4d6bff],
  },
  void: {
    title: 'Void',
    role: 'magnetic',
    theme: 'Void',
    desc: 'Abyssal purple. Organic curves with embedded glowing eyes.',
    accent: 0xa55cff,
    palette: [0x1b0526, 0x3a0a66, 0xa55cff, 0xff007f, 0x00e5ff, 0x0b0d12],
  },
};

export const DEFAULT_SKIN_FOR_CLASS: Record<WormClass, WormSkin> = {
  iron: 'scarab',
  shadow: 'viper',
  magnetic: 'plasma',
};

export const SKINS_BY_CLASS: Record<WormClass, WormSkin[]> = {
  shadow: ['viper', 'eel', 'venom'],
  iron: ['scarab', 'frost'],
  magnetic: ['plasma', 'chrono', 'mirage', 'void'],
};

export function classForSkin(skin: WormSkin): WormClass {
  return SKIN_DEFS[skin]?.role ?? 'shadow';
}

export function defaultSkinForClass(dna: WormClass): WormSkin {
  return DEFAULT_SKIN_FOR_CLASS[dna] ?? 'viper';
}

export function randomSkinForClass(dna: WormClass): WormSkin {
  const list = SKINS_BY_CLASS[dna] ?? SKINS_BY_CLASS.shadow;
  const pick = list[Math.floor(Math.random() * list.length)];
  return pick ?? defaultSkinForClass(dna);
}

export function sanitizeSkin(input: unknown): WormSkin {
  if (typeof input !== 'string') return 'viper';
  if ((SKIN_DEFS as Record<string, SkinDef>)[input]) return input as WormSkin;
  return 'viper';
}

export function randomColorForSkin(skin: WormSkin): number {
  const def = SKIN_DEFS[skin];
  if (!def || def.palette.length === 0) return 0xffffff;
  const pick = def.palette[Math.floor(Math.random() * def.palette.length)];
  return pick ?? def.accent;
}
