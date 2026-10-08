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

// An array value becomes repeated parameters in order, which is how the
// 3rdpcid/3rddpi pairs travel: the nth of one belongs to the nth of the other.
export function s2sPath(dpi, identity, extra = []) {
  const parts = [...S2S_STATIC, ['dpi', dpi]];
  for (const [k, v] of Object.entries(identity)) {
    if (Array.isArray(v)) for (const one of v) parts.push([k, one]);
    else parts.push([k, v]);
  }
  return `${PATH}?${query([...parts, ...extra])}`;
}

// Eligibility is decided from the request IP, not from device.geo.country, so a
// request whose declared country and IP disagree can still require these. Sent
// whenever the request carries them rather than only for the eu region.
export function privacyParams(privacy = {}) {
  const parts = [];

  // Truthy rather than === 1: the parser passes a boolean gdpr through
  // unchanged, and exchanges do send one.
  if (privacy.gdpr) {
    parts.push(['gdpr', 1]);
    if (privacy.consent) parts.push(['gdpr_consent', privacy.consent]);
  }
  if (privacy.usPrivacy) parts.push(['us_privacy', privacy.usPrivacy]);
  if (privacy.gpp) parts.push(['gpp', privacy.gpp]);

  const sid = privacy.gppSid;
  if (sid != null && sid !== '') parts.push(['gpp_sid', Array.isArray(sid) ? sid.join(',') : sid]);

  return parts;
}

export function reportPath(dpi, rdata) {
  return `${PATH}?${query([...REPORT_STATIC, ['dpi', dpi], ['rdata', JSON.stringify(rdata)]])}`;
}

// Their non-200 signals overlap: 302 means no data rather than a redirect, and
// the QPS refusal arrives in the body of an otherwise fine response.
export function interpretEids(res) {
  if (res.status !== 'ok') return { outcome: res.status === 'timeout' ? 'timeout' : 'error' };
  if (res.code === 302) return { outcome: 'nodata', eids: [], abTestUuid: null };
  if (res.body?.includes(QPS_MARKER)) return { outcome: 'qps' };
  if (res.code >= 400) return { outcome: 'error' };

  let body;
  try {
    body = JSON.parse(res.body);
  } catch {
    return { outcome: 'badjson' };
  }

  // A rate refusal arrives as an ordinary 200 with valid JSON, so without this
  // flag it is indistinguishable from a genuine empty answer — and would be
  // cached as data while telling the throttle it succeeded. The short cttl that
  // comes with it is the back-off interval.
  if (body.qps === true) return { outcome: 'qps', cttl: body.cttl };

  return {
    outcome: 'ok',
    eids: body.isOptedOut ? [] : (body.data?.eids ?? []),
    abTestUuid: body.abTestUuid ?? null,
    cttl: body.cttl,
  };
}

// The consent string is accepted either as a query parameter or as this header;
// the gdpr flag itself is only read from the query, so privacyParams carries it.
export async function fetchEids({ host, dpi, identity, privacy, timeoutMs }) {
  const headers = privacy?.gdpr && privacy?.consent ? { 'gdpr-consent': privacy.consent } : {};
  const path = s2sPath(dpi, identity, privacyParams(privacy));
  return interpretEids(await get(host, path, headers, timeoutMs));
}

export async function reportImpression({ host, dpi, rdata, timeoutMs }) {
  const res = await get(host, reportPath(dpi, rdata), {}, timeoutMs);
  return { ok: res.status === 'ok' && res.code < 400, code: res.code };
}
