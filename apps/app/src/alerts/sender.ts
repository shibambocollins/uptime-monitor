import { WorkerEntrypoint } from 'cloudflare:workers';
import { deliverDueAlerts, type DeliveryStats } from './deliver';

/**
 * Sends due alerts in its own invocation, called by the tick through ctx.exports after
 * the checks (like CheckRunner). Its own CPU budget, and if it throws, the tick only logs
 * it: checks are already recorded and the deliveries stay queued.
 *
 * Not reachable from the internet: a named entrypoint is only callable through a binding.
 */
export class AlertSender extends WorkerEntrypoint<Env> {
  async deliver(deadline: number): Promise<DeliveryStats> {
    return deliverDueAlerts({
      db: this.env.DB,
      fetch: (url, init) => fetch(url, init),
      now: () => Date.now(),
      encryptionKey: this.env.CHANNEL_ENCRYPTION_KEY,
      deadline,
    });
  }
}
