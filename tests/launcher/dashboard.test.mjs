import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { defaultShell } from '../../dist/platform/shell.js';

const cli = path.resolve('dist/launcher/cli.js');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() => resolve(address.port));
    });
  });
}

async function waitFor(check, timeout = 10000) {
  const until = Date.now() + timeout;
  let last;
  while (Date.now() < until) {
    try { const result = await check(); if (result) return result; }
    catch (error) { last = error; }
    await sleep(60);
  }
  throw last ?? new Error('Timed out waiting for dashboard state.');
}

test('dashboard: localhost UI controls an isolated managed runtime without exposing its API token', async t => {
  const dir = await mkdtemp(path.join(process.cwd(), '.dashboard-test-'));
  const stateDir = path.join(dir, 'state');
  const logsDir = path.join(dir, 'logs');
  const config = path.join(dir, 'config.json');
  const mcpPort = await freePort();
  const dashboardPort = await freePort();
  await writeFile(config, JSON.stringify({
    schema_version: 1,
    mcp: { transport: 'http', host: '127.0.0.1', port: mcpPort, path: '/mcp', health_path: '/healthz' },
    tunnel: { enabled: false },
    runtime: { cwd: dir, shell: process.platform === 'win32' ? defaultShell() : '/bin/sh', state_dir: stateDir, logs_dir: logsDir },
    logging: { level: 'silent' }
  }));

  const child = spawn(process.execPath, [cli, 'dashboard', '--config', config, '--no-open', '--port', String(dashboardPort)], {
    cwd: process.cwd(), env: process.env, stdio: ['ignore', 'pipe', 'pipe']
  });
  let output = '';
  child.stdout.on('data', chunk => output += chunk);
  child.stderr.on('data', chunk => output += chunk);
  const finished = new Promise(resolve => child.once('close', (code, signal) => resolve({ code, signal, output })));
  t.after(async () => {
    try {
      const page = await fetch(`http://127.0.0.1:${dashboardPort}/`);
      if (page.ok) child.kill('SIGTERM');
    } catch {}
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    await Promise.race([finished, sleep(3000)]);
    try {
      const stopper = spawn(process.execPath, [cli, 'stop', '--config', config], { cwd: process.cwd(), env: process.env, stdio: 'ignore' });
      await new Promise(resolve => stopper.once('close', resolve));
    } catch {}
    await rm(dir, { recursive: true, force: true });
  });

  const html = await waitFor(async () => {
    const response = await fetch(`http://127.0.0.1:${dashboardPort}/`);
    return response.ok ? await response.text() : null;
  });
  assert.match(html, /MCP Dev Runtime/);
  assert.match(html, /远程连接已开启|远程连接已关闭/);
  const token = html.match(/const TOKEN="([a-f0-9]{64})"/)?.[1];
  assert(token, 'dashboard page should contain its per-process API token');

  const unauthorized = await fetch(`http://127.0.0.1:${dashboardPort}/api/status`);
  assert.equal(unauthorized.status, 403);
  const crossOrigin = await fetch(`http://127.0.0.1:${dashboardPort}/api/status`, { headers: { Origin: 'https://example.invalid' } });
  assert.equal(crossOrigin.status, 403);
  const headers = { 'X-MDR-Dashboard-Token': token };
  const stopped = await (await fetch(`http://127.0.0.1:${dashboardPort}/api/status`, { headers })).json();
  assert.equal(stopped.mode, 'stopped');
  assert.equal(stopped.mcp.state, 'stopped');
  assert.equal(stopped.tunnel.state, 'disabled');
  assert(!JSON.stringify(stopped).includes(token));

  const actionHeaders = { ...headers, 'Content-Type': 'application/json' };
  const startedResponse = await fetch(`http://127.0.0.1:${dashboardPort}/api/action`, {
    method: 'POST', headers: actionHeaders, body: JSON.stringify({ action: 'start' })
  });
  if (startedResponse.status !== 200) {
    const body = await startedResponse.text();
    const log = await readFile(path.join(logsDir, 'launcher.log'), 'utf8').catch(() => '(launcher log unavailable)');
    assert.equal(startedResponse.status, 200, body + '\nlauncher.log:\n' + log.slice(-8192));
  }
  const running = await waitFor(async () => {
    const value = await (await fetch(`http://127.0.0.1:${dashboardPort}/api/status`, { headers })).json();
    return value.mode === 'running' ? value : null;
  }, 15000);
  assert.equal(running.mcp.state, 'ready');
  assert.equal(running.tunnel.state, 'disabled');
  assert.match(running.mcp.url, /^http:\/\/127\.0\.0\.1:/);
  assert.equal(running.details.config_file, config);

  const stoppedResponse = await fetch(`http://127.0.0.1:${dashboardPort}/api/action`, {
    method: 'POST', headers: actionHeaders, body: JSON.stringify({ action: 'stop' })
  });
  assert.equal(stoppedResponse.status, 200, await stoppedResponse.text());
  await waitFor(async () => {
    const value = await (await fetch(`http://127.0.0.1:${dashboardPort}/api/status`, { headers })).json();
    return value.mode === 'stopped' ? value : null;
  });

  await writeFile(path.join(stateDir, 'supervisor.json'), JSON.stringify({
    pid: 2147483647,
    run_id: 'dead-dashboard-fixture',
    control_socket: process.platform === 'win32' ? '\\\\.\\pipe\\mdr-dashboard-missing' : path.join(stateDir, 'missing.sock')
  }));
  const stale = await (await fetch(`http://127.0.0.1:${dashboardPort}/api/status`, { headers })).json();
  assert.equal(stale.mode, 'recovery');
  assert.equal(stale.lifecycle, 'stale');
  const recoveredResponse = await fetch(`http://127.0.0.1:${dashboardPort}/api/action`, {
    method: 'POST', headers: actionHeaders, body: JSON.stringify({ action: 'restart' })
  });
  assert.equal(recoveredResponse.status, 200, await recoveredResponse.text());
  await waitFor(async () => {
    const value = await (await fetch(`http://127.0.0.1:${dashboardPort}/api/status`, { headers })).json();
    return value.mode === 'running' ? value : null;
  }, 15000);
  const finalStop = await fetch(`http://127.0.0.1:${dashboardPort}/api/action`, {
    method: 'POST', headers: actionHeaders, body: JSON.stringify({ action: 'stop' })
  });
  assert.equal(finalStop.status, 200, await finalStop.text());

  child.kill('SIGTERM');
  const end = await finished;
  assert(end.code === 0 || end.signal === 'SIGTERM', end.output);
});
