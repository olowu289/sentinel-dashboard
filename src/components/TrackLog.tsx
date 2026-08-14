import { useEffect, useRef, useState } from 'react';
import {
  cameraClass, cameraLabel, formatBearing, formatElevation, formatRange,
  formatRate, isMeasuredRange, rangeTitle, rateTitle, trackTime,
  type TrackEvent,
} from '../trackLog';

interface Props {
  events: TrackEvent[];
  connected: boolean;
}

/**
 * The tower's live track log.
 *
 * Sits in the console beside the video, because the question it answers —
 * "what is the tower doing right now, and where is the thing it found?" — is
 * one an operator should never have to leave the wall to ask.
 *
 * TOWER-WIDE, not per camera. Every camera writes into one list, which is why
 * each row names its own.
 *
 * TWO ENCODINGS, KEPT APART. The left edge carries severity (what happened) and
 * the camera chip carries identity (who it happened to). Putting both on the
 * left edge made each harder to read, so position means one thing and colour
 * means the other.
 */
export default function TrackLog({ events, connected }: Props) {
  const rowsRef = useRef<HTMLDivElement>(null);
  // Following means "pinned to the newest". Scroll up to read back and the log
  // stops chasing you; scroll to the bottom and it resumes. A log that always
  // jumps to the end makes it impossible to read what just went past.
  const [following, setFollowing] = useState(true);

  useEffect(() => {
    const el = rowsRef.current;
    if (el && following) el.scrollTop = el.scrollHeight;
  }, [events, following]);

  const onScroll = () => {
    const el = rowsRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
    setFollowing(atBottom);
  };

  return (
    <section className="tracklog" aria-label="Track log, all cameras">
      <div className="tracklog-head">
        <span className="tracklog-cap">TRACK LOG · ALL CAMERAS</span>
        <span className={`tracklog-live${connected ? '' : ' off'}`}>
          <i />
          {connected ? 'LIVE' : 'NO STREAM'}
        </span>
      </div>

      {/* BRG/ELEV/RNG together answer "where is it"; RATE answers "which way is
          it going". RNG is titled EST because every range this tower can
          produce today is an estimate, and a column header is the cheapest
          place to say so once instead of per row. */}
      <div className="tracklog-cols" aria-hidden="true">
        <span>TIME</span><span>CAM</span><span>EVENT</span><span>DETAIL</span>
        <span className="r">BRG</span><span className="r">ELEV</span>
        <span className="r">EST RNG</span><span className="r">°/S</span>
      </div>

      <div className="tracklog-rows" ref={rowsRef} onScroll={onScroll} role="log" aria-live="polite">
        {events.length === 0 && (
          <div className="tracklog-empty">
            {connected
              ? 'Nothing yet. Events appear here the moment a camera sees something.'
              : 'Not receiving events from the tower.'}
          </div>
        )}
        {events.map((e) => (
          <div key={e.id} className={`tracklog-row k-${e.kind.toLowerCase()}`}>
            <span className="t">{trackTime(e.ts)}</span>
            <span className={`c ${cameraClass(e.camera)}`}>{cameraLabel(e.camera)}</span>
            <span className="e">
              {e.kind}
              {/* Marks the rows the Alerts view also shows — the same event,
                  not a copy of it. */}
              {e.severity !== 'info' && <span className="dot">●</span>}
            </span>
            <span className="d" title={e.detail}>{e.detail}</span>
            <span className="b">{formatBearing(e.bearingDeg)}</span>
            <span className="v">{formatElevation(e.elevationDeg)}</span>
            {/* Dimmed unless the range was actually measured. The "~" already
                says it, but colour carries it at a glance, which is how a log
                gets read. */}
            <span
              className={`g${e.rangeM != null && !isMeasuredRange(e.rangeSource) ? ' est' : ''}`}
              title={rangeTitle(e.rangeM, e.rangeSource)}
            >
              {formatRange(e.rangeM, e.rangeSource)}
            </span>
            <span className="w" title={rateTitle(e.bearingRateDegS)}>
              {formatRate(e.bearingRateDegS)}
            </span>
          </div>
        ))}
      </div>

      <div className="tracklog-foot">
        <span className="tracklog-key">
          <em className="c1">CAM 01</em>
          <em className="c2">CAM 02</em>
          <em className="rf">RF</em>
        </span>
        {following ? (
          <span>{events.length} events</span>
        ) : (
          <button type="button" className="tracklog-jump" onClick={() => setFollowing(true)}>
            jump to newest ↓
          </button>
        )}
      </div>
    </section>
  );
}
