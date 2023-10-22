/**
 * Apollo Home Control Bridge - SQS Listener Module
 * @module sqsListener.js
* 
 * @author Ray Perfetti
 * @date 2021-10-05
 * 
 * @description This module polls an AWS SQS queue for messages and processes them.
 *              It provides a way to safely and reliably receive commands from Alexa or
 *              another system without opening a port into your network.
 * 
 *              The polling function, receiveMessages(), must be called in a continuous loop by the main application.
 *              Messages in SQS are sent to handleRequest(message) for processing.
 * 
 *              Dependencies:
 *              - SQS queue created in AWS
 *              - AWS credentials with access to the SQS queue in .env file
 *              - AWS SDK for JavaScript installed
 *                  npm install @aws-sdk/client-sqs
 *              - dotenv installed
 *                  npm install dotenv
 * 
 */

'use strict';

// Load environment variables from .env file
require('dotenv').config(); 

// Orchestration Handlers
const { handleRequest }                                   
        = require('./handler');

const { SQSClient, ReceiveMessageCommand, DeleteMessageCommand } = require('@aws-sdk/client-sqs');

// The maximum time to wait for a message in seconds. This long polling reduces the number of 
// requests to SQS while still responding nearly instantly when a message is received.
const MESSAGE_LONG_POLLING = 20; 

// The maximum age of a message (command sent via SQS) in seconds. Since this is primarily for a smart home, 
// anything longer than a few seconds is likely an error. This prevents the server from processing old messages
const MESSAGE_AGE_LIMIT_SECONDS = 5; 


// Ensure the environment variables are loaded correctly
const requiredEnvVariables = ['AWSregion', 'AWSaccessKeyId', 'AWSsecretAccessKey', 'AWSQueueURL'];
for (const varName of requiredEnvVariables) {
  if (!process.env[varName]) {
    console.error(`Environment variable ${varName} is not set correctly`);
    process.exit(1);
  }
}

const sqsClient = new SQSClient({
  region: process.env.AWSregion,
  credentials: {
    accessKeyId: process.env.AWSaccessKeyId,
    secretAccessKey: process.env.AWSsecretAccessKey,
  },
});

// Simple in-memory cache to store processed message IDs
const processedMessageIds = new Set();

const receiveMessages = async () => {
  try {
    const data = await sqsClient.send(new ReceiveMessageCommand({
      QueueUrl: process.env.AWSQueueURL,
      AttributeNames: ['ApproximateFirstReceiveTimestamp', 'ApproximateReceiveCount', 'SentTimestamp'],
      MessageAttributeNames: ['All'],
      WaitTimeSeconds: 20,
    }));

    if (!data.Messages) return;

    for (const message of data.Messages) {
      // Check if the message has been processed before
      if (processedMessageIds.has(message.MessageId)) {
        console.log("###### Duplicate Message Skipped ######");
        console.log("MessageId: %s", message.MessageId);
        console.log("## END ###############################\n\n");
        continue;
      }

      /*
      Useful for debugging
      console.log("###### RAW JSON Output");
      console.log("Message Received: %s", JSON.stringify(message));
      */

      console.log("\n\n###### SQS Message Received ######");
      console.log("Message Body: %s", message.Body);
      console.log("\nApproximate Receive Count: %s", message.Attributes.ApproximateReceiveCount);
      console.log("SQS Measured Duration: %s ms", message.Attributes.ApproximateFirstReceiveTimestamp - message.Attributes.SentTimestamp);
      console.log("LOCAL Measured Duration: %s ms", Date.now() - message.MessageAttributes.local_timestamp.StringValue);
      console.log("##################################\n");

              
      // Disregard the message if it's older than MESSAGE_AGE_LIMIT_SECONDS 
      // This addresses are issue where:
      // (A) The server crashes or is turned off intentionally 
      // (B) Alexa or another system posts a number of messages
      // (C) The server is manually restarted
      // (D) The server is processing messages that are hours or days old
      // Another approach is to set the "Message retention period" in the SQS queue settings (minimum 60 seconds)

      // Calculate the message age in seconds
      const messageAgeInSeconds = (Date.now() - parseInt(message.Attributes.SentTimestamp)) / 1000;

      if (messageAgeInSeconds > MESSAGE_AGE_LIMIT_SECONDS) {
        console.log("###### Skipped Old Message ######");
        console.log("Message Age: %s seconds", messageAgeInSeconds);
        // Delete the old message from the queue and skip to the next iteration of the loop
        await deleteMessage(message.ReceiptHandle);
        continue;
      }

      // After successfully processing the message, attempt to delete it from the queue
      await deleteMessage(message.ReceiptHandle);
      
      // Handle the message
      handleRequest(message.Body);
    }
  } catch (err) {
    console.error(err);
  }
};

const deleteMessage = async (receiptHandle) => {
  try {
    await sqsClient.send(new DeleteMessageCommand({
      QueueUrl: process.env.AWSQueueURL,
      ReceiptHandle: receiptHandle,
    }));
    // console.log("###### Message deleted successfully");
    // console.log("###### END ###############################\n\n");
  } catch (deleteErr) {
    console.error("Error deleting message:", deleteErr);
  }
};


const startListener = async () => {
  console.log("###### SQS Listener Started ######");
  while (true) {
    await receiveMessages();
  }
};

module.exports = { startListener };

/*
// This is the main loop that polls the SQS queue for messages
// Runs locally for testing

(async function poll() {
  while (true) {
    await receiveMessages();
  }
})();
*/