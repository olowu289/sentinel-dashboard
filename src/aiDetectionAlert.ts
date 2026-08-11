import type { Detection } from './aiOverlay';

/**
 * Class-agnostic detection-alert store. AiOverlayCanvas (mounted deep inside
 * DashboardConsole -> TowerFeed, one per camera tile) reports live
 * detections here via reportDetections(); AiDetectionBanner (mounted once,
 * top-level, alongside TargetCueBanner) subscribes. A tiny pub/sub singleton
 * rather than threading a prop/context down and back up: there's exactly one
 * producer today (cam1) and the consumer sits several component layers above
 * it with no shared parent state already carrying this.
 *
 * Deliberately reads whatever `detection.name` the wire message carries —
 * never a hardcoded class string — so this works unchanged for "drone"
 * today or "car"/"person"/anything else a future model emits.
 */

const RAW_ENABLED = (import.meta.env.VITE_AI_ALERT_ENABLED as string | undefined)?.trim().toLowerCase();
export const AI_ALERT_ENABLED = RAW_ENABLED !== 'false' && RAW_ENABLED !== '0';

const RAW_CONF = (import.meta.env.VITE_AI_ALERT_CONF as string | undefined)?.trim();
const PARSED_CONF = RAW_CONF ? Number(RAW_CONF) : NaN;
/**
 * Confidence a detection must clear to trigger the page-wide banner —
 * deliberately separate from AI_VIEW_MIN_CONF (aiConfig.ts), which only
 * gates whether a box gets drawn on a tile. This gates a much louder signal,
 * so it defaults higher.
 */
export const AI_ALERT_MIN_CONF = Number.isFinite(PARSED_CONF) ? PARSED_CONF : 0.6;

/**
 * How long a class stays shown after its last qualifying detection before
 * the banner fades it out. Long enough to ride out normal per-frame gaps
 * (detect_every_n skips, brief occlusion, a WS hiccup) without flickering
 * on/off like a strobe every time one frame dips under threshold.
 */
export const AI_ALERT_HOLD_MS = 4000;

export interface ClassSighting {
  name: string;
  conf: number;
  lastSeenMs: number;
}

type Listener = (sightings: ClassSighting[]) => void;

const sightings = new Map<string, ClassSighting>();
const listeners = new Set<Listener>();

function notify(): void {
  const list = Array.from(sightings.values());
  listeners.forEach((l) => l(list));
}

/**
 * Called for every detection message. Keyed by `d.name` (whatever class
 * label the model/engine emits) so multiple simultaneously-detected classes
 * each get their own held sighting rather than clobbering one another.
 */
export function reportDetections(detections: Detection[], nowMs: number): void {
  if (!AI_ALERT_ENABLED || detections.length === 0) return;
  let changed = false;
  for (const d of detections) {
    if (d.conf < AI_ALERT_MIN_CONF) continue;
    sightings.set(d.name, { name: d.name, conf: d.conf, lastSeenMs: nowMs });
    changed = true;
  }
  if (changed) notify();
}

/** Drops classes not seen within AI_ALERT_HOLD_MS. Call on a ~1s tick. */
export function pruneStaleSightings(nowMs: number): void {
  let changed = false;
  for (const [name, s] of sightings) {
    if (nowMs - s.lastSeenMs > AI_ALERT_HOLD_MS) {
      sightings.delete(name);
      changed = true;
    }
  }
  if (changed) notify();
}

export function subscribeDetectionSightings(listener: Listener): () => void {
  listeners.add(listener);
  listener(Array.from(sightings.values()));
  return () => {
    listeners.delete(listener);
  };
}
