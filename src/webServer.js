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
        case "/lightingScenes":
            // console.log("Lighting Scenes list requested");
            response.json(withStateTopic(lightingScenes, function(e) { return 'apollo/home/scene/' + e.id + '/state'; }));
            break;
        case "/macros":
            // console.log("Macros list requested");
            response.json(withStateTopic(macros, function(e) { return 'apollo/home/macro/' + e.id + '/state'; }));
            break;
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
  