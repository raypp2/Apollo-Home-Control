import { render } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { bootstrap, store, ui } from './state/index.js';
import { Plane } from './plan/index.js';
import RoomPanel from './panel/index.js';
import StatusStrip from './status/index.js';
import { SceneBar } from './scenes/index.js';
import './app.css';

// Increment 2: the state layer (increment 1) feeds three surfaces -- the
// isometric plane (plan/), the room command panel (panel/), and the status
// strip (status/). This module composes them into the responsive app shell
// and owns cross-cutting wiring (bootstrap, clock, default room selection).
// Scene bar + macro buttons (top-bar right) land in increment 3; AV/climate
// clusters + now-playing + utility rail in increment 4.

const CONNECTION_COLOR = {
  live: 'var(--status-green)',
  polling: 'var(--amber)',
  connecting: 'var(--amber)',
  offline: '#e05353',
};

function useClock() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(id);
  }, []);
  return now;
}

function formatTime(date) {
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

// After the first snapshot loads, select a room so the panel isn't empty --
// prefer the living room (the open-plan hub), else the first selectable room.
function useDefaultRoom() {
  useEffect(() => {
    bootstrap().then(() => {
      if (ui.selectedRoom.value) return;
      const rooms = store.rooms.value.filter((r) => !r.decorative);
      const pick = rooms.find((r) => r.id === 'living' && r.selectable !== false)
        || rooms.find((r) => r.selectable !== false);
      if (pick) ui.selectRoom(pick.id);
    });
  }, []);
}

function App() {
  const now = useClock();
  useDefaultRoom();

  const connectionState = store.connection.value;

  return (
    <div class="app">
      <header class="topbar">
        <div class="topbar-left">
          <span class="wordmark">APOLLO</span>
          <span class="topbar-time">{formatTime(now)}</span>
        </div>
        <div class="topbar-scenes">
          <SceneBar />
        </div>
        <div class="topbar-util">
          <span
            class="conn-dot"
            aria-hidden="true"
            title={connectionState}
            style={{ background: CONNECTION_COLOR[connectionState] || CONNECTION_COLOR.offline }}
          />
        </div>
      </header>

      <div class="stage">
        <div class="plane-wrap">
          <Plane />
        </div>
        <div class="panel-wrap">
          <RoomPanel />
        </div>
      </div>

      <StatusStrip />
    </div>
  );
}

render(<App />, document.getElementById('app'));
