// Apollo v2 dashboard -- persistent utility rail (increment 4).
//
// Whole-home momentary triggers that aren't room-scoped: the door buzzer and
// Find My iPhone ping. Always reachable, sits in the top bar. Design addition
// beyond #t3 (Ray's decision: shades in the room panel, these on a utility
// rail).

import { store, commands } from '../state/index.js';

const BTN = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 6,
  padding: '7px 13px',
  borderRadius: 'var(--r-btn, 9px)',
  border: '1px solid var(--hairline, rgba(234, 229, 239, 0.14))',
  background: 'rgba(234, 229, 239, 0.03)',
  color: 'var(--text, #eae5ef)',
  fontFamily: "'Outfit', system-ui, sans-serif",
  fontWeight: 500,
  fontSize: 12,
  cursor: 'pointer',
  whiteSpace: 'nowrap',
};

export default function UtilityRail() {
  const devices = [...store.devices.value.values()];
  const door = devices.find((d) => d.id === 'door' || d.type === 'iTach_CC');
  const phone = devices.find((d) => d.type === 'findMyIphone');

  if (!door && !phone) return null;

  return (
    <div style={{ display: 'inline-flex', gap: 8 }}>
      {door && (
        <button
          type="button"
          style={BTN}
          title="Buzz the door open"
          onClick={() => commands.buzzDoor(door, 'front')}
        >
          <span aria-hidden="true">🔓</span> Door
        </button>
      )}
      {phone && (
        <button
          type="button"
          style={BTN}
          title="Ping my phone"
          onClick={() => commands.pingPhone(phone)}
        >
          <span aria-hidden="true">📱</span> Find
        </button>
      )}
    </div>
  );
}
