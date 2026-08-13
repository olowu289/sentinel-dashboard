import { TowerContext } from './towerContext';
import { towerClient } from './towerClient';
import TowerApp from './TowerApp';
import './fonts.css';
import './styles.css';

/**
 * Bayanan boots straight into the tower it is cabled to.
 *
 * No login, no session, no customer, no fleet. Those exist to answer "which
 * tower, and are you allowed to see it" - questions a cable already answers.
 * The browser is on the segment or it is not, and if it is not, the console
 * says so rather than presenting a sign-in it could never satisfy.
 *
 * NO AUTHENTICATION. Deliberate and demo-stage: the gateway has none to
 * offer (see towerClient), so a login screen here would be decoration. The
 * physical segment is the trust boundary today. That has to change before
 * this is fielded.
 */
export default function App() {
  return (
    <TowerContext.Provider value={{ client: towerClient }}>
      <TowerApp />
    </TowerContext.Provider>
  );
}
