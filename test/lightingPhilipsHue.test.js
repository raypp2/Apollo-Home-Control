/**
 * Tests for lightingPhilipsHue.js's per-group command queue: commands for a
 * group run strictly in order, and a waiting brightness level is replaced by
 * a newer one (a dashboard drag streams levels faster than the bridge can
 * take them) while ON/OFF/COLOR are never dropped.
 */
const assert = require('node:assert');
const { test } = require('node:test');
const { _enqueueGroupCommand } = require('../src/lightingPhilipsHue');

function slowExecutor(log, ms = 20) {
    return (item) => new Promise((resolve) => {
        log.push(item.lighting_command);
        setTimeout(resolve, ms);
    });
}

test('a burst of levels collapses to the in-flight one plus the newest', async () => {
    const sent = [];
    const exec = slowExecutor(sent);
    const first = _enqueueGroupCommand('g1', { operation_num: 1, lighting_command: '10' }, exec);
    for (const [i, level] of ['20', '30', '40', '50'].entries()) {
        _enqueueGroupCommand('g1', { operation_num: i + 2, lighting_command: level }, exec);
    }
    await first;
    assert.deepStrictEqual(sent, ['10', '50']);
});

test('ON/OFF/COLOR are kept in order and never superseded by levels', async () => {
    const sent = [];
    const exec = slowExecutor(sent);
    const first = _enqueueGroupCommand('g2', { operation_num: 1, lighting_command: '10' }, exec);
    _enqueueGroupCommand('g2', { operation_num: 2, lighting_command: '20' }, exec);
    _enqueueGroupCommand('g2', { operation_num: 3, lighting_command: 'OFF' }, exec);
    _enqueueGroupCommand('g2', { operation_num: 4, lighting_command: '30' }, exec);
    _enqueueGroupCommand('g2', { operation_num: 5, lighting_command: '40' }, exec);
    _enqueueGroupCommand('g2', { operation_num: 6, lighting_command: 'COLOR' }, exec);
    await first;
    assert.deepStrictEqual(sent, ['10', '20', 'OFF', '40', 'COLOR']);
});

test('groups are queued independently', async () => {
    const sent = [];
    const exec = slowExecutor(sent);
    await Promise.all([
        _enqueueGroupCommand('g3', { operation_num: 1, lighting_command: '10' }, exec),
        _enqueueGroupCommand('g4', { operation_num: 2, lighting_command: '20' }, exec),
    ]);
    assert.deepStrictEqual(sent.sort(), ['10', '20']);
});

test('a failing command does not strand the rest of the queue', async () => {
    const sent = [];
    const exec = (item) => {
        sent.push(item.lighting_command);
        if (item.lighting_command === 'ON') {
            return Promise.reject(new Error('bridge unreachable'));
        }
        return Promise.resolve();
    };
    const first = _enqueueGroupCommand('g5', { operation_num: 1, lighting_command: 'ON' }, exec);
    _enqueueGroupCommand('g5', { operation_num: 2, lighting_command: '60' }, exec);
    await first;
    assert.deepStrictEqual(sent, ['ON', '60']);
});
