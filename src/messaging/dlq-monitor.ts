import { ChangeMessageVisibilityBatchCommand, GetQueueAttributesCommand, GetQueueUrlCommand, ReceiveMessageCommand, type SQSClient } from "@aws-sdk/client-sqs";
import type { Logger } from "../lib/logger.js";

export interface DeadLetter {
  queue: string;
  sqsMessageId: string;
  receiveCount: number;
  sentAt: string | null;
  /** Identifying envelope fields only; the payload (personal data) stays in the queue. */
  messageId: string | null;
  messageType: string | null;
  correlationId: string | null;
}

/**
 * Watches this service's DLQs. Anything there needs a human (alarms do this in AWS; locally the
 * log line is the alarm). The admin API peeks at the messages without consuming them.
 */
export class DlqMonitor {
  private readonly urls = new Map<string, string>();

  constructor(
    private readonly sqs: SQSClient,
    private readonly queues: string[],
    private readonly logger: Logger,
  ) {}

  private async url(name: string): Promise<string> {
    if (!this.urls.has(name)) this.urls.set(name, (await this.sqs.send(new GetQueueUrlCommand({ QueueName: name }))).QueueUrl!);
    return this.urls.get(name)!;
  }

  async depths(): Promise<Record<string, number>> {
    const out: Record<string, number> = {};
    for (const q of this.queues) {
      const { Attributes } = await this.sqs.send(new GetQueueAttributesCommand({ QueueUrl: await this.url(q), AttributeNames: ["ApproximateNumberOfMessages"] }));
      out[q] = Number(Attributes?.ApproximateNumberOfMessages ?? 0);
    }
    return out;
  }

  /** One check; logs at error level when any DLQ is not empty. */
  async check(): Promise<Record<string, number>> {
    const depths = await this.depths();
    const nonEmpty = Object.entries(depths).filter(([, n]) => n > 0);
    if (nonEmpty.length > 0) this.logger.error({ deadLetters: Object.fromEntries(nonEmpty) }, "messages in dead-letter queues need attention");
    return depths;
  }

  /** Reads up to `max` messages per DLQ and makes them visible again at once (a peek, not a consume). */
  async peek(max = 10): Promise<DeadLetter[]> {
    const out: DeadLetter[] = [];
    for (const q of this.queues) {
      const url = await this.url(q);
      const { Messages = [] } = await this.sqs.send(
        new ReceiveMessageCommand({ QueueUrl: url, MaxNumberOfMessages: Math.min(max, 10), VisibilityTimeout: 5, MessageSystemAttributeNames: ["ApproximateReceiveCount", "SentTimestamp"] }),
      );
      if (Messages.length > 0) {
        await this.sqs.send(
          new ChangeMessageVisibilityBatchCommand({ QueueUrl: url, Entries: Messages.map((m, i) => ({ Id: String(i), ReceiptHandle: m.ReceiptHandle!, VisibilityTimeout: 0 })) }),
        );
      }
      for (const m of Messages) {
        let env: Record<string, unknown> = {};
        try {
          env = JSON.parse(m.Body ?? "") as Record<string, unknown>;
        } catch {
          // unparseable: that is often why it is here
        }
        const s = (k: string) => (typeof env[k] === "string" ? (env[k] as string) : null);
        out.push({
          queue: q,
          sqsMessageId: m.MessageId!,
          receiveCount: Number(m.Attributes?.ApproximateReceiveCount ?? 0),
          sentAt: m.Attributes?.SentTimestamp ? new Date(Number(m.Attributes.SentTimestamp)).toISOString() : null,
          messageId: s("messageId"),
          messageType: s("messageType"),
          correlationId: s("correlationId"),
        });
      }
    }
    return out;
  }
}
