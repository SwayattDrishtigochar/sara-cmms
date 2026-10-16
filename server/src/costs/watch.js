import { getAiSettings } from '../ai/settings.js';
import { logger } from '../lib/logger.js';
import { getModule } from '../modules/registry.js';
import { checkAlerts } from './alerts.js';

const intervalMs = async () => {
  const min = await getAiSettings().then(
    (ai) => ai.costWatch?.intervalMin,
    () => null,
  );
  return Math.max(1, min || 15) * 60_000;
};

/**
 * Checks the cost alerts every `costWatch.intervalMin` (re-read each round) until the returned function is
 * called. Companies with enabled alerts are checked one after another and rounds never overlap. The first
 * round waits one interval, so `node --watch` restarts don't re-check everything.
 */
export const startCostWatch = () => {
  let stopped = false;
  let timer = null;
  const schedule = async () => {
    const ms = await intervalMs();
    if (!stopped) timer = setTimeout(tick, ms);
  };
  const tick = async () => {
    try {
      const { costWatch } = await getAiSettings();
      if (costWatch?.enabled !== false) {
        const companies = await getModule('costalerts').Model.distinct('companyId', {
          enabled: true,
          deleted: { $ne: true },
        });
        for (const companyId of companies) {
          if (stopped) break;
          await checkAlerts(companyId).catch((err) => logger.warn({ err, companyId }, 'cost check failed'));
        }
      }
    } catch (err) {
      logger.warn({ err }, 'cost watch round failed');
    } finally {
      await schedule();
    }
  };
  schedule();
  return () => {
    stopped = true;
    clearTimeout(timer);
  };
};
