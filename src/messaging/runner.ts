import type { SQSClient } from "@aws-sdk/client-sqs";
import type { Env } from "../config/env.js";
import type { Logger } from "../lib/logger.js";
import type { NotificationService } from "../notifications/notification-service.js";
import type { DlqMonitor } from "./dlq-monitor.js";
import { MessageConsumer } from "./message-consumer.js";
import { commandParser, eventParser } from "./parsers.js";

/** A loop that runs `fn`, then waits `intervalMs`; stop() waits for the current run. */
function every(intervalMs: number, fn: () => Promise<unknown>, onError: (err: unknown) => void) {
  let timer: NodeJS.Timeout | undefined;
  let running: Promise<unknown> | undefined;
  let stopped = false;
  const tick = () => {
    if (stopped) return;
    running = fn()
      .catch(onError)
      .finally(() => {
        if (!stopped) timer = setTimeout(tick, intervalMs);
      });
  };
  return {
    start: () => void (timer = setTimeout(tick, 0)),
    stop: async () => {
      stopped = true;
      clearTimeout(timer);
      await running;
    },
  };
}

/** Background work: the two queue consumers, the delivery worker and the DLQ monitor. */
export function createWorkers(env: Env, sqs: SQSClient, notifications: NotificationService, dlq: DlqMonitor | undefined, logger: Logger) {
  const commands = new MessageConsumer(sqs, env.COMMANDS_QUEUE_NAME, { handle: (m) => notifications.handleCommand(m) }, commandParser(), logger, env.CONSUMER_WAIT_TIME_SECONDS);
  const inbox = new MessageConsumer(sqs, env.INBOX_QUEUE_NAME, { handle: (m) => notifications.handleEvent(m) }, eventParser(), logger, env.CONSUMER_WAIT_TIME_SECONDS);
  // Drain: keep delivering while a full batch came back, then wait for the interval.
  const delivery = every(
    env.DELIVERY_INTERVAL_MS,
    async () => {
      while ((await notifications.deliverDue(10)) === 10);
    },
    (err) => logger.error({ err }, "delivery run failed"),
  );
  const dlqCheck = every(env.DLQ_CHECK_INTERVAL_MS, async () => dlq?.check(), (err) => logger.warn({ err }, "DLQ check failed"));

  return {
    commands,
    inbox,
    start() {
      if (env.MESSAGING_ENABLED) {
        commands.start();
        inbox.start();
        if (dlq && env.DLQ_CHECK_INTERVAL_MS > 0) dlqCheck.start();
      }
      if (env.DELIVERY_INTERVAL_MS > 0) delivery.start();
      logger.info({ messaging: env.MESSAGING_ENABLED }, "notification workers started");
    },
    async stop() {
      await Promise.all([commands.stop(), inbox.stop()]);
      await Promise.all([delivery.stop(), dlqCheck.stop()]);
    },
  };
}
