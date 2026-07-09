// Apollo v2 dashboard -- scene/macro bar public surface (increment 3; +6).
export { default as SceneBar } from './SceneBar.jsx';
export { default as MoreMenu } from './MoreMenu.jsx';
// Increment 6: RoomToggle (on/off + hold-drag dim) replaces RoomSceneBar's
// room-scoped scene pill. RoomSceneBar itself is left as-is (unused once the
// orchestrator swaps main.jsx over to RoomToggle) so this barrel's existing
// `RoomSceneBar` export keeps working until that swap happens.
export { default as RoomSceneBar } from './RoomSceneBar.jsx';
export { default as RoomToggle } from './RoomToggle.jsx';
export { default } from './SceneBar.jsx';
