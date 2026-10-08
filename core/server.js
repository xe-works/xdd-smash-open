import http from 'node:http';
import { unlinkSync, chmodSync } from 'node:fs';
import { pipeline } from './pipeline.js';
import { registry as metricsRegistry } from './metrics.js';
import { gunzipSync } from 'node:zlib';

// The server is a thin dispatcher over the route table (core/router.js). Core
// endpoints (the bid POST and /metrics) are registered as ordinary routes via
// registerCoreRoutes; services add their own declared routes in index.js.
export function createServer(router, config) {
  const server = http.createServer(async (req, res) => {
    let pathname;
    try {
      pathname = new URL(req.url, 'http://localhost').pathname;
    } catch {
      res.writeHead(400);
      res.end();
      return;
    }

    const match = router.resolve(req.method, pathname);
    if (!match) {
      res.writeHead(405);
      res.end();
      return;
    }

    try {
      await match.handler(req, res, match.params);
    } catch (err) {
      if (!res.headersSent) {
        const status = err.status ?? 500;
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    }
  });

  return {
    start() {
      return new Promise(resolve => {
        const socket = process.env.SOCKET;
        if (socket) {
          try { unlinkSync(socket); } catch {}
          server.listen(socket, () => {
            chmodSync(socket, '660');
            resolve();
          });
        } else {
          server.listen(config.port, () => {
            console.log(`xdd-smash listening on :${config.port}`);
            resolve();
          });
        }
      });
    },
    stop() {
      return new Promise((resolve, reject) => {
        server.close(err => (err ? reject(err) : resolve()));
      });
    },
  };
}

// Registers the built-in endpoints onto the router:
//   GET  /metrics  — Prometheus scrape (optional Bearer auth)
//   POST *         — the bid endpoint (any URL), handed to the pipeline
export function registerCoreRoutes(router, registry, config) {
  router.add('GET', '/metrics', async (req, res) => {
    if (config.metricsToken) {
      const auth = req.headers.authorization ?? '';
      if (auth !== `Bearer ${config.metricsToken}`) {
        res.writeHead(401, { 'WWW-Authenticate': 'Bearer' });
        res.end();
        return;
      }
    }
    const body = await metricsRegistry.metrics();
    res.writeHead(200, { 'Content-Type': metricsRegistry.contentType });
    res.end(body);
  });

  router.add('POST', '*', async (req, res) => {
    let body;
    try {
      body = await readBody(req);
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'invalid body' }));
      return;
    }

    let result;
    try {
      result = await pipeline(req, body, registry);
    } catch (err) {
      const status = err.status ?? 500;
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
      return;
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(result));
  });
}

// Content-Encoding is the caller's only declaration that the body is
// compressed, so it decides how to read it. An encoding we do not implement
// has to fail as itself: handed to JSON.parse as bytes it reads as malformed
// JSON, which points at the wrong thing.
const BODY_DECODERS = {
  gzip: gunzipSync,
  'x-gzip': gunzipSync,
  identity: buf => buf,
};

export function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      const encoding = (req.headers['content-encoding'] ?? 'identity').trim().toLowerCase();
      const decode = BODY_DECODERS[encoding];
      if (!decode) {
        reject(new Error(`unsupported content-encoding: ${encoding}`));
        return;
      }

      let raw;
      try {
        raw = decode(Buffer.concat(chunks));
      } catch {
        reject(new Error(`could not decode ${encoding} body`));
        return;
      }

      try {
        resolve(JSON.parse(raw.toString()));
      } catch {
        reject(new Error('invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}
