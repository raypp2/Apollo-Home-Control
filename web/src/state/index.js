// Apollo v2 dashboard -- state layer public surface.
// Later increments should generally import from here rather than reaching
// into individual files, so this barrel stays the one place that documents
// what's actually exposed.

export { bootstrap } from './bootstrap.js';
export { applyOptimistic, neverConfirms } from './optimistic.js';
export { getHealth, getList, sendCommand } from './api.js';
export { connect as connectMqtt, disconnect as disconnectMqtt } from './mqtt.js';
export * as store from './store.js';
export * as ui from './ui.js';
export * as commands from './commands.js';
