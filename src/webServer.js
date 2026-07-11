/**
 * Apollo Home Control Bridge - Web Server Module
 * @module webServer.js
 * 
 * @author Ray Perfetti
 * @date 2023-10-05
 * 
 * @description Serves the HTML interface for device control & testing.
 *              Dynamically loads the JSON files for devices, deviceScenes, lights, lightingScenes, and macros.
 *              Provides API for making command requests.
 * 
 */

// Load variables
const { devices, deviceScenes, lights, lightingScenes, macros, rooms, logging }
        = require('../index');

// Orchestration Handlers
const { handleRequest }
        = require('./handler');

const mqttTopics = require('./mqttTopics');

var express = require('express');
var path = require('path');
var fs = require('fs');
var app = express();
// The new Preact dashboard (built into public/app, base '/') is served at the
// root. Registered BEFORE the old public/ static so '/' resolves to the new
// app's index.html; the old AngularJS assets (/js, /css, /font/roboto, /logs)
// still fall through to public/ for the /legacy route. Non-file paths (/api,
// /list) fall through both statics to their routes below.
app.use(express.static('public/app'));
app.use(express.static('public'));
// const mDNS = require('bonjour')();

// Adds a `stateTopic` string (from `topicFn`) to a shallow copy of each entry,
// WITHOUT mutating the shared in-memory config arrays -- those arrays carry
// live runtime fields (e.g. `checked`/`status`) that other modules depend on.
function withStateTopic(entries, topicFn) {
    return entries.map(function(entry) {
        return { ...entry, stateTopic: topicFn(entry) };
    });
}

// Merges live `active`/`activatedAt` scene/macro shadow state (src/sceneShadow.js)
// into a shallow copy of each entry, WITHOUT mutating the shared config arrays
// (same rationale as withStateTopic() above). `stateGetter` is sceneShadow's
// sceneState()/macroState() -- undefined (never activated this run) defaults
// to active:false/activatedAt:null rather than being surfaced as an error, so
// a dashboard on the MQTT-WS-unreachable polling fallback can still see
// externally-activated scenes/macros instead of never learning about them.
function withActiveState(entries, stateGetter) {
    return entries.map(function(entry) {
        const state = stateGetter(entry.id) || {};
        return {
            ...entry,
            active: state.active === undefined ? false : state.active,
            activatedAt: state.activatedAt === undefined ? null : state.activatedAt,
        };
    });
}

// Storage for dashboard user preferences (currently: the 6-slot custom
// swatch palette). A plain JSON file rather than a config/*.json entry --
// this is runtime-written state, not hand-edited config, and living outside
// config/ means it isn't swept up by that directory's gitignore/symlink
// conventions. IMPORTANT: also excluded from the Pi rsync deploy (see
// private/update-pi.sh's EXCLUDE_PATTERNS) so a deploy's `rsync --delete`
// never wipes Pi-side writes.
var USER_PREFS_PATH = path.join(__dirname, '..', 'data', 'userPrefs.json');
var SWATCH_HEX_RE = /^#[0-9a-fA-F]{6}$/;

// Reads data/userPrefs.json, defaulting to {} if the file doesn't exist yet
// (first run) or is somehow unparseable -- never throws.
function readUserPrefs() {
    try {
        return JSON.parse(fs.readFileSync(USER_PREFS_PATH, 'utf8'));
    } catch (err) {
        return {};
    }
}

// Writes data/userPrefs.json, creating the data/ directory on demand.
function writeUserPrefs(prefs) {
    fs.mkdirSync(path.dirname(USER_PREFS_PATH), { recursive: true });
    fs.writeFileSync(USER_PREFS_PATH, JSON.stringify(prefs, null, 2));
}


// IMPORTANT: this must be registered BEFORE the '/api' catch-all middleware
// below, otherwise that middleware's app.use('/api', ...) swallows this route
// first and routes /api/health into handleRequest as if "health" were a
// device command (see src/handler.js's MODULE switch). Express matches
// middleware/routes in registration order, so more-specific routes must come
// first. healthMonitor is require()'d lazily inside the handler (not at
// module load time) because webServer.js is required before healthMonitor's
// config dependencies (mqttTopics -> '../index') are ready -- same lazy-init
// rule documented in healthMonitor.js's module comment.
app.get('/api/health', function(request, response) {
    const healthMonitor = require('./healthMonitor');
    response.json(healthMonitor.getHealth());
});

// Dashboard user-prefs endpoints (currently: the 6-slot custom swatch
// palette -- see data/userPrefs.json helpers above). Registered BEFORE the
// '/api' catch-all below for the same reason as /api/health above: Express
// matches routes in registration order, and app.use('/api', ...) would
// otherwise swallow these as if "prefs" were a device command.
//
// express.json() is mounted ONLY on the POST route below (as that route's
// own middleware argument), not globally -- the generic '/api' passthrough
// reads command paths, never a body, so it must not be affected.
app.get('/api/prefs', function(request, response) {
    response.json(readUserPrefs());
});

app.post('/api/prefs/swatches', express.json(), function(request, response) {
    const swatches = request.body && request.body.swatches;
    const isValid = Array.isArray(swatches)
        && swatches.length === 6
        && swatches.every(function(s) { return typeof s === 'string' && SWATCH_HEX_RE.test(s); });

    if (!isValid) {
        response.status(400).send("ERROR: swatches must be an array of exactly 6 hex color strings (e.g. \"#AABBCC\").");
        return;
    }

    const prefs = readUserPrefs();
    prefs.swatches = swatches;
    writeUserPrefs(prefs);
    response.json(prefs);
});

app.use('/api', function(request, response, next) {

	console.log("\n\n###### API Message Received ######");
    console.log("URL: " + request.url);
    console.log("Method: " + request.method);
    // console.log("Body: " + JSON.stringify(request.body));
    console.log("##################################\n");

	handleRequest(request.url, response);

});


app.use('/list', function(request, response) {
    // console.log("URL: " + request.url);
    switch(request.url) {
        case "/devices":
            // console.log("Devices list requested");
            response.json(withStateTopic(devices, function(e) { return mqttTopics.topicFor(e, 'state'); }));
            break;
        case "/deviceScenes":
            // console.log("Device Scenes list requested");
            response.json(deviceScenes);
            break;
         case "/lights":
            // console.log("Lights list requested");
            response.json(withStateTopic(lights, function(e) { return mqttTopics.topicFor(e, 'state'); }));
            break;
        case "/lightingScenes": {
            // console.log("Lighting Scenes list requested");
            const sceneShadow = require('./sceneShadow');
            const scenesWithTopics = withStateTopic(lightingScenes, function(e) { return 'apollo/home/scene/' + e.id + '/state'; });
            response.json(withActiveState(scenesWithTopics, sceneShadow.sceneState));
            break;
        }
        case "/macros": {
            // console.log("Macros list requested");
            const sceneShadow = require('./sceneShadow');
            const macrosWithTopics = withStateTopic(macros, function(e) { return 'apollo/home/macro/' + e.id + '/state'; });
            response.json(withActiveState(macrosWithTopics, sceneShadow.macroState));
            break;
        }
        case "/rooms":
            // console.log("Rooms list requested");
            response.json(rooms);
            break;
        default:
            response.status(404).send("ERROR: You must specify a valid list -- devices, deviceScenes, lights, lightingScenes, macros, or rooms.")
    }
});

// Serves the legacy AngularJS dashboard at /legacy while the new dashboard
// (a later increment) takes over `/`. express.static('public') above still
// serves the old asset paths (/js/..., /css/...) at root, so the old HTML's
// relative asset refs keep resolving unchanged.
app.get('/legacy', function(req, res) {
    res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

// Serves the new Preact/Vite dashboard at /v2 (built by `web/` into
// public/app/, base '/v2/'). express.static handles the built JS/CSS/asset
// requests; the SPA fallback below is GET-only and only fires for unmatched
// /v2/* paths (client-side routes), so it never swallows real static assets --
// those are already resolved by express.static before this route is reached.
app.use('/v2', express.static('public/app'));
app.get('/v2/*', function(req, res) {
    res.sendFile(path.join(__dirname, '..', 'public', 'app', 'index.html'));
});

app.use(function(req, res, next) {
    console.log("404 URL: " + req.url);
    res.status(404).send("Sorry, can't find that!");
  });


  
let server;

const startServer = () => {
server = app.listen(80, function () {
    // mDNS.publish({ name: 'apollo', type: 'http', port: 80 });
    // console.log('HTTP Server listening on: http://apollo.local');
    console.log('HTTP Server listening on port 80');
});
};

module.exports = { startServer };
  