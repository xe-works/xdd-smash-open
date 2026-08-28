import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../../core/config.js';
import hook from './prebid-dsp.js';
import { createConsumer } from './reporting.js';

const __dir = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dir, '../..');

const LABEL = 'intent-iq/prebid-dsp';

export function register(registry, services) {
  const cfg = loadConfig(resolve(__dir, 'config.json'), resolve(ROOT, 'config.json'), 'intentIq');

  if (cfg.enabled) {
    registry.register('prebid-dsp', null, hook, LABEL);

    if (cfg.reporting?.enabled) {
      services?.get?.('tracking')?.addConsumer(createConsumer(cfg));
    }
  }

  return { side: 'feature', bidder: 'intent-iq', stage: 'prebid-dsp', label: LABEL };
}
