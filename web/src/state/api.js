// Apollo v2 dashboard -- state layer, HTTP transport.
//
// Thin fetch wrappers over the backend contract documented in
// documentation/dashboard-redesign-plan.md §3.2. No caching here -- callers
// (bootstrap.js, the polling fallback in mqtt-less environments) decide when
// to refetch. Every function throws on a non-2xx response so callers can
// react to failures rather than silently working with `undefined`.

/**
 * @param {string} path - absolute path, e.g. '/api/health'
 * @param {RequestInit} [options]
 * @returns {Promise<any>} parsed JSON body
 */
async function fetchJson(path, options) {
  const response = await fetch(path, options);
  if (!response.ok) {
    throw new Error(`${options?.method || 'GET'} ${path} failed: ${response.status}`);
  }
  return response.json();
}

/**
 * GET /api/health -- health summary + per-device detail (topic, last state,
 * age, staleness) + bridge status. See src/healthMonitor.js#getHealth for the
 * exact shape.
 * @returns {Promise<object>}
 */
export function getHealth() {
  return fetchJson('/api/health');
}

/**
 * GET /list/<name> -- one of rooms, lights, devices, lightingScenes, macros,
 * deviceScenes. See src/webServer.js's '/list' route for the full set.
 * @param {string} name
 * @returns {Promise<Array<object>>}
 */
export function getList(name) {
  return fetchJson(`/list/${name}`);
}

/**
 * POST /api/<MODULE>/<DEVICE>/<COMMAND>/<P1?>/<P2?> -- fire-and-forget
 * command dispatch. Segments are sent as-is (the server uppercases the
 * module segment itself); the response body is plain text, not JSON, so this
 * resolves with that text rather than parsing it.
 * @param {Array<string|number>} pathSegments - e.g. ['LIGHTS', 'kitchen', 'on']
 * @returns {Promise<string>} the response body text
 */
export async function sendCommand(pathSegments) {
  const path = `/api/${pathSegments.join('/')}`;
  const response = await fetch(path, { method: 'POST' });
  if (!response.ok) {
    throw new Error(`POST ${path} failed: ${response.status}`);
  }
  return response.text();
}
