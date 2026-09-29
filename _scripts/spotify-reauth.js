#!/usr/bin/env node
/**
 * Re-authorizes Apollo with Spotify and installs the new refresh token.
 *
 * Spotify occasionally revokes the stored refresh token (password change,
 * app access removed, or Spotify expiring it). Every Spotify call then fails
 * with `invalid_grant`, and the dashboard shows "Spotify disconnected --
 * sign-in expired". This replaces the manual edit-and-uncomment steps in
 * src/spotifySetupHelper.js with one command:
 *
 *   node _scripts/spotify-reauth.js            # update local .env AND the Pi's, restart Apollo
 *   node _scripts/spotify-reauth.js --local    # update the local .env only
 *
 * Steps: prints a Spotify sign-in link; you approve access in a browser and
 * paste back the URL Spotify redirected you to (or just its `code` value);
 * the script exchanges it for tokens, checks the new token works, writes
 * `spotifyRefreshToken` into .env, and (unless --local) writes it into the
 * Pi's .env over ssh and restarts Apollo.
 *
 * Needs spotifyClientId / spotifyClientSecret / spotifyRedirectUri in the
 * local .env, and spotifyRedirectUri must be listed as a Redirect URI in the
 * Spotify developer dashboard for that app. The token is never printed and
 * never passed on a command line (it goes to the Pi over ssh stdin).
 *
 * Pi target: APOLLO_PI_HOST (default admin@pi.local) and APOLLO_PI_DIR
 * (default /home/admin/apollo_home_control).
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const readline = require('readline');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const ENV_PATH = path.join(ROOT, '.env');
require('dotenv').config({ path: ENV_PATH });
const SpotifyWebApi = require('spotify-web-api-node');

// Everything src/spotify.js calls: playback state + devices (read),
// play / pause / transfer (modify).
const SCOPES = ['user-read-playback-state', 'user-modify-playback-state', 'user-read-currently-playing'];
const PI_HOST = process.env.APOLLO_PI_HOST || 'admin@pi.local';
const PI_DIR = process.env.APOLLO_PI_DIR || '/home/admin/apollo_home_control';
const LOCAL_ONLY = process.argv.includes('--local');

function fail(msg) {
    console.error(`\n✖ ${msg}`);
    process.exit(1);
}

function ask(question) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    return new Promise((resolve) => rl.question(question, (answer) => {
        rl.close();
        resolve(answer.trim());
    }));
}

/**
 * Returns `text` with KEY=value set (replacing an existing line, else
 * appending one). Other lines, comments and ordering are left untouched.
 */
function setEnvValue(text, key, value) {
    const line = `${key}=${value}`;
    const re = new RegExp(`^${key}=.*$`, 'm');
    if (re.test(text)) {
        return text.replace(re, () => line);
    }
    return text + (text.endsWith('\n') || text === '' ? '' : '\n') + line + '\n';
}

/** Pulls `code` out of a pasted redirect URL (or accepts a bare code). */
function extractCode(input, expectedState) {
    if (!/^https?:\/\//i.test(input)) {
        return input;
    }
    const url = new URL(input);
    if (url.searchParams.get('error')) {
        fail(`Spotify returned an error: ${url.searchParams.get('error')}`);
    }
    if (url.searchParams.get('state') !== expectedState) {
        fail('The pasted URL is from a different sign-in attempt (state mismatch). Run the script again.');
    }
    const code = url.searchParams.get('code');
    if (!code) {
        fail('No `code` parameter in the pasted URL.');
    }
    return code;
}

async function main() {
    const { spotifyClientId, spotifyClientSecret, spotifyRedirectUri } = process.env;
    if (!spotifyClientId || !spotifyClientSecret || !spotifyRedirectUri) {
        fail(`spotifyClientId, spotifyClientSecret and spotifyRedirectUri must be set in ${ENV_PATH}`);
    }
    const api = new SpotifyWebApi({
        clientId: spotifyClientId,
        clientSecret: spotifyClientSecret,
        redirectUri: spotifyRedirectUri,
    });

    const state = crypto.randomBytes(8).toString('hex');
    // show_dialog forces the approval screen even if access was granted before.
    const authorizeURL = api.createAuthorizeURL(SCOPES, state, true);

    console.log('\n1. Open this link and approve access with the Spotify account Apollo should control:\n');
    console.log(`   ${authorizeURL}\n`);
    console.log(`2. Spotify redirects to ${spotifyRedirectUri}?code=... (the page itself may not load; that's fine).`);
    const pasted = await ask('   Paste that full URL here (or just the code): ');
    if (!pasted) {
        fail('Nothing pasted.');
    }
    const code = extractCode(pasted, state);

    let refreshToken;
    try {
        const grant = await api.authorizationCodeGrant(code);
        refreshToken = grant.body.refresh_token;
        api.setAccessToken(grant.body.access_token);
    } catch (err) {
        fail(`Token exchange failed: ${(err && err.body && JSON.stringify(err.body)) || err.message}. Codes are single-use and expire quickly; run the script again.`);
    }
    if (!refreshToken) {
        fail('Spotify did not return a refresh token.');
    }

    // Prove the new token works the same way Apollo uses it: refresh, then read playback.
    try {
        const check = new SpotifyWebApi({ clientId: spotifyClientId, clientSecret: spotifyClientSecret, refreshToken });
        const refreshed = await check.refreshAccessToken();
        check.setAccessToken(refreshed.body.access_token);
        const playback = await check.getMyCurrentPlaybackState();
        const body = playback && playback.body;
        const what = body && body.item ? `${body.is_playing ? 'playing' : 'paused'}: ${body.item.name}` : 'nothing playing';
        console.log(`\n✔ New token works (Spotify reports ${what}).`);
    } catch (err) {
        fail(`The new token didn't work: ${(err && err.message) || err}`);
    }

    const localText = fs.existsSync(ENV_PATH) ? fs.readFileSync(ENV_PATH, 'utf8') : '';
    fs.writeFileSync(ENV_PATH, setEnvValue(localText, 'spotifyRefreshToken', refreshToken));
    console.log(`✔ Updated spotifyRefreshToken in ${ENV_PATH}`);

    if (LOCAL_ONLY) {
        console.log('\n--local: the Pi was not changed.');
        return;
    }

    // The token travels on stdin; the remote one-liner rewrites only that key.
    const remote = `cd ${PI_DIR} && node -e '
const fs = require("fs");
let t = ""; process.stdin.on("data", (d) => { t += d; }).on("end", () => {
  const token = t.trim(); const f = ".env";
  let s = fs.existsSync(f) ? fs.readFileSync(f, "utf8") : "";
  const line = "spotifyRefreshToken=" + token;
  s = /^spotifyRefreshToken=.*$/m.test(s) ? s.replace(/^spotifyRefreshToken=.*$/m, () => line) : s + (s.endsWith("\\n") || s === "" ? "" : "\\n") + line + "\\n";
  fs.writeFileSync(f, s);
});' && pm2 restart Apollo >/dev/null && echo restarted`;
    const res = spawnSync('ssh', ['-o', 'BatchMode=yes', PI_HOST, remote], { input: refreshToken + '\n', encoding: 'utf8' });
    if (res.status !== 0) {
        fail(`Updating the Pi failed (ssh ${PI_HOST}): ${(res.stderr || '').trim() || `exit ${res.status}`}. The local .env was updated; rerun without --local once ssh works.`);
    }
    console.log(`✔ Updated the Pi's .env and restarted Apollo (${PI_HOST}).`);
    console.log('\nThe dashboard should show what\'s playing within ~10 seconds.');
}

main().catch((err) => fail((err && err.message) || String(err)));
