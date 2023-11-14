[Overview](../README.md) &nbsp;&nbsp;&nbsp;|&nbsp;&nbsp;&nbsp; [🧭 Installation](./installation.md) &nbsp;&nbsp;&nbsp;|&nbsp;&nbsp;&nbsp; [🛠️ Maintenance](./maintenance.md) &nbsp;&nbsp;&nbsp;|&nbsp;&nbsp;&nbsp; <u>🔮 Roadmap</u>

### To Fix
1. Fix PM2 Monitor Setup
2. Fix Away Scene
3. Fix Office Lighting Scene
4. DMX Update
  - Make manual off turn the fixture off
  - Update scenes via JSON push
5. Troubleshoot echo link inconsistently connecting to receiver
6. Intston keypad
    - Button blink groups
    - [Multi-linking keypads](https://www.youtube.com/watch?v=ZbWiIS6Tuzw)
7. Replace bedroom switch
8.  Blackout shades
    - Reinstall shade 1
9.  Projector reliability
    Watch for reliability issues with projector DHCP. It seems to lose IP for no apparent reason and must be toggled. Connection was checked.
10. Catch error on timeout connecion to devices. Serial and somfy-bridge devices currectly crash the applicaiton.

### Roadmap Functionality

1. Somfy STOP position capability
2. Ping devices 
   - @ startup to confirm ability to connect
   - Via browser checkup function
3. DMX Controller
    - Add support for dimming
    - Add support for color
4. Alexa Smart Home Skills Implementation
    - Light colors
    - Push failure response back to Alex API
    - Consider possibly going direct to nGrok with SQS as failover 
    improve first run performance by eliminating Lambda startup delay
5. Improve Apple Homekit bridge support
    - Auto populate from device database
6. Blink front light for Uber dropoff
7. Shade halfway capability (STOP command)
8. Deploy AUTH for web application
    http://passportjs.org/
9. Add color capabilities from Alexa API
    - Bridge Alex SmartHome Color capabilities
        Probably not needed because names can overlap in Alexa and device with the capability takes priority.
        Hack may stop working at some point
10. Create marco off commands
    - Turn off Movie Mode
11. Mood effort lighting > rotate color slowly via built in API function
12. Install Ring Video Doorbell
13. Consider implementing MQTT
    - Allows state awareness in Alexa ecosystem
    - Easier to manage devices and capabilities
    - Fixes legacy issues
    - Adopts and IoT standard that can bridge to other ecosystems
    - Similar to:
    https://github.com/ai91/AlexaSmartHome.MQTT.bridge
    https://github.com/i8beef/HomeAutio.Mqtt.GoogleHome
    https://github.com/mhdawson/AlexaMqttBridge
    https://github.com/terafin/mqtt-alexa-bridge/blob/master/README.md
    https://aws.amazon.com/iot-core/
    https://aws.amazon.com/blogs/iot/implement-a-connected-building-with-alexa-and-aws-iot/
    https://medium.com/captech-corner/automating-a-tower-fan-with-alexa-skills-aws-lambda-aws-iot-and-an-esp32-ad0d4ba1da22
    https://github.com/TD22057/insteon-mqtt
14. Email\Push Notification of Failures
    - Run uptime service cross-cheker to alert when systems are down
    - Apollo
    - BeagleBone Apollo Home Control
    - BeagleBone Somfy
    - Lambda Service
15. Integration with Home Assistant for eventual migration
    - https://home-assistant.io/
16. Bridge Siri commands via Homebridge
    https://github.com/nfarina/homebridge
    https://github.com/KhaosT/HAP-NodeJS
    ** Might be an alternative to building an internet accessible website
17. Permenant button for Somfy shades
18. Morning somfy shades for bedroom (rise with the sun)
19. Better setup of serial commands
    - Delays were added to address unreliable power off of receiver. 
    - Probably better to delay sending commands until previous commands are received
    - Should add command queue that transmits with a short delay
    - Delay before disconnect
    - Keep active serial connection and use if available.
    - Parse commands received from devices