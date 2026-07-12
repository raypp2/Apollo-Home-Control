// Apollo v2 dashboard -- AC unit + airflow (Beacon v3 §5.2).
//
// `livingRoomAC` is a one-way IR blaster with no readback (see
// ../climate/ClimateCluster.jsx) -- `live.power` is Apollo's assumed shadow
// state, not a sensor reading, but it's the only signal available and it's
// what the design calls for animating against.
//
// The unit itself has no fixture dot in config/rooms.json (it isn't a light
// and doesn't get one); its plan-space position is the design's own guess,
// against the back (top) wall near the dining room's bookshelf, close to
// the apartment's top-right corner. Because that position is independent
// of any room's own rect, this renders directly in plane space as a
// sibling of the rooms (see Plane.jsx) rather than as a child of Room --
// it inherits the same isometric transform, sway, and selection pan either
// way since both live inside .plan-inner.

import { store } from '../state/index.js';
import Airflow from './Airflow.jsx';
import './plan-ac.css';

const VENT_X = 404;
const VENT_Y = 15;
const VENT_W = 44;
const VENT_H = 12;

/**
 * @returns {boolean}
 */
function acIsOn() {
  const entries = store.devicesInRoom('living');
  const entry = entries.find((e) => e.id === 'livingRoomAC') || null;
  return !!entry && !!entry.live && entry.live.power === 'ON';
}

export default function AcVent() {
  const on = acIsOn();

  const style = {
    left: `${VENT_X}px`,
    top: `${VENT_Y}px`,
    width: `${VENT_W}px`,
    height: `${VENT_H}px`,
  };

  return (
    <div class="plan-ac-vent" style={style}>
      <div class="plan-ac-vent__grille" />
      <div class="plan-ac-vent__grille" />
      {on && <Airflow />}
    </div>
  );
}
