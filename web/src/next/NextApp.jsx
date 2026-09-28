// Apollo "next" preview layout -- mobile-first second page (see
// web/next.html, served at /next by src/webServer.js), sharing the existing
// state layer + commands module with the classic dashboard (main.jsx). Not a
// replacement for `/` -- a parallel layout built for phone-first use:
// wordmark+status button / scene bar / small floorplan / tab bar (Lights,
// Shades, Media, Climate) / pinned Dock, with a slim problem banner above
// the Dock instead of main.jsx's always-visible StatusStrip.
//
// Desktop (>=900px, see next.css): the plane fills a left column and a right
// rail holds the header/scenes/tabs/dock -- see the `.next-app` media query.

import { useEffect, useState } from 'preact/hooks';
import { bootstrap, store, ui } from '../state/index.js';
import { Plane } from '../plan/index.js';
import { SceneBar } from '../scenes/index.js';
import StatusScreen from '../status/StatusScreen.jsx';
import LightsTab from './LightsTab.jsx';
import ShadesTab from './ShadesTab.jsx';
import MediaTab from './MediaTab.jsx';
import ClimateTab from './ClimateTab.jsx';
import Dock from './Dock.jsx';
import './next.css';

const CONNECTION_COLOR = {
  live: 'var(--status-green)',
  polling: 'var(--amber)',
  connecting: 'var(--amber)',
  offline: '#e05353',
};

const TABS = [
  { id: 'lights', label: 'Lights' },
  { id: 'shades', label: 'Shades' },
  { id: 'media', label: 'Media' },
  { id: 'climate', label: 'Climate' },
];

const TAB_STORAGE_KEY = 'apollo.next.tab';

function readStoredTab() {
  try {
    const v = window.localStorage.getItem(TAB_STORAGE_KEY);
    return TABS.some((t) => t.id === v) ? v : 'lights';
  } catch (err) {
    return 'lights';
  }
}

function writeStoredTab(id) {
  try {
    window.localStorage.setItem(TAB_STORAGE_KEY, id);
  } catch (err) {
    // ignore (private browsing / storage disabled)
  }
}

// Same default-room selection as main.jsx's useDefaultRoom: after the first
// snapshot loads, prefer the living room (the open-plan hub, resolves to the
// "common" zone) so neither the plan nor the tab content start empty.
function useDefaultRoom() {
  useEffect(() => {
    bootstrap().then(() => {
      if (ui.selectedRoom.value) return;
      const rooms = store.rooms.value.filter((r) => !r.decorative);
      const pick = rooms.find((r) => r.id === 'living' && r.selectable !== false)
        || rooms.find((r) => r.selectable !== false);
      if (pick) {
        ui.selectRoom(pick.id);
        // selectRoom records a zone-member "tap" in focusRoom, which would
        // scroll the Lights list to that member on load; this isn't a tap.
        ui.focusRoom.value = null;
      }
    });
  }, []);
}

/**
 * Short "something's wrong" text for the slim banner, or null when healthy.
 * Same precedence as status/StatusStrip.jsx's computeHealth (bridge offline
 * > stale devices > degraded flag) -- duplicated in short form here rather
 * than imported since StatusStrip doesn't export its computation and this
 * banner's copy is deliberately terser ("Bridge offline" vs "Bridge offline ›").
 */
function problemText() {
  const bridges = store.bridges.value;
  const bridgeOffline = Object.values(bridges).some((status) => status !== 'online');
  if (bridgeOffline) return 'Bridge offline';

  let staleCount = 0;
  for (const entry of store.devices.value.values()) {
    if (entry.stale) staleCount += 1;
  }
  if (staleCount > 0) return `${staleCount} device${staleCount > 1 ? 's' : ''} stale`;

  if (store.degraded.value) return 'Degraded';

  const connectionState = store.connection.value;
  if (connectionState === 'offline') return 'Offline';

  return null;
}

function TabContent({ tab }) {
  switch (tab) {
    case 'shades': return <ShadesTab />;
    case 'media': return <MediaTab />;
    case 'climate': return <ClimateTab />;
    case 'lights':
    default:
      return <LightsTab />;
  }
}

export default function NextApp() {
  useDefaultRoom();

  const [tab, setTab] = useState(readStoredTab);
  const [statusOpen, setStatusOpen] = useState(false);

  const connectionState = store.connection.value;
  const problem = problemText();

  function selectTab(id) {
    setTab(id);
    writeStoredTab(id);
  }

  return (
    <div class="next-app">
      <header class="next-header">
        <button
          type="button"
          class="next-status-btn"
          aria-label="System status"
          onClick={() => setStatusOpen(true)}
        >
          <span class="next-wordmark">APOLLO</span>
          <span
            aria-hidden="true"
            class="next-conn-dot"
            title={connectionState}
            style={{ background: CONNECTION_COLOR[connectionState] || CONNECTION_COLOR.offline }}
          />
        </button>
      </header>

      <div class="next-scene-row">
        <SceneBar />
      </div>

      {/* .next-main splits plane vs. tabs/content/dock -- a column on phones
          (plane above, right-col fills the rest) and a row on desktop (plane
          fills the left, right-col is a fixed-width rail). See next.css. */}
      <div class="next-main">
        <div class="next-plane-wrap">
          <Plane />
        </div>

        <div class="next-right-col">
          <div class="next-tabs" role="tablist">
            {TABS.map((t) => (
              <button
                key={t.id}
                type="button"
                role="tab"
                aria-selected={tab === t.id}
                class={`next-tab-btn${tab === t.id ? ' is-active' : ''}`}
                onClick={() => selectTab(t.id)}
              >
                {t.label}
              </button>
            ))}
          </div>

          <div class="next-tab-content">
            <TabContent tab={tab} />
          </div>

          {problem && (
            <button type="button" class="next-problem-banner" onClick={() => setStatusOpen(true)}>
              {problem} &rsaquo;
            </button>
          )}

          <div class="next-dock-wrap">
            <Dock />
          </div>
        </div>
      </div>

      {statusOpen && <StatusScreen onClose={() => setStatusOpen(false)} />}
    </div>
  );
}
