import { defineCounter } from '../../core/metrics.js';
import { reportImpression } from './client.js';

const BIDDING_PLATFORM_OPENRTB = '4';

const reportTotal = defineCounter(
  'smash_intent_iq_report_total',
  'IntentIQ impression reports by result',
  ['result'],
);

export function buildRdata(context) {
  const iiq = context?.ext?.iiq;
  if (!iiq?.dpi) return null;

  // Number(null) is 0, so a missing price would be reported as a zero-cost
  // impression and corrupt their attribution. Reject it before coercing.
  if (context.price == null || context.price === '') return null;
  const cpm = Number(context.price);
  if (!Number.isFinite(cpm)) return null;

  const currency = iiq.currency ?? 'USD';
  const rdata = {
    bidderCode: iiq.bidder ?? String(context.dsp ?? 'unknown'),
    partnerId: iiq.dpi,
    cpm,
    currency,
    originalCpm: cpm,
    originalCurrency: currency,
    biddingPlatformId: BIDDING_PLATFORM_OPENRTB,
    placementId: iiq.placementId ?? '',
    vrref: iiq.vrref ?? '',
    partnerAuctionId: context.req ?? '',
  };

  if (iiq.abTestUuid) rdata.abTestUuid = iiq.abTestUuid;
  if (iiq.ip) rdata.ip = iiq.ip;
  if (iiq.ua) rdata.ua = iiq.ua;

  return rdata;
}

// No dpi means this deployment never called IntentIQ, the one case their spec
// exempts from reporting.
export function createConsumer(cfg, send = reportImpression) {
  return async context => {
    if (!cfg.reporting?.enabled) return;

    const rdata = buildRdata(context);
    if (!rdata) { reportTotal.inc({ result: 'skipped' }); return; }

    try {
      const res = await send({
        host: cfg.reporting.host,
        dpi: rdata.partnerId,
        rdata,
        timeoutMs: cfg.reportTimeoutMs ?? 2000,
      });
      reportTotal.inc({ result: res.ok ? 'ok' : 'error' });
    } catch {
      reportTotal.inc({ result: 'error' });
    }
  };
}
