const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('child_process');
const http = require('http');
const path = require('path');
const JSON5 = require('json5');
const fs = require('fs');

/**
 * Regression coverage for handleMacro()'s object-form command support
 * (src/handler.js), added after a live bug: a macro with `passOnOff: true`
 * blindly appends "/ON" or "/OFF" to every command string. That's correct
 * for a bare command ("lights/webcam" -> "lights/webcam/ON"), but silently
 * wrong for a command that already specifies its own action ("lights/x/50")
 * -- the LIGHTS module only looks at the segment right after the device id,
 * so the appended on/off becomes a dropped trailing param and the command
 * always runs unconditionally. Concretely: turning a macro OFF still left
 * affected lights at their "on" dim level instead of turning them off.
 *
 * handler.js has no dependency-injection seam (its config comes from a
 * module-level `require('../index')`, same as every module before this
 * session's lazy-init refactors) -- unlike those, refactoring handler.js's
 * loading is out of scope for this fix. So, mirroring test/smoke.js's and
 * test/mqttSetListener.test.js's existing precedent, this spawns the real
 * app in dry-run mode and asserts against its stdout, which every device
 * driver already logs a "DRY RUN, would send..." line to before returning.
 *
 * Gracefully skipped (not failed) if the local checkout's config doesn't
 * have a "studioMacro" entry with the expected object-form commands --
 * e.g. a fresh checkout running only the committed .example templates.
 */

const PORT = 80;
const BASE = `http://localhost:${PORT}`;
const STARTUP_TIMEOUT = 10000;
const REQUEST_TIMEOUT = 5000;

function hasStudioMacroFixture() {
    try {
        const macrosPath = path.resolve(__dirname, '..', 'config', 'macros.json');
        const macros = JSON5.parse(fs.readFileSync(macrosPath, 'utf8'));
        const studio = macros.find((m) => m.id === 'studioMacro');
        if (!studio || !Array.isArray(studio.commands)) {
            return false;
        }
        // Confirm at least one object-form { on, off } command is present --
        // the shape this fix introduced. If the local config predates the
        // fix (still all bare strings), there's nothing meaningful to assert.
        return studio.commands.some((c) => c && typeof c === 'object' && c.on && c.off);
    } catch {
        return false;
    }
}

function request(urlPath) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`Timed out after ${REQUEST_TIMEOUT}ms`)), REQUEST_TIMEOUT);
        http.get(`${BASE}${urlPath}`, (res) => {
            let body = '';
            res.on('data', (chunk) => { body += chunk; });
            res.on('end', () => {
                clearTimeout(timer);
                resolve({ status: res.statusCode, body });
            });
        }).on('error', (err) => {
            clearTimeout(timer);
            reject(err);
        });
    });
}

function startServer() {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Server failed to start within ' + STARTUP_TIMEOUT + 'ms')), STARTUP_TIMEOUT);
        const server = spawn('node', ['index.js'], {
            cwd: path.resolve(__dirname, '..'),
            env: { ...process.env, APOLLO_DRY_RUN: '1' },
            stdio: ['ignore', 'pipe', 'pipe'],
        });

        let started = false;
        let output = '';
        server.stdout.on('data', (data) => {
            output += data.toString();
            if (!started && output.includes('HTTP Server listening')) {
                started = true;
                clearTimeout(timer);
                resolve(server);
            }
        });
        server.stderr.on('data', (data) => { output += data.toString(); });
        server.on('error', (err) => { clearTimeout(timer); reject(err); });
        server.on('exit', (code) => {
            if (!started) {
                clearTimeout(timer);
                reject(new Error(`Server exited with code ${code} before starting`));
            }
        });

        // Expose accumulated output to the caller via a property (stdout
        // continues appending to `output` after resolve()).
        server._getOutput = () => output;
    });
}

function stopServer(server) {
    if (server) {
        server.kill('SIGTERM');
    }
}

test('studioMacro: object-form commands run distinct on/off paths (regression for the "off leaves lights on" bug)', async (t) => {
    if (!hasStudioMacroFixture()) {
        t.skip('local config/macros.json has no object-form studioMacro fixture');
        return;
    }

    const server = await startServer();
    try {
        const onRes = await request('/api/macros/studioMacro/on');
        assert.equal(onRes.status, 200);
        // Macro commands now dispatch sequentially, MACRO_COMMAND_SPACING_MS
        // (400ms, src/handler.js) apart rather than in a parallel burst
        // (issue: the Insteon hub dropped a command under a rapid-fire
        // burst) -- studioMacro has 7 commands, so the last one doesn't fire
        // until ~2.4s after the request. Wait long enough for the whole
        // sequence (plus async driver logging, e.g. Somfy/DMX-style promise
        // chains) to settle before inspecting output.
        await new Promise((r) => setTimeout(r, 3000));
        const afterOn = server._getOutput();

        const offRes = await request('/api/macros/studioMacro/off');
        assert.equal(offRes.status, 200);
        await new Promise((r) => setTimeout(r, 3000));
        const afterOff = server._getOutput();
        const offOnlyOutput = afterOff.slice(afterOn.length);

        // diningRoom, kitchen, and livingRoomBookshelf each have an on-state
        // command distinct from their off-state command (a dim level or
        // "on" vs "off"). Before the fix, the OFF invocation produced the
        // exact same underlying command as the ON invocation for all three
        // -- assert the OFF-only log slice shows each device's dedicated
        // "off" path was dispatched, not its "on" path.
        assert.match(offOnlyOutput, /LIGHTS\/diningRoom\/OFF/i, 'diningRoom should receive its dedicated OFF path, not stay at its dim level');
        assert.match(offOnlyOutput, /LIGHTS\/kitchen\/OFF/i, 'kitchen should receive its dedicated OFF path, not stay ON');
        assert.match(offOnlyOutput, /LIGHTS\/livingRoomBookshelf\/OFF/i, 'livingRoomBookshelf should receive its dedicated OFF path, not stay at its dim level');

        // And confirm the ON invocation still used the original on-state
        // paths (i.e. the fix didn't change "on" behavior).
        const onOnlyOutput = afterOn;
        assert.match(onOnlyOutput, /LIGHTS\/diningRoom\/50/i);
        assert.match(onOnlyOutput, /LIGHTS\/kitchen\/ON/i);
        assert.match(onOnlyOutput, /LIGHTS\/livingRoomBookshelf\/40/i);
    } finally {
        stopServer(server);
    }
});
