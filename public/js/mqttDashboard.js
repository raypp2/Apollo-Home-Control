/**
 * Apollo Home Control Bridge - Dashboard Live Layer (Stage 9, issues #21/#22)
 * @module public/js/mqttDashboard.js
 *
 * @description  Plain browser JS, no build step. Loaded after angular.min.js,
 *               angular-sanitize.js, and the vendored mqtt.min.js, and before
 *               index.html's inline Angular app script (so window.apolloLive
 *               exists by the time the controllers register with it).
 *
 *               Connects directly to Mosquitto's WebSocket listener
 *               (ws://<host>:9001) and subscribes to the canonical state bus.
 *               When a message arrives for a topic that matches one of the
 *               registered scope arrays' entries, it patches that entry's
 *               `checked`/`status`/`position`/`unreachable` fields in place
 *               and asks Angular to re-render via $applyAsync(). This lets the
 *               existing $http.get('/list/...') + $interval polling fallback
 *               stay as the source of truth for the device LIST (ids, titles,
 *               icons, commands) while MQTT becomes the source of truth for
 *               device STATE once connected.
 *
 *               Public API (window.apolloLive):
 *                 register(scopeName, $scope, listArrayGetter)
 *                   - scopeName: any string, used only for log messages.
 *                   - $scope: the Angular scope to $applyAsync() after a
 *                     matching message is applied.
 *                   - listArrayGetter: a zero-arg function returning the
 *                     CURRENT array of entries (e.g. () => $scope.devices).
 *                     A getter (not the array itself) because the array
 *                     reference is replaced wholesale by fetchList() every
 *                     time it re-resolves ($scope.devices = response.data),
 *                     so capturing the array at register()-time would go
 *                     stale the moment the initial fetch's .then() reassigns
 *                     it -- always look the array up fresh per message.
 *                 onConnectionChange(cb)
 *                   - cb(connected: boolean) is called once immediately with
 *                     the current state, then again on every transition.
 *                     Controllers use this to stop/start their $interval
 *                     polling fallback.
 *                 isConnected()
 *                   - synchronous read of the current connection state.
 *
 *               Design choices kept deliberately minimal:
 *               - No dependency on Angular internals beyond $applyAsync --
 *                 this file works even if a registered "scope" is just a
 *                 plain object with an $applyAsync no-op, which is what the
 *                 topic-matching unit tests below (see stateTopicFor) rely on.
 *               - Topic -> entry matching is O(entries) per message, which is
 *                 fine at Apollo's scale (tens of devices, not thousands).
 */

(function () {
    // Everything lives inside this one IIFE so that, loaded as a plain
    // <script> tag, this file leaks exactly one global: window.apolloLive.
    // In a Node test context (no `window`), skip the browser wiring entirely
    // and just export the pure functions below -- this file is loaded by
    // test/mqttDashboardTopic.test.js via require() for that reason.
    var isBrowser = typeof window !== 'undefined';

    /**
     * Maps a config `type` field to its MQTT ecosystem segment. Mirrors
     * ECOSYSTEM_BY_TYPE in src/mqttTopics.js -- MUST be kept in sync with
     * that table by hand (this file is plain browser JS with no build step,
     * so it can't import mqttTopics.js directly).
     */
    var ECOSYSTEM_BY_TYPE = {
        insteon: 'insteon',
        'hue-group': 'hue',
        dmxFixture: 'dmx',
        shelly: 'shelly',
        wled: 'wled',
        iTach_serial: 'itach',
        iTach_ir: 'itach',
        iTach_CC: 'itach',
        ip_control: 'ip',
        'Somfy-Bridge': 'somfy',
        spotify: 'spotify',
    };

    /**
     * Lowercases a string and replaces spaces with hyphens. Mirrors
     * slugify() in src/mqttTopics.js.
     * @param {string} value
     * @returns {string}
     */
    function slugify(value) {
        return String(value).toLowerCase().replace(/ /g, '-');
    }

    /**
     * Derives the ecosystem (topic level 3) from a config entry's `type`
     * field. Mirrors ecosystemFor() in src/mqttTopics.js.
     * @param {object} entry
     * @returns {string}
     */
    function ecosystemFor(entry) {
        return (entry && ECOSYSTEM_BY_TYPE[entry.type]) || 'x';
    }

    /**
     * Computes the canonical state topic a config entry publishes to:
     * apollo/<location>/<ecosystem>/<mqttName>/state
     *
     * MIRRORS src/mqttTopics.js's topicFor(entry, 'state') + its defaulting
     * rules (location||'home', ecosystem-from-type table above,
     * mqttName||id). Kept here as a small pure function (no Angular, no
     * mqtt.js) so it can be unit-tested from Node via the typeof-module
     * export guard at the bottom of this file. If mqttTopics.js's
     * defaulting rules ever change, this function must change to match.
     *
     * @param {object} entry - a lights.json/devices.json entry (as served
     *   by /list/lights or /list/devices)
     * @returns {string}
     */
    function stateTopicFor(entry) {
        var location = slugify((entry && entry.location) || 'home');
        var ecosystem = ecosystemFor(entry);
        var mqttName = (entry && entry.mqttName) || (entry && entry.id);
        return 'apollo/' + location + '/' + ecosystem + '/' + mqttName + '/state';
    }

    // --- Registry of scopes registered via apolloLive.register() ---
    // Array of { scopeName, $scope, listArrayGetter }.
    var registrations = [];

    // --- Connection state ---
    var connected = false;
    var connectionListeners = [];

    function notifyConnectionChange() {
        connectionListeners.forEach(function (cb) {
            try {
                cb(connected);
            } catch (err) {
                console.error('apolloLive: onConnectionChange callback threw', err);
            }
        });
    }

    function setConnected(next) {
        if (next === connected) {
            return;
        }
        connected = next;
        notifyConnectionChange();
    }

    /**
     * Finds the entry (if any) in a registration's current list array whose
     * stateTopicFor() matches the given topic.
     * @param {Array} list
     * @param {string} topic
     * @returns {object|null}
     */
    function findEntryByTopic(list, topic) {
        if (!list) {
            return null;
        }
        for (var i = 0; i < list.length; i++) {
            if (stateTopicFor(list[i]) === topic) {
                return list[i];
            }
        }
        return null;
    }

    /**
     * Applies a canonical state payload {power, brightness?, position?,
     * reachable, timestamp, source} onto a matched entry's Angular-bound
     * fields: `checked` (power==='ON'), `status` (brightness, falling back to
     * 100/0 by power state when brightness is absent -- mirrors how the
     * existing /list/* payloads populate `status` for on/off-only devices),
     * `position` (shades), and `unreachable` (health/state combined).
     * @param {object} entry
     * @param {object} payload
     */
    function applyStateToEntry(entry, payload) {
        if (!payload || typeof payload !== 'object') {
            return;
        }

        if (payload.power === 'ON') {
            entry.checked = true;
        } else if (payload.power === 'OFF') {
            entry.checked = false;
        }

        if (Object.prototype.hasOwnProperty.call(payload, 'brightness') && payload.brightness !== null && payload.brightness !== undefined) {
            entry.status = payload.brightness;
        } else if (payload.power === 'ON') {
            entry.status = 100;
        } else if (payload.power === 'OFF') {
            entry.status = 0;
        }

        if (Object.prototype.hasOwnProperty.call(payload, 'position') && payload.position !== null && payload.position !== undefined) {
            entry.position = payload.position;
        }

        if (payload.reachable === false) {
            entry.unreachable = true;
        } else if (payload.reachable === true) {
            entry.unreachable = false;
        }
    }

    /**
     * Handler for `apollo/+/health/#`-style health status messages (both the
     * per-device `apollo/health/<location>/<mqttName>/status` = "stale"/"ok"
     * strings and any future JSON health payloads carrying reachable:false).
     * Since health topics don't carry the ecosystem segment needed to run
     * stateTopicFor() in reverse, this greys out entries by matching on the
     * <location>/<mqttName> pair against every registered entry's own
     * location/mqttName fields directly (not via topic reconstruction).
     * @param {string} topic
     * @param {*} payload
     */
    function handleHealthMessage(topic, payload) {
        var parts = topic.split('/');
        // apollo/health/<location>/<mqttName>/status
        if (parts.length !== 5 || parts[0] !== 'apollo' || parts[1] !== 'health') {
            return;
        }
        var location = parts[2];
        var mqttName = parts[3];
        var isStale = payload === 'stale';
        var isOk = payload === 'ok';
        if (!isStale && !isOk) {
            return;
        }

        registrations.forEach(function (reg) {
            var list = reg.listArrayGetter();
            if (!list) {
                return;
            }
            list.forEach(function (entry) {
                var entryLocation = slugify((entry && entry.location) || 'home');
                var entryMqttName = (entry && entry.mqttName) || (entry && entry.id);
                if (entryLocation === location && entryMqttName === mqttName) {
                    entry.unreachable = isStale;
                }
            });
            reg.$scope.$applyAsync();
        });
    }

    /**
     * Handler for `apollo/+/+/+/state` messages: finds the matching entry (if
     * any) in every registered scope's current list and patches it in place.
     * @param {string} topic
     * @param {*} payload
     */
    function handleStateMessage(topic, payload) {
        registrations.forEach(function (reg) {
            var list = reg.listArrayGetter();
            var entry = findEntryByTopic(list, topic);
            if (!entry) {
                return;
            }
            applyStateToEntry(entry, payload);
            reg.$scope.$applyAsync();
        });
    }

    function register(scopeName, $scope, listArrayGetter) {
        registrations.push({ scopeName: scopeName, $scope: $scope, listArrayGetter: listArrayGetter });
    }

    function onConnectionChange(cb) {
        connectionListeners.push(cb);
        // Fire immediately with current state so callers don't need a
        // separate "read current state" call.
        try {
            cb(connected);
        } catch (err) {
            console.error('apolloLive: onConnectionChange callback threw', err);
        }
    }

    function isConnected() {
        return connected;
    }

    var apolloLive = {
        register: register,
        onConnectionChange: onConnectionChange,
        isConnected: isConnected,
    };

    if (isBrowser) {
        window.apolloLive = apolloLive;

        var brokerUrl = 'ws://' + window.location.hostname + ':9001';
        var client = window.mqtt.connect(brokerUrl);

        client.on('connect', function () {
            console.log('apolloLive: connected to %s', brokerUrl);
            client.subscribe('apollo/+/+/+/state');
            client.subscribe('apollo/health/#');
            client.subscribe('apollo/bridge/+/status');
            setConnected(true);
        });

        client.on('reconnect', function () {
            // mqtt.js handles reconnection automatically; just reflect the
            // resulting offline state via the 'close'/'offline' events below.
        });

        client.on('close', function () {
            setConnected(false);
        });

        client.on('offline', function () {
            setConnected(false);
        });

        client.on('error', function (err) {
            console.error('apolloLive: MQTT error', err);
        });

        client.on('message', function (topic, messageBuffer) {
            var raw = messageBuffer.toString();
            var payload = raw;
            try {
                payload = JSON.parse(raw);
            } catch {
                // Non-JSON payloads (e.g. "online"/"offline"/"stale"/"ok" on
                // status topics) pass through as the raw string, same
                // contract as src/mqttClient.js on the server side.
            }

            var parts = topic.split('/');
            if (parts[0] === 'apollo' && parts[1] === 'health') {
                handleHealthMessage(topic, payload);
            } else if (parts[0] === 'apollo' && parts.length === 5 && parts[4] === 'state') {
                handleStateMessage(topic, payload);
            }
            // apollo/bridge/+/status (bridge LWT) isn't wired to any UI
            // element in this stage -- the connection indicator already
            // reflects the browser's own MQTT link, which is the signal that
            // matters for "should the dashboard poll instead".
        });
    }

    // Dual browser/Node export -- same technique used by other dual-context
    // files in this codebase's test suite. In Node (test/mqttDashboardTopic.test.js)
    // this exports the pure functions only; nothing above this point that
    // touches `window`/`mqtt` runs, since isBrowser is false.
    if (typeof module !== 'undefined' && module.exports) {
        module.exports = {
            stateTopicFor: stateTopicFor,
            ecosystemFor: ecosystemFor,
            slugify: slugify,
        };
    }
})();
