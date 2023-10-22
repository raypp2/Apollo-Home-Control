/**
 * Apollo Home Control Bridge - DMX Module
 * @module lightingDmx.js
 * 
 * @author Ray Perfetti
 * @date 2023-10-11
 * 
 * @description     Functions to control DMX fixtures
 *                  - Support for DMX microcontroller bridge via API
 *                  - Turn on/off a DMX scene
 *                  - Turn on/off a DMX Fixture's Preset
 * 
 *                 Dependencies:
 *                - Axios - Makes HTTP requests
 * 
 */


const axios = require('axios');

const api = axios.create({
    baseURL: "http://" + process.env.DMX_BRIDGE_IP,
    headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
    }
});

function dmx_scene_command(debugId, sceneId, command) {
    // Ensure the inputs are valid before making the request
    command = command.toLowerCase();
    const validCommands = ['on', 'off'];

    if (!validCommands.includes(command)) {
        console.error('%d - Invalid scene name or command provided.', debugId);
        return Promise.reject('Invalid input');
    }

    const data = `id=${sceneId}&command=${command}`;

    api.post('/updateScene', data)
        .then(response => {
            console.log('%d - Response from bridge:', debugId, response.data);
        })
        .catch(error => {
            console.error('%d - Error updating scene:', debugId, error);
        });
}

function dmx_fixture_command(debugId, fixtureId, preset, command) {

    command = command.toLowerCase();
    preset = preset.toLowerCase();
    const data = `id=${fixtureId}&command=${command}&preset=${preset}`;

    api.post('/updateFixture', data)
        .then(response => {
            console.log('%d - Response from bridge:', debugId, response.data);
        })
        .catch(error => {
            console.error('%d - Error updating fixture:', debugId, JSON.stringify(error));
        });
}

module.exports = {
    dmx_scene_command,
    dmx_fixture_command
};