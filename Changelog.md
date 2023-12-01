## Version 5.0.2  -  Dec 1, 2023
- Added support to play Spotify URI (Song, Playlist, Album) and stop playback
- Replaced Somfy controller with ESPSomfyRTS

## Version 5.0.1  -  Nov 15, 2023
- Added support for Shelly devices (on/off)
- Added support for DMX dimming
- Added support for WLED devices (on/off)
- Fixed issue with Spotify where device ID would change. Use device name instead.

## Version 5.0  -  Oct 12, 2023

#### Major updates - Frameworks
- Updated to latest versions of Node JS 
- Updated to latest version of most dependent node modules (i.e. AWS)
- Updated to latest Alexa Smarthome Skills API & Payload format
- Updated front-end frameworks (Angular, Materialize)
- Replaced forever process manager with pm2

#### Major updates - Code Maintainability 
- Separated code into logical modules
- Refactored api & SQS handlers to standard pattern MODULE / DEVICE / COMMAND / PARAM1 / PARAM2
- Refactored UI to auto-generate controls based on config files
- Added JS Doc documentation to all modules and key functions
- Prepared for github
- Moved sensitive variables to .env
- Created overall documentation

#### Major updates - Features
- Added support for DMX fixtures and scenes
- Added support for device specific voice models (Themostats,Locks,Speakers)

#### Minor updates & bug fixes
- Fixed blackout shades
- Fixed Spotify
- Migrated from PS4 to PS5 (waker & game launcher removed)
- Improved overall error handling
- Remove PS4 support
- Clean up unused packages and dependencies
- Add support for mDNS for apollo.local access	
- Tested on Debian 12


### Version 4  -  Mar 03, 2019 (config Oct 22, 2022)

#### Added functionality
- Support for find-my-iphone
- Added Playstation Functionality
  - Wake from standby
  - Put in standby
  - Open Applications (ex: Spotify, Overwatch)
- Spotify Connect Functionality
- Insteon Keypad Linc and MiniRemotes Support
  - Allow buttons to trigger commands
  - Updates the lighted status of buttons
  - via home-control module


#### Minor Updates

- Removed functionliaty: PLUM lighing control
- Insteon Devices - New switches for Living Room, Dining Room, Kitchen, Bedroom



### Version 3

- Created Forever JSON with mapping of logs files to "logs" folder on the public shared director
- Create a macro device type
- Removed functionality:
  - Local Serial Commands
  - Windows Loading Applications
  - Windows Loading Websites
  - Windows Spotify Control