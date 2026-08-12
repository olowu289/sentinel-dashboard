interface Props {
  originLabel: string;
  towerLabel: string;
  camera: number;
}

/**
 * Global, app-wide banner — mounted once in FleetApp, above the Rail/view
 * switch, so it's visible no matter which page (Live wall/Sensors/Alerts)
 * is on screen. Purely presentational: FleetApp owns deciding when a
 * target-cue alert is still "active" (see TargetCueAlert in useTowerLive.ts)
 * and unmounts this when it expires.
 */
export default function TargetCueBanner({ originLabel, towerLabel, camera }: Props) {
  return (
    <div className="target-cue-banner" role="alert">
      <span className="target-cue-dot" aria-hidden="true" />
      {originLabel.toUpperCase()} SIGNAL &rarr; {towerLabel} &rarr; CAMERA {camera} MOVING TO TARGET
    </div>
  );
}
