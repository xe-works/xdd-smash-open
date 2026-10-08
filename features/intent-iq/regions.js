// A region is a (host, dpi) pair — the GDPR one is a separate IIQ account, not
// just another host. Countries are ISO-3166-1 alpha-3 (device.geo.country).
// `eu` is the seven countries IntentIQ covers, NOT the EU and NOT GDPR
// jurisdictions — extend only from their docs.
export const COUNTRY_REGION = {
  USA: 'us', CAN: 'us', MEX: 'us', BRA: 'us',

  JPN: 'apac', AUS: 'apac', NZL: 'apac', KOR: 'apac',
  SGP: 'apac', THA: 'apac', MYS: 'apac', PHL: 'apac',

  GBR: 'eu', IRL: 'eu', ESP: 'eu', FRA: 'eu',
  DEU: 'eu', GRC: 'eu', AUT: 'eu',
};

export const DEFAULT_HOSTS = {
  us: 'be-api-s2s.intentiq.com',
  apac: 'be-api-s2s-apac.intentiq.com',
  eu: 'be-api-s2s-gdpr.intentiq.com',
};

// Fetch target, or a reason we must not fetch. Reasons stay distinct: an
// unserved country and a device IntentIQ has no data for look the same in bid
// volume and mean opposite things. Cache reads never call this.
export function resolveRegion(country, regions) {
  const name = COUNTRY_REGION[country];
  if (!name) return { region: null, reason: 'country_unsupported' };

  const region = regions?.[name];
  const host = region?.host || DEFAULT_HOSTS[name];
  if (!host) return { region: name, reason: 'region_unconfigured' };

  // Supported mode, not a misconfiguration: read a cache others populate.
  if (!region?.dpi) return { region: name, reason: 'no_dpi' };

  return { region: name, host, dpi: String(region.dpi), reason: null };
}
