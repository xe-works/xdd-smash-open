// Entries hold the dpi that fetched them and the region they were fetched from.
// The region is stored rather than derived at report time because the entry
// outlives the request that created it: on a hit the country being served can
// differ from the country that populated it, and the ifa and iiquid tiers carry
// no country in the key at all.
export function entryFor(eids, abTestUuid, dpi, region) {
  return { eids: eids ?? [], abTestUuid: abTestUuid ?? null, dpi: dpi ?? null, region: region ?? null };
}

export function abTestUuidFor(entry, dpi) {
  return entry?.dpi && entry.dpi === dpi ? entry.abTestUuid : null;
}

// cttl is chosen per response and is the only field saying how long that answer
// stays true, so it is used as given. maxTtlMs stays as a single guard against
// an absurd value, nothing below it shortens the entry. coarseTtlMs is an
// optional extra ceiling for the cohort tier, which is a bucket of devices
// behind one IP rather than a device; it is off unless configured.
export function ttlFor(cttl, tier, cfg) {
  const n = Number(cttl);
  const base = Number.isFinite(n) && n > 0 ? n : cfg.ttlMs;
  const capped = Math.min(base, cfg.maxTtlMs);

  const coarse = Number(cfg.coarseTtlMs);
  return tier === 'cohort' && Number.isFinite(coarse) && coarse > 0 ? Math.min(capped, coarse) : capped;
}

export async function read(redis, key) {
  const raw = await redis.get(key);
  if (raw == null) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export async function write(redis, key, entry, ttlMs) {
  await redis.set(key, JSON.stringify(entry), { PX: Math.max(1, Math.round(ttlMs)) });
}
