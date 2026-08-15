import { useCallback, useEffect, useRef, useState } from 'react';
import {
  fetchCalibrationJob, fetchCalibrationStatus, runCalibrationStep,
  STEP_HELP, STEP_NEEDS_INPUT,
  type CalibrationJob, type CalibrationStatus,
} from '../calibrationApi';

interface Props {
  open: boolean;
  onClose: () => void;
  /** The towers this console can reach. One today; the selector exists so
   *  adding a second is a data change rather than a redesign. */
  towers: Array<{ id: string; label: string }>;
}

type Section = 'calibration' | 'tower';

/**
 * Settings — a floating panel, not a page.
 *
 * Deliberately a modal: settings are something you dip into and leave, and
 * navigating away from the live wall to change one is exactly the wrong
 * trade for an operator watching a site. The wall stays behind it, still
 * running.
 */
export default function SettingsModal({ open, onClose, towers }: Props) {
  const [section, setSection] = useState<Section>('calibration');
  const [towerId, setTowerId] = useState(towers[0]?.id ?? '');
  const panelRef = useRef<HTMLDivElement>(null);

  // Escape closes, and focus moves into the panel on open so a keyboard user
  // is not left behind on the page underneath.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    panelRef.current?.focus();
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="modal-scrim" onMouseDown={onClose} role="presentation">
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-label="Settings"
        tabIndex={-1}
        ref={panelRef}
        // Stops a click inside the panel reaching the scrim's close handler.
        onMouseDown={(e) => e.stopPropagation()}
      >
        <header className="modal-head">
          <div>
            <h2>Settings</h2>
            <p>Tower configuration and calibration</p>
          </div>
          <button type="button" className="modal-x" onClick={onClose} aria-label="Close settings">×</button>
        </header>

        <div className="modal-body">
          <nav className="modal-nav" aria-label="Settings sections">
            <button type="button" className={section === 'calibration' ? 'on' : ''}
                    onClick={() => setSection('calibration')}>Calibration</button>
            <button type="button" className={section === 'tower' ? 'on' : ''}
                    onClick={() => setSection('tower')}>Tower</button>
          </nav>

          <div className="modal-pane">
            {/* The tower picker sits above the section content, not inside
                calibration: every section will eventually be per-tower, and
                moving it later would move it out from under the operator. */}
            <label className="tower-pick">
              <span>TOWER</span>
              <select value={towerId} onChange={(e) => setTowerId(e.target.value)}>
                {towers.map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}
              </select>
              {towers.length === 1 && <em>the only tower connected</em>}
            </label>

            {section === 'calibration' ? <CalibrationPanel /> : <TowerPanel towers={towers} />}
          </div>
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ tower - */
function TowerPanel({ towers }: { towers: Array<{ id: string; label: string }> }) {
  return (
    <div className="set-sec">
      <h3>Connected tower</h3>
      <p className="set-note">
        This console is plugged directly into one tower over the local network. Additional
        towers appear in the selector above as they are connected.
      </p>
      <dl className="kv">
        {towers.map((t) => (
          <div key={t.id}>
            <dt>{t.label}</dt>
            <dd>{t.id || 'local'}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

/* ------------------------------------------------------------ calibration - */
function CalibrationPanel() {
  const [status, setStatus] = useState<CalibrationStatus | null>(null);
  const [err, setErr] = useState('');
  const [job, setJob] = useState<CalibrationJob | null>(null);
  const [camera, setCamera] = useState<number | null>(null);

  const refresh = useCallback(async () => {
    try {
      const s = await fetchCalibrationStatus();
      setStatus(s); setErr('');
      setCamera((c) => (c == null ? s.cameras[0]?.camera ?? null : c));
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'could not read calibration status');
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  // Poll only while something is running. A step takes minutes and holds the
  // camera; polling when nothing is running would be noise on a shared link.
  useEffect(() => {
    let stop = false;
    const tick = async () => {
      try {
        const j = await fetchCalibrationJob();
        if (stop) return;
        setJob(j);
        // Refresh the readiness the moment a step finishes — what it measured
        // is the whole point of having run it.
        if (!j.running && job?.running) void refresh();
      } catch { /* transient */ }
    };
    void tick();
    const id = window.setInterval(tick, job?.running ? 1500 : 6000);
    return () => { stop = true; window.clearInterval(id); };
  }, [job?.running, refresh]);

  const cam = status?.cameras.find((c) => c.camera === camera) ?? null;
  const busy = !!job?.running;

  return (
    <div className="set-sec">
      {err && <div className="set-err">{err}</div>}

      <h3>Cameras</h3>
      <div className="cam-tabs" role="tablist">
        {status?.cameras.map((c) => (
          <button
            key={c.camera} type="button" role="tab" aria-selected={c.camera === camera}
            className={c.camera === camera ? 'on' : ''}
            onClick={() => setCamera(c.camera)}
          >
            Camera {String(c.camera).padStart(2, '0')}
            <i className={c.can_steer ? 'ok' : 'no'} aria-hidden="true" />
          </button>
        ))}
        {!status && !err && <span className="set-note">reading calibration…</span>}
      </div>

      {cam && <CameraStatus cam={cam} />}

      {cam && status && (
        <>
          <h3>Steps</h3>
          <p className="set-note">
            Run these in order. Each writes only its own part of the calibration, so a single
            step can be re-run without discarding the rest.
          </p>
          {status.steps.map((s) => (
            <StepRow
              key={s.id} step={s} camera={cam.camera} busy={busy}
              onStarted={() => void fetchCalibrationJob().then(setJob)}
            />
          ))}
        </>
      )}

      {job && (job.running || job.output) && <JobOutput job={job} />}
    </div>
  );
}

function CameraStatus({ cam }: { cam: import('../calibrationApi').CameraCalibration }) {
  return (
    <div className={`cam-card${cam.can_steer ? '' : ' warn'}`}>
      <div className="cam-card-top">
        <b>{cam.can_steer ? 'Ready to steer' : 'Not ready to steer'}</b>
        {cam.north_offset_deg != null ? (
          <span>true north measured · offset {cam.north_offset_deg.toFixed(2)}°</span>
        ) : (
          <span className="miss">no true-north offset — bearings unavailable</span>
        )}
      </div>

      {/* Missing REQUIRED and missing OPTIONAL are different problems and are
          not merged: the first stops the tracker, the second only limits what
          the numbers mean. */}
      {cam.missing_required.length > 0 && (
        <p className="cam-missing">
          <b>Blocking:</b> {cam.missing_required.join(' · ')}
        </p>
      )}
      {cam.missing_optional.length > 0 && (
        <p className="cam-partial">
          <b>Not measured:</b> {cam.missing_optional.join(' · ')}
        </p>
      )}
      {(cam.pan_sd_pct != null || cam.jac_at_focal_mm != null) && (
        <p className="cam-meta">
          {cam.jac_at_focal_mm != null && <span>measured at {cam.jac_at_focal_mm} mm</span>}
          {cam.pan_sd_pct != null && <span>pan spread {cam.pan_sd_pct}%</span>}
          {cam.tilt_sd_pct != null && <span>tilt spread {cam.tilt_sd_pct}%</span>}
        </p>
      )}
    </div>
  );
}

function StepRow({ step, camera, busy, onStarted }: {
  step: import('../calibrationApi').CalibrationStep;
  camera: number; busy: boolean; onStarted: () => void;
}) {
  const needs = STEP_NEEDS_INPUT[step.id];
  const [bearing, setBearing] = useState('');
  const [sector, setSector] = useState('0:360');
  const [tilt, setTilt] = useState('-5:90');
  const [err, setErr] = useState('');

  const start = async () => {
    setErr('');
    const args: Record<string, unknown> = {};
    if (needs === 'bearing') args.bearing = Number(bearing);
    if (needs === 'home') args.here = true;
    if (needs === 'sector') { args.sector = sector; args.tilt = tilt; }
    try {
      await runCalibrationStep(camera, step.id, args);
      onStarted();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'could not start');
    }
  };

  const ready = needs !== 'bearing' || (bearing !== '' && Number.isFinite(Number(bearing)));

  return (
    <div className="step-row">
      <div className="step-main">
        <div className="step-id">{step.id}</div>
        <div>
          <b>
            {step.label}
            {/* Said before it is pressed, not after. */}
            {step.moves_camera && <em className="moves">moves the camera</em>}
          </b>
          <p>{STEP_HELP[step.id]}</p>
          {err && <p className="step-err">{err}</p>}
        </div>
        <button type="button" className="step-go" disabled={busy || !ready} onClick={start}>
          {busy ? 'busy' : 'Run'}
        </button>
      </div>

      {needs === 'bearing' && (
        <div className="step-args">
          <label>
            <span>TRUE BEARING OF WHAT IT IS AIMED AT</span>
            <input type="number" min={0} max={360} step={0.1} value={bearing} placeholder="e.g. 47.3"
                   onChange={(e) => setBearing(e.target.value)} />
          </label>
        </div>
      )}
      {needs === 'sector' && (
        <div className="step-args">
          <label><span>SECTOR (TRUE BEARINGS)</span>
            <input value={sector} onChange={(e) => setSector(e.target.value)} placeholder="0:360" /></label>
          <label><span>TILT RANGE</span>
            <input value={tilt} onChange={(e) => setTilt(e.target.value)} placeholder="-5:90" /></label>
        </div>
      )}
      {needs === 'home' && (
        <div className="step-args">
          <p className="set-note">Uses the camera’s current aim. Point it where you want home first.</p>
        </div>
      )}
    </div>
  );
}

function JobOutput({ job }: { job: CalibrationJob }) {
  const ref = useRef<HTMLPreElement>(null);
  useEffect(() => { if (ref.current) ref.current.scrollTop = ref.current.scrollHeight; }, [job.output]);
  const failed = !job.running && job.exit_code != null && job.exit_code !== 0;
  return (
    <div className="job">
      <div className="job-head">
        <b>
          {job.running ? `Running · ${job.label ?? job.step}` : failed ? 'Step failed' : 'Step finished'}
          {job.camera != null && ` · camera ${String(job.camera).padStart(2, '0')}`}
        </b>
        {job.running && <span className="job-live"><i />working — the camera is in use</span>}
        {failed && <span className="job-bad">exit {job.exit_code}</span>}
      </div>
      <pre ref={ref}>{job.output || 'starting…'}</pre>
    </div>
  );
}
