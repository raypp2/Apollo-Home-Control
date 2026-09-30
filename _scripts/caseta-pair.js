#!/usr/bin/env node
/**
 * One-time pairing with a Lutron Caseta Smart Bridge (LEAP).
 *
 * Generates a private key + certificate request, sends it to the bridge's
 * pairing port (8083), and waits for someone to press the small button on
 * the back of the bridge. The bridge then signs the request; the resulting
 * key, client certificate and the bridge's root CA are written to
 * data/caseta.json (mode 600). src/lightingCaseta.js reads that file to open
 * the control connection on port 8081.
 *
 *   node _scripts/caseta-pair.js <bridge-ip> [--out data/caseta.json]
 *
 * data/ is gitignored AND excluded from the deploy rsync, so run this on the
 * Pi (the certificate never leaves it). Needs `openssl` on the PATH.
 * Re-running replaces the pairing; the old certificate simply stops being used.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { PairingClient, LeapClient } = require('lutron-leap');

const host = process.argv[2];
const outIdx = process.argv.indexOf('--out');
const OUT = path.resolve(outIdx > 0 ? process.argv[outIdx + 1] : path.join(__dirname, '..', 'data', 'caseta.json'));
const TIMEOUT_MS = 10 * 60 * 1000;

if (!host) {
    console.error('usage: node _scripts/caseta-pair.js <bridge-ip> [--out data/caseta.json]');
    process.exit(2);
}

function makeKeyAndCsr() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'caseta-pair-'));
    try {
        const keyFile = path.join(dir, 'key.pem');
        execFileSync('openssl', ['genrsa', '-out', keyFile, '2048'], { stdio: 'ignore' });
        const csr = execFileSync('openssl', ['req', '-new', '-key', keyFile, '-subj', '/CN=apollo-home-control'], { encoding: 'utf8' });
        return { key: fs.readFileSync(keyFile, 'utf8'), csr };
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
}

async function verify(pairing) {
    const client = new LeapClient(pairing.host, 8081, pairing.ca, pairing.key, pairing.cert);
    await client.connect();
    const res = await client.request('ReadRequest', '/device');
    const devices = (res.Body && res.Body.Devices) || [];
    client.close();
    return devices;
}

(async () => {
    const { key, csr } = makeKeyAndCsr();
    const pc = new PairingClient(host, 8083);
    await pc.connect();

    // The bridge only signs a request once someone has pressed its button:
    // pressing it pushes a status message granting "PhysicalAccess" on this
    // connection. A CSR sent before that is refused with 401.
    const next = (predicate, what) => new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`timed out waiting for ${what} (10 min)`)), TIMEOUT_MS);
        const onMessage = (msg) => {
            if (predicate(msg)) {
                clearTimeout(timer);
                pc.removeListener('message', onMessage);
                resolve(msg);
            }
        };
        pc.on('message', onMessage);
    });

    console.log(`\nConnected to the bridge at ${host}.`);
    console.log('>>> Press and release the small button on the BACK of the Caseta Smart Bridge now (within 10 minutes). <<<\n');
    await next((m) => {
        const perms = m && m.Body && m.Body.Status && m.Body.Status.Permissions;
        return Array.isArray(perms) && perms.includes('PhysicalAccess');
    }, 'the bridge button');
    console.log('Button press seen; requesting a certificate...');

    const signedMsg = next((m) => Boolean(m && m.Header && m.Header.ClientTag === 'get-cert'), 'the signed certificate');
    await pc.requestPair(csr);
    const reply = await signedMsg;
    const result = reply.Body && reply.Body.SigningResult;
    if (!result || !result.Certificate) {
        throw new Error(`bridge refused pairing: ${(reply.Header && reply.Header.StatusCode) || 'no certificate returned'}`);
    }
    const pairing = { host, key, cert: result.Certificate, ca: result.RootCertificate, pairedAt: new Date().toISOString() };

    fs.mkdirSync(path.dirname(OUT), { recursive: true });
    fs.writeFileSync(OUT, JSON.stringify(pairing, null, 2), { mode: 0o600 });
    fs.chmodSync(OUT, 0o600);
    console.log(`✔ Paired. Credentials saved to ${OUT} (mode 600).`);

    const devices = await verify(pairing);
    console.log(`✔ Control connection works: the bridge reports ${devices.length} device(s).`);
    for (const d of devices) {
        console.log(`   - ${(d.FullyQualifiedName || [d.Name]).join(' / ')}  [${d.DeviceType}]`);
    }
    process.exit(0);
})().catch((err) => {
    console.error(`\n✖ ${err.message || err}`);
    process.exit(1);
});
