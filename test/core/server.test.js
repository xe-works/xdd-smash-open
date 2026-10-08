import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { createServer, registerCoreRoutes } from '../../core/server.js';
import { createRouter } from '../../core/router.js';
import { createRegistry } from '../../core/registry.js';

// A bid request whose DSP is a port nothing listens on, so the pipeline runs
// to completion and reports the connection failure instead of reaching out.
function bidRequest() {
  return {
    id: 'r1',
    imp: [{
      id: 'i1',
      banner: { w: 320, h: 50 },
      bidfloor: 0.1,
      ext: { smash: {
        dsp: { id: '1', endpointId: '2', destination: { url: 'http://127.0.0.1:1/' }, params: {} },
        ssp: { id: '3' },
      } },
    }],
    tmax: 200,
  };
}

function freePort() {
  return new Promise(resolve => {
    const probe = http.createServer();
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

function send(opts, payload) {
  return new Promise((resolve, reject) => {
    const req = http.request(opts, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({
        status: res.statusCode,
        headers: res.headers,
        body: Buffer.concat(chunks).toString(),
      }));
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

// Brings up a real server on a real port, hands the caller a request helper,
// and always tears it down — a leaked listener fails every later test.
async function withServer(build, fn) {
  const router = createRouter();
  const config = { port: await freePort() };
  build(router, config);
  const server = createServer(router, config);
  await server.start();
  try {
    return await fn((opts, payload) =>
      send({ host: '127.0.0.1', port: config.port, ...opts }, payload));
  } finally {
    await server.stop();
  }
}

const postJson = {
  method: 'POST',
  path: '/',
  headers: { 'Content-Type': 'application/json', 'X-Smash-Protocol': 'openrtb/2.5' },
};

test('answers 405 when no route matches', async () => {
  await withServer(() => {}, async request => {
    const res = await request({ method: 'GET', path: '/nothing-here' });
    assert.equal(res.status, 405);
  });
});

test('dispatches to a registered route', async () => {
  await withServer(router => {
    router.add('GET', '/ping', (req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('pong');
    });
  }, async request => {
    const res = await request({ method: 'GET', path: '/ping' });
    assert.equal(res.status, 200);
    assert.equal(res.body, 'pong');
  });
});

test('turns a throwing handler into its own status and message', async () => {
  await withServer(router => {
    router.add('GET', '/boom', () => {
      const err = new Error('teapot');
      err.status = 418;
      throw err;
    });
  }, async request => {
    const res = await request({ method: 'GET', path: '/boom' });
    assert.equal(res.status, 418);
    assert.deepEqual(JSON.parse(res.body), { error: 'teapot' });
  });
});

test('falls back to 500 for a handler that throws without a status', async () => {
  await withServer(router => {
    router.add('GET', '/boom', () => { throw new Error('unlabelled'); });
  }, async request => {
    const res = await request({ method: 'GET', path: '/boom' });
    assert.equal(res.status, 500);
    assert.deepEqual(JSON.parse(res.body), { error: 'unlabelled' });
  });
});

test('serves /metrics openly when no token is configured', async () => {
  await withServer((router, config) => {
    registerCoreRoutes(router, createRegistry(), config);
  }, async request => {
    const res = await request({ method: 'GET', path: '/metrics' });
    assert.equal(res.status, 200);
    assert.match(res.headers['content-type'], /text\/plain/);
  });
});

test('challenges /metrics when a token is configured and not presented', async () => {
  await withServer((router, config) => {
    registerCoreRoutes(router, createRegistry(), { ...config, metricsToken: 's3cret' });
  }, async request => {
    const res = await request({ method: 'GET', path: '/metrics' });
    assert.equal(res.status, 401);
    assert.equal(res.headers['www-authenticate'], 'Bearer');
  });
});

test('rejects a wrong metrics token', async () => {
  await withServer((router, config) => {
    registerCoreRoutes(router, createRegistry(), { ...config, metricsToken: 's3cret' });
  }, async request => {
    const res = await request({
      method: 'GET', path: '/metrics', headers: { Authorization: 'Bearer wrong' },
    });
    assert.equal(res.status, 401);
  });
});

test('serves /metrics to the configured token', async () => {
  await withServer((router, config) => {
    registerCoreRoutes(router, createRegistry(), { ...config, metricsToken: 's3cret' });
  }, async request => {
    const res = await request({
      method: 'GET', path: '/metrics', headers: { Authorization: 'Bearer s3cret' },
    });
    assert.equal(res.status, 200);
  });
});

test('rejects a body it cannot read', async () => {
  await withServer((router, config) => {
    registerCoreRoutes(router, createRegistry(), config);
  }, async request => {
    const res = await request(postJson, 'not json at all');
    assert.equal(res.status, 400);
    assert.deepEqual(JSON.parse(res.body), { error: 'invalid body' });
  });
});

test('rejects a gzip body that is not gzip', async () => {
  await withServer((router, config) => {
    registerCoreRoutes(router, createRegistry(), config);
  }, async request => {
    const res = await request(
      { ...postJson, headers: { ...postJson.headers, 'Content-Encoding': 'gzip' } },
      JSON.stringify(bidRequest()),
    );
    assert.equal(res.status, 400);
  });
});

test('reports a request carrying no ext.smash as the error it is', async () => {
  await withServer((router, config) => {
    registerCoreRoutes(router, createRegistry(), config);
  }, async request => {
    const res = await request(postJson, JSON.stringify({ id: 'r1', imp: [{ id: 'i1' }] }));
    assert.ok(res.status >= 400);
    assert.match(JSON.parse(res.body).error, /ext\.smash/);
  });
});

test('runs an uncompressed bid request through the pipeline', async () => {
  await withServer((router, config) => {
    registerCoreRoutes(router, createRegistry(), config);
  }, async request => {
    const res = await request(postJson, JSON.stringify(bidRequest()));
    assert.equal(res.status, 200);
    assert.deepEqual(JSON.parse(res.body).seatbid, []);
  });
});

test('runs a gzip bid request through the pipeline', async () => {
  await withServer((router, config) => {
    registerCoreRoutes(router, createRegistry(), config);
  }, async request => {
    const res = await request(
      { ...postJson, headers: { ...postJson.headers, 'Content-Encoding': 'gzip' } },
      gzipSync(JSON.stringify(bidRequest())),
    );
    assert.equal(res.status, 200);
    assert.deepEqual(JSON.parse(res.body).seatbid, []);
  });
});

test('listens on a unix socket when SOCKET is set', async () => {
  const socket = join(tmpdir(), `xdd-smash-test-${process.pid}.sock`);
  const previous = process.env.SOCKET;
  process.env.SOCKET = socket;

  const router = createRouter();
  router.add('GET', '/ping', (req, res) => { res.writeHead(200); res.end('pong'); });
  const server = createServer(router, { port: 0 });
  await server.start();

  try {
    const res = await send({ socketPath: socket, method: 'GET', path: '/ping' });
    assert.equal(res.status, 200);
    assert.equal(res.body, 'pong');
  } finally {
    await server.stop();
    if (previous === undefined) delete process.env.SOCKET;
    else process.env.SOCKET = previous;
  }
});
