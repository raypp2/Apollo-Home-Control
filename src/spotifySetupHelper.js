/*

SPOTIFY SETUP HELPER

THIS IS NOT PART OF THE MAIN APPLICATION
It is used only for setup and testing, specifically to get a refresh token from Spotify.

The step-by-step instructions are at the bottom of this file.

It requires that a logged in user ALLOWS access to the needed scopes after a prompt.
To avoid writing a full OAuth2 flow, we can get the refresh token manually using the following steps:
It's unclear how long a refresh token lasts but it seems to be "a long time."

Here is a helpful guide: 
https://benwiz.com/blog/create-spotify-refresh-token/

Below are functions with manual calls at the bottom to grab this data and test it with our main module.

*/

require('dotenv').config();                                 // Load environment variables from .env file

var SpotifyWebApi = require('spotify-web-api-node');
var spotifyApi = new SpotifyWebApi({
    clientId: process.env.spotifyClientId,
    clientSecret: process.env.spotifyClientSecret,
    redirectUri: process.env.spotifyRedirectUri
});

// For testing if the token is valid
const { spotifySwitchPlay } 
        = require('./spotify.js');


function getSpotifyAuthURL (){
  var scopes = ['user-read-playback-state', 'user-modify-playback-state'],
  redirectUri = 'https://www.google.com',
  clientId = '6e1a7a2d6c5e4bb69125e465ba4770fb',
  state = 'delete-me';

// Setting credentials can be done in the wrapper's constructor, or using the API object's setters.
var spotifyApi = new SpotifyWebApi({
  redirectUri: redirectUri,
  clientId: clientId
});

// Create the authorization URL
var authorizeURL = spotifyApi.createAuthorizeURL(scopes, state);

// https://accounts.spotify.com:443/authorize?client_id=5fe01282e44241328a84e7c5cc169165&response_type=code&redirect_uri=https://example.com/callback&scope=user-read-private%20user-read-email&state=some-state-of-my-choice
console.log(authorizeURL);
}

function getSpotifyTokens(spotifyCode){
    var credentials = {
        clientId: process.env.spotifyClientId,
        clientSecret: process.env.spotifyClientSecret,
        redirectUri: process.env.spotifyRedirectUri
      };
      
      var spotifyApi = new SpotifyWebApi(credentials);
      
      // Retrieve an access token and a refresh token
      spotifyApi.authorizationCodeGrant(spotifyCode).then(
        function(data) {
          console.log('The token expires in ' + data.body['expires_in']);
          // console.log('The access token is ' + data.body['access_token']);
          console.log('The refresh token is ' + data.body['refresh_token']);
      
          // Set the access token on the API object to use it in later calls
          // spotifyApi.setAccessToken(data.body['access_token']);
          spotifyApi.setRefreshToken(data.body['refresh_token']);
        },
        function(err) {
          console.log('Something went wrong!', err);
        }
      );
}

// Setup Spotify
//
//
//  STEP 1
//  Get an authentication URL
// getSpotifyAuthURL();
//
//  STEP 2
//  Hit the authentication URL, get the code from the redirected URL
//      and enter it below as the spotifyCode
//
//  STEP 3
//  Get the refresh token
// var spotifyCode = "ENTER CODE HERE";
// getSpotifyTokens(spotifyCode);
//
//  STEP 4
//  Put the refresh token in .env and test the function below
// var deviceID = "5f0fdd408926f5bdef26cfabcf930cb4c4f43a3a";
// spotifySwitchPlay(deviceID,1);
//
//  STEP 5
//  Write the token to .env