/* global fetch, AbortSignal, console, process */

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

// Runs only on the disposable GitHub-hosted runner. No screenshots or secrets.
const driver = spawn('chromedriver', ['--port=9515'], { stdio: 'ignore' });
let sessionId;

async function command(method, path, body) {
  const response = await fetch('http://127.0.0.1:9515' + path, {
    method,
    headers: { 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(20000),
  });
  const json = await response.json();
  if (!response.ok || json.value?.error) {
    throw new Error(
      'ChromeDriver rejected ' + method + ' (' + response.status + ')',
    );
  }
  return json.value;
}

async function poll(label, test, duration = 45000) {
  const deadline = Date.now() + duration;
  while (Date.now() < deadline) {
    if (await test()) return;
    await sleep(250);
  }
  throw new Error('Timeout waiting for ' + label);
}

async function evaluate(script) {
  return command('POST', '/session/' + sessionId + '/execute/sync', {
    script,
    args: [],
  });
}

async function run() {
  await poll(
    'ChromeDriver',
    async () => {
      try {
        return (await command('GET', '/status')).ready === true;
      } catch {
        return false;
      }
    },
    15000,
  );
  const session = await command('POST', '/session', {
    capabilities: {
      alwaysMatch: {
        browserName: 'chrome',
        'goog:chromeOptions': {
          args: ['--headless=new', '--no-sandbox', '--disable-dev-shm-usage'],
        },
      },
    },
  });
  sessionId = session.sessionId;
  assert.ok(sessionId);
  await command('POST', '/session/' + sessionId + '/timeouts', {
    script: 20000,
    pageLoad: 90000,
    implicit: 0,
  });

  // Capture only endpoint and response status, before page scripts run.
  const recorder = [
    '(() => {',
    'const calls = [];',
    "Object.defineProperty(window, '__gate3bCalls', { value: calls });",
    'const original = window.fetch;',
    'window.fetch = function (...args) {',
    'const input = args[0]; const init = args[1];',
    "const method = String(init?.method ?? input?.method ?? 'GET').toUpperCase();",
    "const url = new URL(typeof input === 'string' ? input : input.url, location.href);",
    "if (method !== 'POST' || !['/api/agent', '/api/orchestrate'].includes(url.pathname)) return original.apply(this, args);",
    'const item = { endpoint: url.pathname, status: null }; calls.push(item);',
    'return original.apply(this, args).then(',
    '(response) => { item.status = response.status; return response; },',
    "(error) => { item.status = 'network-error'; throw error; });",
    '};',
    '})();',
  ].join('\n');
  await command('POST', '/session/' + sessionId + '/goog/cdp/execute', {
    cmd: 'Page.addScriptToEvaluateOnNewDocument',
    params: { source: recorder },
  });
  await command('POST', '/session/' + sessionId + '/url', {
    url: 'http://127.0.0.1:3000/demo',
  });
  await poll('demo page', () =>
    evaluate(
      "return document.querySelector('h1')?.textContent === 'ClientOps Command';",
    ),
  );
  await sleep(800);
  assert.deepEqual(await evaluate('return window.__gate3bCalls;'), []);

  // Native select setter fires React's change detection.
  const selectAccount = (value) =>
    evaluate(
      "const e = document.querySelector('#client-select');" +
        "Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(e, '" +
        value +
        "'); e.dispatchEvent(new Event('change', { bubbles: true }));",
    );
  await selectAccount('Northstar Health');
  await poll('account selection', () =>
    evaluate(
      "return document.querySelector('#agent-prompt')?.value === 'Prepare me for the Northstar Health review.';",
    ),
  );
  await selectAccount('Acme Labs');
  await poll('Acme restored', () =>
    evaluate(
      'return document.querySelector("#agent-prompt")?.value === "Prepare me for tomorrow\'s Acme review.";',
    ),
  );
  await evaluate("document.querySelectorAll('.mode-btn')[1].click();");
  await poll('deterministic mode', () =>
    evaluate(
      "return !![...document.querySelectorAll('button')].find(b => b.textContent?.trim() === 'Prepare Executive Review');",
    ),
  );
  await evaluate("document.querySelectorAll('.mode-btn')[0].click();");
  await poll('agentic mode', () =>
    evaluate(
      "return !![...document.querySelectorAll('button')].find(b => b.textContent?.trim() === 'Ask ClientOps Agent');",
    ),
  );
  await evaluate("document.querySelectorAll('.mode-btn')[1].click();");
  await poll('deterministic mode again', () =>
    evaluate(
      "return !![...document.querySelectorAll('button')].find(b => b.textContent?.trim() === 'Prepare Executive Review');",
    ),
  );
  assert.deepEqual(await evaluate('return window.__gate3bCalls;'), []);
  console.log(
    'PASS: page load, account selection and mode switches made zero workflow POSTs',
  );

  await evaluate(
    "[...document.querySelectorAll('button')].find(b => b.textContent?.trim() === 'Prepare Executive Review').click();",
  );
  await poll('deterministic HTTP response', () =>
    evaluate(
      'return window.__gate3bCalls.length === 1 && window.__gate3bCalls[0].status !== null;',
    ),
  );
  assert.deepEqual(await evaluate('return window.__gate3bCalls;'), [
    { endpoint: '/api/orchestrate', status: 200 },
  ]);
  await poll('Acme briefing rendered', () =>
    evaluate(
      "return document.querySelector('.account-overview-card h2')?.textContent === 'Acme Labs';",
    ),
  );
  const result = await evaluate(
    "const trace = [...document.querySelectorAll('.trace-step')].map(n => n.textContent);" +
      'return {' +
      "atRisk: !!document.querySelector('.health-at-risk')," +
      "risks: document.querySelectorAll('.risk-item').length," +
      "points: document.querySelectorAll('.talking-point-item').length," +
      "evidence: document.querySelectorAll('.evidence-trigger-btn').length," +
      "traceOk: trace.length === 2 && trace.every(s => s.includes('[OK]'))," +
      "toolsOk: trace.some(s => s.includes('account.get_context')) && trace.some(s => s.includes('meeting.prepare_brief'))," +
      "error: !!document.querySelector('.error-banner') };",
  );
  assert.equal(result.atRisk, true);
  assert.ok(result.risks >= 2);
  assert.ok(result.points >= 3);
  assert.ok(result.evidence >= 1);
  assert.equal(result.traceOk, true);
  assert.equal(result.toolsOk, true);
  assert.equal(result.error, false);
  await evaluate("document.querySelector('.evidence-trigger-btn').click();");
  await poll('evidence drawer', () =>
    evaluate(
      "return !!document.querySelector('.evidence-drawer')?.textContent.includes('Source Record');",
    ),
  );
  assert.equal(await evaluate('return window.__gate3bCalls.length;'), 1);
  console.log(
    'PASS: one deterministic HTTP 200, AT RISK briefing, evidence drawer and two MCP [OK] entries',
  );
  console.log(
    'PASS: no Bedrock inference and no screenshots or raw data recorded',
  );
}

try {
  await run();
} catch (error) {
  console.error('Gate 3B failed: ' + error.message);
  process.exitCode = 1;
} finally {
  if (sessionId) {
    await command('DELETE', '/session/' + sessionId).catch(() => undefined);
  }
  driver.kill('SIGTERM');
}
