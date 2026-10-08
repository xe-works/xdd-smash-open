import { BidContext } from '../../BidContext.js';

export function parse(body, signal) {
  const device = body.device ?? {};
  const user = body.user ?? {};
  const site = body.site ?? {};
  const app = body.app ?? {};
  const regs = body.regs ?? {};

  const publisher = site.publisher ?? app.publisher ?? {};
  const geo = device.geo ?? {};
  const userExt = user.ext ?? {};
  const regsExt = regs.ext ?? {};

  return new BidContext({
    ssp: signal.ssp,
    dsp: signal.dsp,
    destination: signal.destination,
    ext: signal.ext,
    signals: signal.signals,
    tmax: body.tmax ?? 0,
    raw: body,

    // Which of the mutually exclusive inventory objects the request carries.
    // Derived facts like publisher.bundle and content.page are optional, so
    // they cannot stand in for this.
    inventory: body.app ? 'app' : body.site ? 'site' : body.dooh ? 'dooh' : null,

    impressions: parseImpressions(body.imp ?? []),

    device: {
      country: geo.country ?? null,
      region: geo.region ?? null,
      city: geo.city ?? null,
      // sua (OpenRTB 2.6 structured UA) folded into the flat fields it mirrors,
      // so consumers never deal with two shapes for the same fact.
      os: device.os ?? device.sua?.platform?.brand ?? null,
      osv: device.osv ?? device.sua?.platform?.version?.slice(0, 2).join('.') ?? null,
      type: device.devicetype ?? (device.sua?.mobile != null ? (device.sua.mobile ? 1 : 2) : null),
      // All brands, not the first: client hints deliberately inject a GREASE
      // brand and do not guarantee where the real one sits.
      browsers: device.sua?.browsers?.map(b => b.brand).filter(Boolean) ?? null,
      make: device.make ?? null,
      model: device.model ?? null,
      ua: device.ua ?? null,
      ip: device.ip ?? null,
      ifa: device.ifa ?? null,
      lang: device.language ?? null,
      dnt: device.dnt ?? 0,
      lmt: device.lmt ?? 0,
      js: device.js ?? null,
      connectiontype: device.connectiontype ?? null,
    },

    user: {
      id: user.id ?? null,
      buyeruid: user.buyeruid ?? null,
      consent: userExt.consent ?? user.consent ?? null,
      eids: userExt.eids ?? [],
    },

    publisher: {
      id: publisher.id ?? null,
      domain: site.domain ?? app.domain ?? null,
      bundle: app.bundle ?? null,
      name: site.name ?? app.name ?? null,
      inventoryCode: null,
    },

    privacy: {
      gdpr: regs.gdpr ?? regsExt.gdpr ?? null,
      consent: userExt.consent ?? null,
      usPrivacy: regs.us_privacy ?? regsExt.us_privacy ?? null,
    },

    content: {
      cats: (site.cat ?? app.cat ?? []).slice(),
      pageCats: (site.pagecat ?? app.pagecat ?? []).slice(),
      sectionCats: (site.sectioncat ?? app.sectioncat ?? []).slice(),
      page: site.page ?? null,
      ref: site.ref ?? null,
      keywords: site.keywords ?? app.keywords ?? null,
    },
  });
}

function parseImpressions(imps) {
  return imps.map(imp => {
    const banner = imp.banner ?? null;
    const video = imp.video ?? null;
    const native = imp.native ?? null;
    const impExt = imp.ext ?? {};

    return {
      id: imp.id ?? null,
      floor: imp.bidfloor ?? 0,
      floorCur: imp.bidfloorcur ?? 'USD',
      secure: imp.secure ?? null,
      inventoryCode: imp.tagid ?? null,
      api: imp.api ?? null,

      isBanner: !!banner,
      isVideo: !!video,
      isNative: !!native,
      isRewarded: !!(imp.rwdd || impExt.reward || impExt.rewarded || impExt.prebid?.is_rewarded_inventory),
      instl: !!imp.instl,

      width: banner?.w ?? banner?.format?.[0]?.w ?? null,
      height: banner?.h ?? banner?.format?.[0]?.h ?? null,
      format: banner?.format ?? null,

      videoWidth: video?.w ?? null,
      videoHeight: video?.h ?? null,
      videoMinduration: video?.minduration ?? null,
      videoMaxduration: video?.maxduration ?? null,

      nativeVer: native?.ver ?? null,
      // JSON string holding the Native Request object (assets, plcmttype,
      // context). Kept raw here; BidContext exposes it parsed and memoised
      // behind nativeRequest/nativeAssets/... so it costs nothing per request
      // unless an adapter actually reads it.
      nativeRequestRaw: native?.request ?? null,

      gpid: imp.gpid ?? impExt.gpid ?? null,
      pbadslot: impExt?.data?.pbadslot ?? impExt?.pbadslot ?? null,
      displaymanager: imp.displaymanager ?? null,
      displaymanagerver: imp.displaymanagerver ?? null,
    };
  });
}
