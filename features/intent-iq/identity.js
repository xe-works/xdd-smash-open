const IIQ_SOURCE = 'intentiq.com';

// AdCOM 1.0 Device Types.
const FORM = { 1: 'mobile', 2: 'desktop', 3: 'ctv', 4: 'mobile', 5: 'tablet', 6: 'device', 7: 'ctv', 8: 'ooh' };
const CTV_TYPES = new Set([3, 7]);

export const IDTYPE = { COOKIE: 0, IDFV: 1, IFA: 4, CTV: 8 };

// All-zero IFA means opted out — every such device would share one key.
export function hasRealIfa(ifa) {
  if (!ifa) return false;
  for (let i = 0; i < ifa.length; i++) {
    if (ifa[i] !== '0' && ifa[i] !== '-') return true;
  }
  return false;
}

const slug = s => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '');

const UA_OS = [
  [/(?:iPhone OS|CPU OS) (\d+)[._](\d+)/i, 'ios'],
  [/Android (\d+)(?:\.(\d+))?/i, 'android'],
  [/Mac OS X (\d+)[._](\d+)/i, 'macos'],
  [/Windows NT (\d+)(?:\.(\d+))?/i, 'windows'],
  [/CrOS \S+ (\d+)\.(\d+)/i, 'chromeos'],
];

function uaOs(ua) {
  for (const [re, name] of UA_OS) {
    const m = ua ? re.exec(ua) : null;
    if (m) return { name, version: m[2] ? `${m[1]}.${m[2]}` : m[1] };
  }
  return null;
}

// Order matters, and gecko must not match bare "Gecko": every WebKit and Blink
// UA carries the literal "like Gecko".
const ENGINES = [
  [/edg|chrom|crios|opr|opera|brave|samsungbrowser/i, 'blink'],
  [/firefox|gecko\/\d/i, 'gecko'],
  [/safari|webkit/i, 'webkit'],
];

function matchEngine(s) {
  for (const [re, engine] of ENGINES) if (re.test(s)) return engine;
  return null;
}

function engineOf(device) {
  for (const brand of device.browsers ?? []) {
    const engine = matchEngine(brand);
    if (engine) return engine;
  }
  return (device.ua ? matchEngine(device.ua) : null) ?? 'engine?';
}

function formOf(device) {
  if (FORM[device.type]) return FORM[device.type];
  const ua = device.ua;
  if (!ua) return 'form?';
  if (/iPad|Tablet/i.test(ua)) return 'tablet';
  if (/Mobile|iPhone|iPod|Android/i.test(ua)) return 'mobile';
  return 'desktop';
}

// Coarse components instead of the raw UA, so a patch-version bump does not
// mint a new cache entry. UA only fills what the protocol left empty.
export function cohortOf(ctx) {
  const d = ctx.device ?? {};
  if (!d.ip) return null;

  const ua = (d.os && d.osv) ? null : uaOs(d.ua);
  const os = d.os ? slug(d.os) : ua?.name ?? 'os?';
  const osv = d.osv ? d.osv.split('.').slice(0, 2).join('.') : ua?.version ?? '?';

  return `${os}_${osv}_${formOf(d)}_${engineOf(d)}_${ctx.inventory ?? 'inv?'}_${d.ip}`;
}

function eidValue(eids, source) {
  return eids?.find(e => e.source === source)?.uids?.[0]?.id ?? null;
}

// Priority per the caching guide. Their "first-party ID" tier is absent: its
// input (SharedID / IIQ 1P ID) only exists via the browser integration.
export const KEY_TIERS = ['ifa', 'cohort', 'iiquid'];

// dpi-free on purpose: deployments without an account read the cache that
// deployments with one populate.
export function cacheKeyFor(ctx) {
  const ifa = ctx.device?.ifa;
  if (hasRealIfa(ifa)) return { tier: 'ifa', key: `iiq:ifa:${ifa.toUpperCase()}` };

  const cohort = cohortOf(ctx);
  if (cohort) return { tier: 'cohort', key: `iiq:ua:${cohort}` };

  const iiquid = eidValue(ctx.user?.eids, IIQ_SOURCE);
  if (iiquid) return { tier: 'iiquid', key: `iiq:uid:${iiquid}` };

  return null;
}

export function identityFor(ctx) {
  const d = ctx.device ?? {};
  const identity = {};

  if (d.ip) identity.ip = d.ip;
  if (d.ipv6) identity.ipv6 = d.ipv6;
  if (d.ua) identity.uas = d.ua;

  const ref = ctx.publisher?.bundle ?? ctx.publisher?.domain ?? ctx.publisher?.name;
  if (ref) identity.ref = ref;

  // Sent as received. Their footnote puts the uppercase rule on IDFV only, and
  // an AAID is conventionally lower case — normalising it would send an id no
  // other integration sends. The cache key uppercases separately, to collapse
  // case variants of one device into one entry.
  if (hasRealIfa(d.ifa)) {
    identity.idtype = CTV_TYPES.has(d.type) ? IDTYPE.CTV : IDTYPE.IFA;
    identity.pcid = d.ifa;
  } else if (ctx.user?.id) {
    identity.idtype = IDTYPE.COOKIE;
    identity.pcid = ctx.user.id;
  }

  const iiquid = eidValue(ctx.user?.eids, IIQ_SOURCE);
  if (iiquid) identity.iiquid = iiquid;

  return identity;
}
