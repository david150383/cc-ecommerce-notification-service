import { DeleteMessageCommand, GetQueueUrlCommand, type Message, ReceiveMessageCommand, type SQSClient } from "@aws-sdk/client-sqs";
import type { Logger } from "../lib/logger.js";

export interface InboundMessage {
  messageId: string;
  messageType: string;
  correlationId: string;
  idempotencyKey?: string | null;
  payload: Record<string, unknown>;
}

export interface MessageHandler {
  /** Throws InvalidMessage for messages that can never succeed; any other error is retried. */
  handle(message: InboundMessage): Promise<unknown>;
}

/** A message that can never be processed. It is NOT deleted, so it reaches the DLQ for inspection. */
export class InvalidMessage extends Error {}

/**
 * Long-polls one queue (commands, or events fanned out from SNS). Delete-after-success: on any error the message reappears after the
 * visibility timeout and is retried; after maxReceiveCount attempts SQS moves it to the DLQ.
 * Safe because every handler is idempotent.
 */
export class MessageConsumer {
  private readonly abort = new AbortController();
  private loop: Promise<void> | undefined;
  private queueUrl: string | undefined;

  constructor(
    private readonly sqs: SQSClient,
    private readonly queueName: string,
    private readonly handler: MessageHandler,
    private readonly parse: (raw: unknown) => InboundMessage,
    private readonly logger: Logger,
    private readonly waitTimeSeconds = 20,
  ) {}

  start(): void {
    this.loop = this.run();
  }

  async stop(): Promise<void> {
    this.abort.abort();
    await this.loop;
  }

  /** One receive/handle cycle; exposed for tests. Returns the number of messages handled successfully. */
  async pollOnce(): Promise<number> {
    this.queueUrl ??= (await this.sqs.send(new GetQueueUrlCommand({ QueueName: this.queueName }))).QueueUrl!;
    const { Messages = [] } = await this.sqs.send(
      new ReceiveMessageCommand({
        QueueUrl: this.queueUrl,
        MaxNumberOfMessages: 10,
        WaitTimeSeconds: this.waitTimeSeconds,
        MessageSystemAttributeNames: ["ApproximateReceiveCount"],
      }),
      { abortSignal: this.abort.signal },
    );
    let ok = 0;
    for (const message of Messages) if (await this.process(message)) ok++;
    return ok;
  }

  private async run(): Promise<void> {
    while (!this.abort.signal.aborted) {
      try {
        await this.pollOnce();
      } catch (err) {
        if (this.abort.signal.aborted) return;
        this.logger.error({ err, queue: this.queueName }, "receive failed; backing off");
        await new Promise((r) => setTimeout(r, 2_000));
      }
    }
  }

  private async process(message: Message): Promise<boolean> {
    const receiveCount = Number(message.Attributes?.ApproximateReceiveCount ?? "1");
    let command: InboundMessage;
    try {
      command = this.parse(JSON.parse(message.Body ?? ""));
    } catch (err) {
      this.logger.error({ err, sqsMessageId: message.MessageId, receiveCount }, "invalid message; leaving it for the DLQ");
      return false;
    }
    try {
      await this.handler.handle(command);
    } catch (err) {
      const fatal = err instanceof InvalidMessage;
      this.logger[fatal ? "error" : "warn"](
        { err, messageId: command.messageId, messageType: command.messageType, correlationId: command.correlationId, receiveCount },
        fatal ? "message can never succeed; leaving it for the DLQ" : "message failed; will retry",
      );
      return false;
    }
    await this.sqs.send(new DeleteMessageCommand({ QueueUrl: this.queueUrl!, ReceiptHandle: message.ReceiptHandle! }));
    return true;
  }
}
