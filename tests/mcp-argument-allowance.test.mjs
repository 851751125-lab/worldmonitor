import assert from 'node:assert/strict';
import { afterEach, it } from 'node:test';
import { dispatchToolsCall } from '../api/mcp/dispatch.ts';
import { makePipelineMock } from './helpers/mcp-pro-deps.mjs';
import { installRedis } from './helpers/fake-upstash-redis.mts';
import { TOOL_REGISTRY } from '../api/mcp/registry/index.ts';
import { validateToolArgs } from '../api/mcp/_validate-args.ts';
import { RpcValidationError } from '../api/mcp/billing-denial.ts';

const originalFetch = globalThis.fetch;
const originalEnv = { ...process.env };
afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const key of ['UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN', 'MCP_TELEMETRY']) {
    if (originalEnv[key] === undefined) delete process.env[key];
    else process.env[key] = originalEnv[key];
  }
});

function setup() {
  process.env.MCP_TELEMETRY = 'false';
  installRedis({
    'economic:eu-gas-storage:v1': { history: [{ date: '2026-10-18', fillPct: 80 }] },
    'cyber:threats-bootstrap:v2': { threats: [{ country: 'IQ' }] },
  });
  const redisFetch = globalThis.fetch;
  let fetches = 0;
  globalThis.fetch = async (...args) => { fetches++; return redisFetch(...args); };
  const pipe = makePipelineMock({ initialCount: 2 });
  return { pipe, fetches: () => fetches };
}

const meters = [
  ['free account', undefined, true],
  ['Pro', { allowance: 'mcp', limit: 50 }, false],
  ['API', { allowance: 'api', counter: 'api', limit: 1000 }, false],
];
const call = (pipe, name, args, budget, freeAccount) => dispatchToolsCall(
  new Request('https://worldmonitor.app/mcp'),
  { kind: 'user_key', userId: 'argument-validation-user' },
  { redisPipeline: pipe.pipeline },
  { id: 42, params: { name, arguments: args } }, {}, undefined, budget, freeAccount,
);

for (const [meter, budget, freeAccount] of meters) {
  for (const [name, args, field] of [
    ['get_tariff_trends', { dataset: ['tariffs'] }, 'dataset'],
    ['get_energy_storage', { dataset: ['unsupported'] }, 'dataset'],
    ['get_energy_storage', { limit: 1.5 }, 'limit'],
    ['get_energy_storage', { limit: -1 }, 'limit'],
    ['get_energy_storage', { limit: Number.MAX_SAFE_INTEGER + 1 }, 'limit'],
    ['get_energy_storage', { limit: '3' }, 'limit'],
    ['get_energy_storage', [], 'arguments'],
    ['get_energy_storage', null, 'arguments'],
    ['get_cyber_threats', { country: 'Atlantis' }, 'country'],
  ]) {
    it(`${meter}: ${name} rejects ${JSON.stringify(args)} without spending allowance`, async () => {
      const { pipe, fetches } = setup();
      const response = await call(pipe, name, args, budget, freeAccount);
      const body = await response.json();
      assert.equal(response.status, 200);
      assert.equal(body.error?.code, -32602, JSON.stringify(body));
      assert.equal(body.error.message, 'Invalid params');
      assert.ok(body.error.data.violations.some(v => v.field === field || v.field.startsWith(`${field}.`)));
      assert.equal(pipe.count, 2, 'daily counter must remain unchanged');
      assert.deepEqual(pipe.ops, [], 'validation must precede every reservation');
      assert.equal(fetches(), 0, 'invalid arguments must not fetch data');
    });
  }

  it(`${meter}: valid storage calls remain charged`, async () => {
    const { pipe, fetches } = setup();
    const response = await call(pipe, 'get_energy_storage', { dataset: ['eu-gas-storage'], limit: 0 }, budget, freeAccount);
    const body = await response.json();
    assert.equal(body.error, undefined, JSON.stringify(body));
    assert.equal(pipe.count, 3);
    assert.ok(fetches() > 0);
  });

  it(`${meter}: data fetch failures remain charged`, async () => {
    const { pipe } = setup();
    globalThis.fetch = async () => { throw new Error('controlled upstream outage'); };
    await call(pipe, 'get_energy_storage', {}, budget, freeAccount);
    assert.equal(pipe.count, 3, 'no refund after execution starts');
  });
}

it('Pro rejects an unresolved required country before reservation or RPC fetch', async () => {
  const { pipe, fetches } = setup();
  const response = await call(pipe, 'get_country_coverage', { country_code: 'Atlantis' }, meters[1][1], false);
  assert.equal((await response.json()).error?.code, -32602);
  assert.equal(pipe.count, 2);
  assert.deepEqual(pipe.ops, []);
  assert.equal(fetches(), 0);
});

for (const [name, args] of [
  ['get_macro_history', { dataset: 'world-cpi', country: 'Atlantis' }],
  ['get_supply_chain_cost_shock', { mode: 'energy', country: 'Atlantis', chokepoint_id: 'hormuz' }],
  ['compute_energy_shock', { country: 'Atlantis', chokepoint_id: 'hormuz' }],
  ['get_internet_activity', { country: 'Atlantis' }],
  ['get_tariff_averages', { reporter: 'Atlantis' }],
  ['get_bilateral_tariff', { reporter: 'US', partner: 'Atlantis', hs_code: '270900' }],
  ['get_us_import_duty', { partner: 'Atlantis', hs_code: '270900' }],
]) {
  it(`${name} rejects an unresolved country before reservation`, async () => {
    const { pipe, fetches } = setup();
    assert.equal((await (await call(pipe, name, args, meters[1][1], false)).json()).error?.code, -32602);
    assert.deepEqual(pipe.ops, []);
    assert.equal(pipe.count, 2);
    assert.equal(fetches(), 0);
  });
}

it('invalid panel openings and refreshes do not allocate a paid panel', async () => {
  const { pipe, fetches } = setup();
  for (const extra of [{}, { refresh: true, request_id: crypto.randomUUID() }]) {
    const response = await call(pipe, 'get_market_data', { asset_class: ['invalid'], ...extra }, meters[1][1], false);
    assert.equal((await response.json()).error?.code, -32602);
  }
  assert.equal(pipe.count, 2);
  assert.deepEqual(pipe.ops, []);
  assert.equal(fetches(), 0);
});

it('repeated invalid calls leave a free account able to make a valid call', async () => {
  const { pipe } = setup();
  for (let i = 0; i < 6; i++) {
    assert.equal((await (await call(pipe, 'get_energy_storage', { limit: -1 }, undefined, true)).json()).error?.code, -32602);
  }
  assert.equal(pipe.count, 2);
  assert.equal((await (await call(pipe, 'get_energy_storage', {}, undefined, true)).json()).error, undefined);
  assert.equal(pipe.count, 3);
});

it('validates required selectors, nested defaults and unique members without changing arguments', () => {
  const scorecard = TOOL_REGISTRY.find(tool => tool.name === 'get_five_factor_scorecard');
  for (const args of [{ country_code: 'US' }, { members: ['US', 'CA'] }]) assert.doesNotThrow(() => validateToolArgs(scorecard, args));
  for (const args of [{}, { country_code: 'US', members: ['US', 'CA'] }, { members: ['US', 'US'] }]) {
    assert.throws(() => validateToolArgs(scorecard, args), RpcValidationError);
  }
  const reader = TOOL_REGISTRY.find(tool => tool.name === 'get_country_brief_section');
  const args = { section: 'food', arguments: { countryCode: 'US' } };
  const original = structuredClone(args);
  assert.doesNotThrow(() => validateToolArgs(reader, args));
  assert.deepEqual(args, original, 'defaulted reader fields must stay omitted');
  assert.throws(() => validateToolArgs(reader, { section: 'food', arguments: { countryCode: 'US', extra: true } }), RpcValidationError);
  assert.throws(() => validateToolArgs(reader, { section: 'food', arguments: { countryCode: 'USA' } }), RpcValidationError);
});

it('country hooks reject unresolved filters while retaining aliases and Eurostat aggregates', () => {
  for (const tool of TOOL_REGISTRY.filter(tool => tool._validateArgs)) {
    const field = ['country', 'countries', 'country_code'].find(field => tool.inputSchema.properties[field]);
    if (!field) continue;
    for (const value of ['Atlantis', { toString: 'x' }]) assert.throws(() => tool._validateArgs({ [field]: value }), RpcValidationError, tool.name);
    for (const value of ['IQ', 'IRQ', 'Iraq']) {
      if (tool.name === 'get_focal_points') continue;
      assert.doesNotThrow(() => tool._validateArgs({ [field]: value }), tool.name);
    }
  }
  for (const name of ['get_eu_housing_cycle', 'get_eu_quarterly_gov_debt', 'get_eu_industrial_production']) {
    assert.doesNotThrow(() => TOOL_REGISTRY.find(tool => tool.name === name)._validateArgs({ countries: ['EA20', 'EU27_2020', 'EL'] }));
  }
});

it('covers the validation vocabulary in every published tool input schema', () => {
  const supported = new Set('$schema type properties required items enum const minimum maximum exclusiveMinimum minLength maxLength pattern minItems maxItems uniqueItems additionalProperties oneOf description default format'.split(' '));
  function check(schema) {
    if (!schema || typeof schema !== 'object') return;
    for (const [key, value] of Object.entries(schema)) {
      assert.ok(supported.has(key), `Implement input validation for schema keyword ${key}`);
      if (key === 'properties') Object.values(value).forEach(check);
      else if (key === 'oneOf') value.forEach(check);
      else if (key === 'items' || key === 'additionalProperties') check(value);
    }
  }
  TOOL_REGISTRY.forEach(tool => check(tool.inputSchema));
});
