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


// Load variables
const { devices, deviceScenes, lights, lightingScenes, macros, logging }                                  
        = require('../index');


/**
 * Builds an array of Alexa triggers based on the configuration of the devices, lighting scenes, and macros.
 * The resulting array is written to a JSON file.
 */
function buildTriggers(){

    let triggersBuild = [];
    let endpointIdValue = "";
    // Build Lights
    for (const light of lights) {
        if(light.alexa) {
            for (const [index, invocation] of light.alexa.invocations.entries()) {
                endpointIdValue = light.id;
                if(index>0)
                endpointIdValue = light.id + "-" + (index+1);
            triggersBuild.push({
                "endpointId": endpointIdValue,
                "friendlyName": light.alexa.invocations[index],
                "displayCategories": light.alexa.displayCategories,
                "apiModule": "LIGHTS",
                "apiDevice": light.id,
                "isDimmable": light.alexa.isDimmable,
            });
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
                    "apiDevice": lightingScene.id
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
                    "apiDevice": macro.id
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
                    "apiDevice": deviceScene.id
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


            for (const [index, invocation] of device.alexa.invocations.entries()) {

                if(index>0)
                    endpointIdValue = device.id + "-" + (index+1);

                // Include the command if it is specified
                apiCommand = false;
                if (device.alexa.apiCommand) 
                    apiCommand = device.alexa.apiCommand[index];

                triggersBuild.push({
                    "endpointId": endpointIdValue,
                    "friendlyName": device.alexa.invocations[index],
                    "displayCategories": device.alexa.displayCategories,
                    "apiModule": apiModule,
                    "apiDevice": device.id,
                    "apiCommand": apiCommand,
                    "isLock": isLock,
                    "isAC": isAC,
                    "isSpeaker": isSpeaker
                });

            }
        }
    }

    const fs = require('fs');

    let data = JSON.stringify(triggersBuild, null, 4);
    // console.log(data);

    fs.writeFile("./config/triggers.json", data, (err) => {
        if (err) {
            console.error('Error writing to triggers.json:', err);
        } else {
            console.log(`Updated triggers.json`);
        }
    });

}

module.exports = {
    buildTriggers
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