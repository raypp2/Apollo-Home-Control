/**
 * Apollo Home Control Bridge - Insteon Listener Module
 * @module lightingInsteonListener.js
 * 
 * @author Ray Perfetti
 * @date 2023-10-08
 * 
 * @description  Monitors the status of devices on Insteon.
 *               This status polling is used to update the status of the device in the UI.
 * 
 *               KeyPad Linc Features
 *               Responds to a Keypad Linc button press by executing a command.
 *               Feedback can be provided to the user by blinking the button twice.
 * 
 *               Dependencies:
 *               - Insteon Hub (tested with 2245-222)
 *               - home-controller by Automate Green (Brandon Goode)
 *                       https://github.com/automategreen/home-controller
 * 
 */

'use strict';

// Load variables
const { devices, deviceScenes, lights, lightingScenes, macros, insteonKeypad, logging }                                  
        = require('../index');

const lights_new = lights;
const insteon_keypad = insteonKeypad;


//### Variables for Keypress Watcher
var last_command;
var last_command_flag = false;

var Insteon = require('home-controller').Insteon;
var hub = new Insteon();

var config = {
  host: process.env.INSTEON_HUB_IP,
  port: 25105,
  user: process.env.INSTEON_USERNAME,
  password: process.env.INSTEON_PASSWORD
};


function startListener(handleRequest) {

    hub.httpClient(config, function(){
    console.log('Insteon listener connected!');

    hub.emitOnAck = false;

    hub.on('command', function(info){
        // console.log("Command Observed:",info);
        if (info !== undefined){
        if (info.standard !== undefined){
        if (info.standard.id !== undefined){
        if (typeof info.standard.id !== undefined) {
        isKeypadPress(info,handleRequest);
        }}}}
    });  

    // insteon_setup_devices();  // Polls and creates listeners for devices to keep status updated on interfaces
    // holding until web interface is fixed.
    // Might create issues with Keypad watchers
    });

}

function insteon_setup_devices () {

  console.log("Setting up all devices.");

  for(i = 0; i < lights_new.length; i++){
    insteon_device_status_poll(i);
    insteon_status_listener(i);
  }
}

function insteon_device_status_poll (i) {

  var light_address   = lights_new[i].address;
  var light_title     = lights_new[i].title;
  var light_type      = lights_new[i].type;

  if(light_type=="insteon") {

    console.log("X - Polling %s", light_title);

    hub.light(light_address).level().then(function(lvl){
          lights_new[i].status = lvl;
          console.log("X - Light %s is %s", light_title, lights_new[i].status);
          if(lvl>0){
            lights_new[i].checked = true;
          }else{
            lights_new[i].checked = false;
          }

    });
  }
}

function insteon_status_listener (i) {

  var light_address   = lights_new[i].address;
  var light_title     = lights_new[i].title;
  var light_type      = lights_new[i].type;

  console.log("X - Creating listeners for %s", light_title);

  hub.light(light_address).on('turnOn', function () {
    console.log("X - Light turned on %s", light_title);
    lights_new[i].status = 100;
    lights_new[i].checked = true;
  });

  hub.light(light_address).on('turnOff', function () {
    console.log("X - Light turned off", light_title);
    lights_new[i].status = 0;
    lights_new[i].checked = false;
  });
}


/*
############# INSTEON MODULE FOR RECEIVING BUTTON COMMANDS

*/

function isKeypadPress(info,handleRequest) {
  var commandDevice =   info.standard.id           || false;
  var commandGateway  = info.standard.gatewayId    || false;
  var commandCommand1 = info.standard.command1     || false;
  var commandCommand2 = info.standard.command2     || false;  

  for(var i = 0;i < insteon_keypad.length; i++){
    if(insteon_keypad[i].device_id==commandDevice){
      // console.log("X - Observed a command from devices #%d @ %s to gateway %s",i,commandDevice,commandGateway);
      // console.log("Command Observed:",info);
      var testGateways    = insteon_keypad[i].gateways || false;

      for(var z = 0;z<testGateways.length;z++){
          (function (p) {
            if(testGateways[p].id==commandGateway){
                var commandName = testGateways[p].name;
                // console.log("X - This is a watched gateway #%d %s",p,commandName);

                // Load the ON or OFF commands
                if (commandCommand1=="11" && commandCommand2=="00"){
                    var runCommand = testGateways[p].command_on;
                } else if(commandCommand1=="13" && commandCommand2=="00"){
                    var runCommand = testGateways[p].command_off;
                }

                // Test for duplicate
                if (last_command==runCommand) {
                  // console.log("X - Disregarding because action was recently run: %s",last_command);
                } else {
                  console.log("X - Running %s", runCommand);
                  handleRequest("/"+runCommand);

                  last_command=runCommand;
                  last_command_flag=true;
                }
            }
          }) (z)
      }
    }
  }
}

module.exports = {
    startListener
    };