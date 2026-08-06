/** Per-tile live-video telemetry, reported by whichever transport (HLS or
 * WebRTC) is currently playing a camera tile — shown in the tile footer. */
export interface TileStats {
  fps: number | null;
  lossPct: number | null;
  driftSec: number | null;
}
