// Entries hold the dpi that fetched them. eids are a property of the user and
// travel between accounts, but abTestUuid identifies one account's response —
// reporting someone else's would corrupt their measurement, so the reader only
// uses it when the dpi matches. Omitting it is allowed by the reporting spec.
export function entryFor(eids, abTestUuid, dpi) {
  return { eids: eids ?? [], abTestUuid: abTestUuid ?? null, dpi: dpi ?? null };
}

export function abTestUuidFor(entry, dpi) {
  return entry?.dpi && entry.dpi === dpi ? entry.abTestUuid : null;
}

// cttl is theirs to set; cap it so one bad value cannot pin stale eids for
// days. The cohort tier is a bucket of devices behind one IP, not a device, so
// it never outlives coarseTtlMs.
export function ttlFor(cttl, tier, cfg) {
  const n = Number(cttl);
  const base = Number.isFinite(n) && n > 0 ? n : cfg.ttlMs;
  const capped = Math.min(base, cfg.maxTtlMs);
  return tier === 'cohort' ? Math.min(capped, cfg.coarseTtlMs) : capped;
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
