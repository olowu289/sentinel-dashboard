import { useEffect, useState } from 'react';
import {
  AI_ALERT_ENABLED,
  pruneStaleSightings,
  subscribeDetectionSightings,
  type ClassSighting,
} from '../aiDetectionAlert';

interface Props {
  /** True while TargetCueBanner is also showing, so this one stacks below it
   * instead of overlapping it — both are fixed to the viewport top. */
  pushDown?: boolean;
}

/**
 * Global, app-wide banner mirroring TargetCueBanner's visual language (same
 * fixed-top placement, flash-then-hold treatment, monospace all-caps label)
 * for AI detections instead of RF targeting cues. Always mounted (unlike
 * TargetCueBanner's conditional mount) so CSS can transition it in/out
 * instead of hard-cutting — see .ai-detect-banner's opacity transition in
 * styles.css for the "flash once, hold, fade" behavior the task called for.
 *
 * Class-agnostic by construction: the label comes straight from each
 * ClassSighting's `name`, which itself comes straight from the wire
 * message's `detection.name` (see aiDetectionAlert.ts / aiOverlay.ts) —
 * there is no "drone" string anywhere in this component.
 */
export default function AiDetectionBanner({ pushDown }: Props) {
  const [sightings, setSightings] = useState<ClassSighting[]>([]);

  useEffect(() => {
    if (!AI_ALERT_ENABLED) return;
    const unsubscribe = subscribeDetectionSightings(setSightings);
    const timer = window.setInterval(() => pruneStaleSightings(Date.now()), 1000);
    return () => {
      unsubscribe();
      window.clearInterval(timer);
    };
  }, []);

  if (!AI_ALERT_ENABLED) return null;

  const active = sightings.length > 0;
  const label = sightings
    .slice()
    .sort((a, b) => b.conf - a.conf)
    .map((s) => `${s.name.toUpperCase()} (${Math.round(s.conf * 100)}%)`)
    .join(', ');

  return (
    <div
      className={`ai-detect-banner${active ? ' ai-detect-banner--active' : ''}${pushDown ? ' ai-detect-banner--pushed' : ''}`}
      role="alert"
      aria-hidden={!active}
    >
      <span className="ai-detect-dot" aria-hidden="true" />
      {label && `DETECTED: ${label}`}
    </div>
  );
}
