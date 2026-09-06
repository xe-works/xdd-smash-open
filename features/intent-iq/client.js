import http2 from 'node:http2';

const PATH = '/profiles_engine/ProfilesEngineServlet';
const S2S_STATIC = [['at', 39], ['mi', 10], ['pt', 17], ['dpn', 1], ['srvrReq', 'true']];
const REPORT_STATIC = [['at', 45], ['rtype', 1]];
const QPS_MARKER = 'QPS_LIMIT_REACHED';

const enc = v => encodeURIComponent(String(v));
const query = pairs => pairs.map(([k, v]) => `${enc(k)}=${enc(v)}`).join('&');

const sessions = new Map();

function session(host) {
  const live = sessions.get(host);
  if (live && !live.destroyed && !live.closed) return live;

  const s = http2.connect(`https://${host}`);
  const drop = () => { if (sessions.get(host) === s) sessions.delete(host); };
  s.on('error', drop);
  s.once('close', drop);
  s.once('goaway', drop);
  sessions.set(host, s);
  return s;
}

export function closeAll() {
  for (const s of sessions.values()) s.close();
  sessions.clear();
}

function get(host, path, headers, timeoutMs) {
  return new Promise(resolve => {
    let done = false;
    const finish = out => { if (!done) { done = true; resolve(out); } };

    let req;
    try {
      req = session(host).request({ ...headers, ':method': 'GET', ':path': path });
    } catch (e) {
      return finish({ status: 'error', message: e.message });
    }

    const chunks = [];
    let code = 0;
    req.on('response', h => { code = h[':status']; });
    req.on('data', c => chunks.push(c));
    req.on('end', () => finish({ status: 'ok', code, body: Buffer.concat(chunks).toString() }));
    req.once('error', e => { req.destroy(); finish({ status: 'error', message: e.message }); });
    req.setTimeout(timeoutMs, () => { req.destroy(); finish({ status: 'timeout' }); });
    req.end();
  });
}

export function s2sPath(dpi, identity) {
  const parts = [...S2S_STATIC, ['dpi', dpi]];
  for (const [k, v] of Object.entries(identity)) parts.push([k, v]);
  return `${PATH}?${query(parts)}`;
}

export function reportPath(dpi, rdata) {
  return `${PATH}?${query([...REPORT_STATIC, ['dpi', dpi], ['rdata', JSON.stringify(rdata)]])}`;
}

// Their non-200 signals overlap: 302 means no data rather than a redirect, and
// the QPS refusal arrives in the body of an otherwise fine response.
export function interpretEids(res) {
  if (res.status !== 'ok') return { outcome: res.status === 'timeout' ? 'timeout' : 'error' };
  if (res.code === 302) return { outcome: 'nodata' };
  if (res.body?.includes(QPS_MARKER)) return { outcome: 'qps' };
  if (res.code >= 400) return { outcome: 'error' };

  let body;
  try {
    body = JSON.parse(res.body);
  } catch {
    return { outcome: 'badjson' };
  }

  return {
    outcome: 'ok',
    eids: body.isOptedOut ? [] : (body.data?.eids ?? []),
    abTestUuid: body.abTestUuid ?? null,
    cttl: body.cttl,
  };
}

export async function fetchEids({ host, dpi, identity, gdpr, consent, timeoutMs }) {
  const headers = gdpr === 1 && consent ? { 'gdpr-consent': consent } : {};
  return interpretEids(await get(host, s2sPath(dpi, identity), headers, timeoutMs));
}

export async function reportImpression({ host, dpi, rdata, timeoutMs }) {
  const res = await get(host, reportPath(dpi, rdata), {}, timeoutMs);
  return { ok: res.status === 'ok' && res.code < 400, code: res.code };
}
