/**
 * The product wordmark, in one place.
 *
 * It was repeated verbatim in four views, which is how a brand ends up
 * half-changed — three headers saying one thing and the fourth still saying
 * the old name. There is nothing to configure here on purpose: a wordmark
 * that takes props is a wordmark that will differ between pages.
 */
export default function Wordmark() {
  return (
    <div className="topbar-brand-group">
      <span className="wordmark">BAYANNA</span>
      <span className="wordmark-sub">watch</span>
    </div>
  );
}
