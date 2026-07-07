#!/usr/bin/env node

const { spawn } = require('child_process');
const http = require('http');
const net = require('net');
const path = require('path');
const mqtt = require('mqtt');

const PORT = 80;
const BASE = `http://localhost:${PORT}`;
const STARTUP_TIMEOUT = 10000;
const REQUEST_TIMEOUT = 5000;

let server;
let passed = 0;
let failed = 0;
const failures = [];

function request(urlPath) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Timed out after ${REQUEST_TIMEOUT}ms`));
    }, REQUEST_TIMEOUT);

    http.get(`${BASE}${urlPath}`, (res) => {
      let body = '';
      res.on('data', (chunk) => body += chunk);
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

async function test(name, urlPath, expectedStatus) {
  try {
    const res = await request(urlPath);
    if (res.status === expectedStatus) {
      passed++;
      console.log(`  \x1b[32mPASS\x1b[0m  ${name}`);
    } else {
      failed++;
      const msg = `Expected ${expectedStatus}, got ${res.status}`;
      failures.push({ name, msg });
      console.log(`  \x1b[31mFAIL\x1b[0m  ${name} — ${msg}`);
    }
  } catch (err) {
    failed++;
    const msg = err.message;
    failures.push({ name, msg });
    console.log(`  \x1b[31mFAIL\x1b[0m  ${name} — ${msg}`);
  }
}

async function fetchJson(urlPath) {
  const res = await request(urlPath);
  return JSON.parse(res.body);
}

const MQTT_BROKER_URL = process.env.MQTT_BROKER_URL || 'mqtt://localhost:1883';
const MQTT_STATUS_TOPIC = 'apollo/bridge/apollo/status';
const MQTT_PROBE_TIMEOUT = 1000;
const MQTT_STATUS_TIMEOUT = 3000;

function probeMqttBroker() {
  return new Promise((resolve) => {
    let url;
    try {
      url = new URL(MQTT_BROKER_URL);
    } catch {
      resolve(false);
      return;
    }
    const port = Number(url.port) || 1883;
    const socket = net.createConnection({ host: url.hostname, port });
    const timer = setTimeout(() => {
      socket.destroy();
      resolve(false);
    }, MQTT_PROBE_TIMEOUT);

    socket.on('connect', () => {
      clearTimeout(timer);
      socket.end();
      resolve(true);
    });
    socket.on('error', () => {
      clearTimeout(timer);
      resolve(false);
    });
  });
}

// Connects a second (independent) MQTT client to the broker and asserts the
// retained apollo/bridge/apollo/status message published by the just-started
// Apollo server is "online", within a few seconds. Skips (does not fail) if
// nothing is listening on the broker -- this test never actuates hardware,
// it only observes the MQTT bridge status.
async function testMqttBridgeStatus() {
  const name = 'MQTT bridge status is retained "online"';
  const brokerUp = await probeMqttBroker();
  if (!brokerUp) {
    console.log(`  \x1b[33mSKIPPED\x1b[0m ${name} — no broker listening at ${MQTT_BROKER_URL}`);
    return;
  }

  let client;
  try {
    const payload = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`Timed out after ${MQTT_STATUS_TIMEOUT}ms waiting for retained status`));
      }, MQTT_STATUS_TIMEOUT);

      client = mqtt.connect(MQTT_BROKER_URL, { reconnectPeriod: 0 });
      client.on('connect', () => {
        client.subscribe(MQTT_STATUS_TOPIC, { qos: 1 }, (err) => {
          if (err) {
            clearTimeout(timer);
            reject(err);
          }
        });
      });
      client.on('message', (topic, message) => {
        clearTimeout(timer);
        resolve(message.toString());
      });
      client.on('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });

    if (payload === 'online') {
      passed++;
      console.log(`  \x1b[32mPASS\x1b[0m  ${name}`);
    } else {
      failed++;
      const msg = `Expected "online", got "${payload}"`;
      failures.push({ name, msg });
      console.log(`  \x1b[31mFAIL\x1b[0m  ${name} — ${msg}`);
    }
  } catch (err) {
    failed++;
    failures.push({ name, msg: err.message });
    console.log(`  \x1b[31mFAIL\x1b[0m  ${name} — ${err.message}`);
  } finally {
    if (client) client.end(true);
  }
}

function startServer() {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error('Server failed to start within ' + STARTUP_TIMEOUT + 'ms'));
    }, STARTUP_TIMEOUT);

    // Default to dry-run mode so the smoke tests never actuate real hardware.
    // Pass --live on the command line to restore today's behavior (real sends).
    const isLive = process.argv.includes('--live');
    const env = { ...process.env };
    if (!isLive) {
      env.APOLLO_DRY_RUN = '1';
    } else {
      delete env.APOLLO_DRY_RUN;
    }

    server = spawn('node', ['index.js'], {
      cwd: path.resolve(__dirname, '..'),
      stdio: ['ignore', 'pipe', 'pipe'],
      env,
    });

    let started = false;

    server.stdout.on('data', (data) => {
      if (!started && data.toString().includes('HTTP Server listening')) {
        started = true;
        clearTimeout(timer);
        resolve();
      }
    });

    server.stderr.on('data', (data) => {
      if (!started && data.toString().includes('HTTP Server listening')) {
        started = true;
        clearTimeout(timer);
        resolve();
      }
    });

    server.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });

    server.on('exit', (code) => {
      if (!started) {
        clearTimeout(timer);
        reject(new Error(`Server exited with code ${code} before starting`));
      }
    });
  });
}

function stopServer() {
  if (server) {
    server.kill('SIGTERM');
    server = null;
  }
}

async function run() {
  console.log('\nStarting Apollo server...');
  try {
    await startServer();
  } catch (err) {
    console.error(`\x1b[31mServer failed to start: ${err.message}\x1b[0m`);
    process.exit(1);
  }
  console.log('Server is up.\n');

  // --- MQTT bridge status ---
  console.log('MQTT');
  await testMqttBridgeStatus();
  console.log('');

  // --- List endpoints ---
  console.log('/list endpoints');
  await test('GET /list/devices', '/list/devices', 200);
  await test('GET /list/lights', '/list/lights', 200);
  await test('GET /list/lightingScenes', '/list/lightingScenes', 200);
  await test('GET /list/deviceScenes', '/list/deviceScenes', 200);
  await test('GET /list/macros', '/list/macros', 200);
  await test('GET /list/bogus returns 404', '/list/bogus', 404);

  // --- Discover IDs from config ---
  let devices, deviceLights, lightingScenes, deviceScenes, macrosList;
  try {
    devices = await fetchJson('/list/devices');
    deviceLights = await fetchJson('/list/lights');
    lightingScenes = await fetchJson('/list/lightingScenes');
    deviceScenes = await fetchJson('/list/deviceScenes');
    macrosList = await fetchJson('/list/macros');
  } catch (err) {
    console.error(`\x1b[31mFailed to fetch config: ${err.message}\x1b[0m`);
    stopServer();
    process.exit(1);
  }

  // --- API endpoints: DEVICES ---
  console.log('\n/api/devices endpoints');
  if (devices.length > 0) {
    const sample = devices[0];
    const firstCmd = Object.keys(sample.commands || {})[0];
    if (firstCmd) {
      await test(
        `DEVICES ${sample.id}/${firstCmd}`,
        `/api/devices/${sample.id}/${firstCmd}`,
        200
      );
    }
  }
  await test('DEVICES unknown device', '/api/devices/NONEXISTENT/on', 404);

  // --- API endpoints: LIGHTS ---
  console.log('\n/api/lights endpoints');
  if (deviceLights.length > 0) {
    const sample = deviceLights[0];
    await test(
      `LIGHTS ${sample.id}/on`,
      `/api/lights/${sample.id}/on`,
      200
    );
    await test(
      `LIGHTS ${sample.id}/off`,
      `/api/lights/${sample.id}/off`,
      200
    );
  }

  // --- API endpoints: LIGHTINGSCENES ---
  console.log('\n/api/lightingscenes endpoints');
  if (lightingScenes.length > 0) {
    const sample = lightingScenes[0];
    await test(
      `LIGHTINGSCENES ${sample.id}/on`,
      `/api/lightingscenes/${sample.id}/on`,
      200
    );
  }

  // --- API endpoints: DEVICESCENES ---
  console.log('\n/api/devicescenes endpoints');
  if (deviceScenes.length > 0) {
    const sample = deviceScenes[0];
    await test(
      `DEVICESCENES ${sample.id}/on`,
      `/api/devicescenes/${sample.id}/on`,
      200
    );
  }

  // --- API endpoints: MACROS ---
  console.log('\n/api/macros endpoints');
  if (macrosList.length > 0) {
    const sample = macrosList[0];
    await test(
      `MACROS ${sample.id}/on`,
      `/api/macros/${sample.id}/on`,
      200
    );
  }

  // --- Invalid module ---
  console.log('\n/api edge cases');
  await test('Unknown module returns 404', '/api/bogusmodule/device/cmd', 404);
  await test('Empty path returns 400', '/api/', 400);

  // --- Static UI ---
  console.log('\nStatic UI');
  await test('GET / serves index.html', '/', 200);

  // --- Vendored dashboard JS (Stage 9, #21/#22) ---
  console.log('\nVendored dashboard JS');
  await test('GET /js/mqtt.min.js', '/js/mqtt.min.js', 200);
  await test('GET /js/mqttDashboard.js', '/js/mqttDashboard.js', 200);
  await test('GET /js/angular.min.js', '/js/angular.min.js', 200);

  // --- Summary ---
  console.log(`\n${'—'.repeat(40)}`);
  console.log(`\x1b[32m${passed} passed\x1b[0m, \x1b[31m${failed} failed\x1b[0m`);
  if (failures.length > 0) {
    console.log('\nFailures:');
    failures.forEach((f) => console.log(`  ${f.name}: ${f.msg}`));
  }
  console.log('');

  stopServer();
  process.exit(failed > 0 ? 1 : 0);
}

process.on('exit', stopServer);
process.on('SIGINT', () => { stopServer(); process.exit(1); });
process.on('SIGTERM', () => { stopServer(); process.exit(1); });

run();
