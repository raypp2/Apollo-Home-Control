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
const { devices, deviceScenes, lights, lightingScenes, macros, logging }                                  
        = require('../index');

// Orchestration Handlers
const { handleRequest }                                   
        = require('./handler');


var express = require('express');
var app = express();
app.use(express.static('public'));
// const mDNS = require('bonjour')();


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
            response.json(devices);
            break;
        case "/deviceScenes":
            // console.log("Device Scenes list requested");
            response.json(deviceScenes); 
            break;
         case "/lights":
            // console.log("Lights list requested");
            response.json(lights);
            break;
        case "/lightingScenes":
            // console.log("Lighting Scenes list requested");
            response.json(lightingScenes);
            break;
        case "/macros":
            // console.log("Macros list requested");
            response.json(macros);
            break;
        default:
            response.status(404).send("ERROR: You must specify a valid list -- devices, deviceScenes, lights, lightingScenes, or macros.")
    }
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
  