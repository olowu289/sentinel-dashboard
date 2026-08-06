// Palette + type — "modern ops console" redesign (Claude Design handoff,
// design_handoff_sentinel_console). Values are the handoff's Design Tokens
// section, kept 1:1 so components can reference them instead of re-deriving.

export const colors = {
  // surfaces
  bg: '#07080a', // page
  bgChrome: '#0a0b0e', // rail, top bar
  bgStrip: '#08090c', // sensor strip
  bgChip: '#0d0f13', // sensor chip / inset
  bgCard: '#111419', // readout card inset
  bgPreset: '#0f1216',
  bgTile: '#0b0d11', // camera tile
  bgControl: '#161a21', // PTZ arrow buttons
  bgAvatar: '#1b1e25',
  bgSliderTrack: '#1a1e25',
  panelGradient: 'linear-gradient(180deg,#0e1116,#0a0c10)',
  padGradient: 'radial-gradient(circle at 50% 40%, #14181f, #0c0e13 70%)',

  // legacy aliases still referenced by a few components
  bgPanel: '#0a0b0e',
  bgWell: '#111419',
  feedTop: '#12161b',
  feedMid: '#0e1116',
  feedBot: '#0b0d11',

  // borders
  line: 'rgba(255,255,255,.06)', // hairline
  line2: 'rgba(255,255,255,.07)', // default
  lineRaised: 'rgba(255,255,255,.09)',
  bracketIdle: 'rgba(255,255,255,.07)',

  // text
  textBright: '#e6e8ec', // primary
  textStrong: '#dfe2e8',
  text: '#cfd3da', // secondary
  textDim: '#9aa1ad', // tertiary
  textFaint: '#8b929e',
  textCaption: '#5f6673',
  textCaption2: '#6d7482',
  textDisabled: '#4d5462',
  onAccent: '#0b0b10',

  // accent (violet)
  accent: 'oklch(0.78 0.13 275)', // primary
  accentDeep: 'oklch(0.62 0.17 292)', // gradient partner
  accentMark: 'oklch(0.72 0.16 275)', // logo mark / live dot
  accentText: '#c3c8ff',
  accentTint08: 'rgba(120,130,255,.08)',
  accentTint14: 'rgba(140,150,255,.14)',
  accentTint16: 'rgba(120,130,255,.16)',
  accentTint18: 'rgba(120,130,255,.18)',
  accentTint20: 'rgba(120,130,255,.2)',
  accentBorder: 'rgba(150,160,255,.22)',
  accentBorderStrong: 'rgba(150,160,255,.55)',

  // status
  standby: 'oklch(0.78 0.14 80)', // amber / warn
  offline: 'oklch(0.65 0.19 20)', // red dot
  offlineText: 'oklch(0.72 0.16 22)',
  offlineLabel: 'oklch(0.62 0.17 22)',
  online: 'oklch(0.75 0.14 155)', // green / ok
  rec: 'oklch(0.65 0.19 20)',
  recText: 'oklch(0.78 0.15 22)',
  haloOk: 'rgba(90,220,150,.1)',
  haloWarn: 'rgba(240,190,90,.12)',
  haloAlert: 'rgba(255,90,90,.12)',
} as const;

export const font = {
  display: "'IBM Plex Sans', system-ui, sans-serif",
  mono: "'IBM Plex Mono', ui-monospace, monospace",
} as const;

export const radius = {
  badge: 4,
  chip: 6,
  btn: 7,
  pill: 8,
  rail: 9,
  inset: 10,
  recRow: 11,
  tile: 14,
} as const;
