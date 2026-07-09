// Apollo v2 dashboard -- AV public surface (increment 5): NOW-PLAYING strip
// and the slim/expandable AV cluster (receiver, with the drill-in -- and the
// projector control inside it -- now self-contained). The orchestrator
// (RoomPanel) owns wiring these into the pinned command-panel footer.

import AvCluster from './AvCluster.jsx';

export default AvCluster;
export { AvCluster };
export { default as NowPlaying } from './NowPlaying.jsx';
export { default as AvDrillIn } from './AvDrillIn.jsx';
export { default as VolumeBar, DB_MIN, DB_MAX, pctToDb, dbToPct } from './VolumeBar.jsx';
