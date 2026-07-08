/**
 * Apollo Home Control Bridge - Alexa Triggers Update Module
 * @module alexaTriggers.js
* 
 * @author Ray Perfetti
 * @date 2021-10-05
 * 
 * @description Builds a JSON file of triggers for Alexa.
 *              The JSON file can (optionally) be saved to an AWS S3 bucket used by the Lambda function for the Alexa skill.
 *              Since configuration is done only when config files are manually updated, this is run only when
 *              the program is first started. Updates are not continuously needed.
 * 
 *              Dependencies (all optional):
 *              - S3 bucket created in AWS
 *              - AWS credentials with access to the S3 bucket in .env file
 *              - AWS SDK for JavaScript installed
 *                  npm install @aws-sdk/client-s3
 *              - dotenv installed
 *                  npm install dotenv
 * 
 */


// isAlexaStateful is pure/config-free (no ensureInit(), no require('../index')
// or require('./mqttClient') at call time) -- see the comment above its
// definition in mqttTopics.js. That's what makes it safe to import here at
// module load time: this module runs at Apollo startup, immediately after
// index.js has finished exporting (see index.js: alexaTriggers is required
// right after mqttClient), and merely importing mqttTopics.js must not
// trigger its lazy config/broker init before the rest of startup is ready
// for that.
const { isAlexaStateful } = require('./mqttTopics');

/**
 * Builds the Alexa triggers array from the given config arrays. Pure --
 * no fs access -- so it's testable without writing config/triggers.json.
 *
 * For each config entry's first (index 0) invocation, where endpointId ===
 * entry.id (i.e. NOT an alias endpoint like "shades-2"), stamps
 * "statefulMqtt": true when the entry qualifies per isAlexaStateful(). Alias
 * endpoints stay stateless -- they share the same underlying device state as
 * the primary endpoint, and Alexa should only treat one endpoint per physical
 * device as the source of truth for ReportState.
 *
 * @param {object} configs
 * @param {Array} configs.devices
 * @param {Array} configs.deviceScenes
 * @param {Array} configs.lights
 * @param {Array} configs.lightingScenes
 * @param {Array} configs.macros
 * @returns {Array} the triggers array (unwritten)
 */
function buildTriggersArray({ devices, deviceScenes, lights, lightingScenes, macros }) {

    let triggersBuild = [];
    let endpointIdValue = "";
    // Build Lights
    for (const light of lights) {
        if(light.alexa) {
            for (const [index, invocation] of light.alexa.invocations.entries()) {
                endpointIdValue = light.id;
                if(index>0)
                endpointIdValue = light.id + "-" + (index+1);
            const trigger = {
                "endpointId": endpointIdValue,
                "friendlyName": light.alexa.invocations[index],
                "displayCategories": light.alexa.displayCategories,
                "apiModule": "LIGHTS",
                "apiDevice": light.id,
                "isDimmable": light.alexa.isDimmable,
                "location": light.location || "home",
                "mqttName": light.mqttName || light.id
            };
            if (index === 0 && isAlexaStateful(light)) {
                trigger.statefulMqtt = true;
            }
            triggersBuild.push(trigger);
            }
        }
    }

    // Build Lighting Scenes
    for (const lightingScene of lightingScenes) {
        if(lightingScene.alexa) {
            for (const [index, invocation] of lightingScene.alexa.invocations.entries()) {
                endpointIdValue = lightingScene.id;
                if(index>0)
                    endpointIdValue = lightingScene.id + "-" + (index+1);
                triggersBuild.push({
                    "endpointId": endpointIdValue,
                    "friendlyName": lightingScene.alexa.invocations[index],
                    "displayCategories": lightingScene.alexa.displayCategories,
                    "apiModule": "LIGHTINGSCENES",
                    "apiDevice": lightingScene.id,
                    "isDimmable": lightingScene.alexa.isDimmable,
                    "location": lightingScene.location || "home",
                    "mqttName": lightingScene.mqttName || lightingScene.id
                });
            }
        }
    }

    // Build Macros
    for (const macro of macros) {
        if(macro.alexa) {
            for (const [index, invocation] of macro.alexa.invocations.entries()) {
                endpointIdValue = macro.id;
                if(index>0)
                    endpointIdValue = macro.id + "-" + (index+1);
                triggersBuild.push({
                    "endpointId": endpointIdValue,
                    "friendlyName": macro.alexa.invocations[index],
                    "displayCategories": macro.alexa.displayCategories,
                    "apiModule": "MACROS",
                    "apiDevice": macro.id,
                    "location": macro.location || "home",
                    "mqttName": macro.mqttName || macro.id
                });
            }
        }
    }

    // Build Device Scenes
    for (const deviceScene of deviceScenes) {
        if(deviceScene.alexa) {
            for (const [index, invocation] of deviceScene.alexa.invocations.entries()) {
                endpointIdValue = deviceScene.id;
                if(index>0)
                    endpointIdValue = deviceScene.id + "-" + (index+1);
                triggersBuild.push({
                    "endpointId": endpointIdValue,
                    "friendlyName": deviceScene.alexa.invocations[index],
                    "displayCategories": deviceScene.alexa.displayCategories,
                    "apiModule": "DEVICESCENES",
                    "apiDevice": deviceScene.id,
                    "location": deviceScene.location || "home",
                    "mqttName": deviceScene.mqttName || deviceScene.id
                });
            }
        }
    }

    // Build Devices
    let apiModule = "";
    let apiCommand = "";
    let isLock = false;
    let isAC = false;
    let isSpeaker = false;
    let isPercentageController = false;

    for (const device of devices) {

        if(device.alexa) {

            endpointIdValue = device.id;
            apiModule = "DEVICES";

            isLock = false;
            if (device.alexa.isLock){
                isLock = true;
                apiModule = "LOCKS";
            }
            
            isAC = false;
            if (device.alexa.isAC){
                isAC = true;
                apiModule = "AC";
            }

            isSpeaker = false;
            if (device.alexa.isSpeaker){
                isSpeaker = true;
                apiModule = "SPEAKERS";
            }

            isPercentageController = false;
            if (device.alexa.isPercentageController){
                isPercentageController = true;
            }


            for (const [index, invocation] of device.alexa.invocations.entries()) {

                if(index>0)
                    endpointIdValue = device.id + "-" + (index+1);

                // Include the command if it is specified
                apiCommand = false;
                if (device.alexa.apiCommand) 
                    apiCommand = device.alexa.apiCommand[index];

                const trigger = {
                    "endpointId": endpointIdValue,
                    "friendlyName": device.alexa.invocations[index],
                    "displayCategories": device.alexa.displayCategories,
                    "apiModule": apiModule,
                    "apiDevice": device.id,
                    "apiCommand": apiCommand,
                    "isLock": isLock,
                    "isAC": isAC,
                    "isSpeaker": isSpeaker,
                    "isPercentageController": isPercentageController,
                    "location": device.location || "home",
                    "mqttName": device.mqttName || device.id
                };
                if (index === 0 && isAlexaStateful(device)) {
                    trigger.statefulMqtt = true;
                }
                triggersBuild.push(trigger);

            }
        }
    }

    return triggersBuild;
}

/**
 * Builds the triggers array from Apollo's live config (via require('../index'))
 * and writes it to config/triggers.json. Thin fs-writing wrapper around the
 * pure buildTriggersArray() -- kept separate so tests can exercise the
 * trigger-building logic against injected fixture config without touching
 * the filesystem.
 *
 * The require('../index') here is deliberately lazy (inside the function,
 * not at module scope) so that merely requiring this module -- as
 * test/alexaTriggers.test.js does, to reach the pure buildTriggersArray() --
 * never boots the whole Apollo config-loading chain. Production's only
 * caller (index.js) already invokes this after index.js has finished
 * exporting, same load-order rule as every other src/ module.
 *
 * The write is synchronous (fs.writeFileSync) rather than fs.writeFile --
 * deliberately. index.js calls buildTriggers() synchronously at startup,
 * immediately followed (same synchronous call stack) by
 * mqttCommandListener.js's startCommandListener() -> ensureInit(), which
 * reads config/triggers.json back with fs.readFileSync. With an async write,
 * that later synchronous read can race ahead of the write actually landing
 * on disk, hitting a truncated/empty file. Writing synchronously guarantees
 * triggers.json is fully flushed before buildTriggers() returns, so every
 * later synchronous startup step sees the complete file. One small JSON
 * file, once at startup -- the added latency is negligible.
 */
function buildTriggers(){

    const { devices, deviceScenes, lights, lightingScenes, macros } = require('../index');
    const triggersBuild = buildTriggersArray({ devices, deviceScenes, lights, lightingScenes, macros });

    const fs = require('fs');

    let data = JSON.stringify(triggersBuild, null, 4);
    // console.log(data);

    try {
        fs.writeFileSync("./config/triggers.json", data);
        console.log(`Updated triggers.json`);
    } catch (err) {
        // Keep startup resilient -- a write failure here must not throw out
        // of buildTriggers() and crash Apollo's boot sequence (same
        // graceful-degradation intent as the previous async callback's
        // error branch).
        console.error('Error writing to triggers.json:', err);
    }

}

module.exports = {
    buildTriggers,
    buildTriggersArray
}

/*

// This function can write the triggers to an AWS S3 bucket for the Lamda function to read.
// For efficiency, this is commented out because updates are not needed frequently.
// Writing the triggers.JSON directly to the lambda function reduces a step in the time sensitive call function.
//
// Uncomment the function call in buildTriggers() to enable.

// Load environment variables from .env file
require('dotenv').config();

const { S3Client, PutObjectCommand } = require("@aws-sdk/client-s3");

const s3Client = new S3Client({
  region: process.env.AWSregion,
  credentials: {
    accessKeyId: process.env.AWSaccessKeyId,
    secretAccessKey: process.env.AWSsecretAccessKey,
  },
});

async function saveTriggersToS3(triggers) {
    try {
        const command = new PutObjectCommand({
            Bucket: process.env.AWSS3BucketName,
            Key: process.env.AWSFileName,
            Body: JSON.stringify(triggers),
            ContentType: 'application/json'
        });

        await s3Client.send(command);
        console.log('Triggers saved to S3');
    } catch (error) {
        console.error('Error saving triggers to S3:', error);
        throw error;
    }
}

module.exports = {
    saveTriggersToS3
}
*/