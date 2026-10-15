import { DeleteQueueCommand, ListQueuesCommand, type SQSClient } from "@aws-sdk/client-sqs";

/**
 * Deletes what one test run created in the emulator, by the run's unique prefix (e.g. "t-ab12cd34ef-"),
 * so runs do not pile up queues and topics. Refuses any prefix that is not a per-run test prefix.
 */
function assertTestPrefix(prefix: string): void {
  if (!/^(t|test)-[a-z0-9-]{6,}-$/.test(prefix)) throw new Error(`refusing to delete resources for prefix ${prefix}`);
}

export async function deleteTestQueues(sqs: SQSClient, prefix: string): Promise<void> {
  assertTestPrefix(prefix);
  const { QueueUrls = [] } = await sqs.send(new ListQueuesCommand({ QueueNamePrefix: prefix }));
  for (const url of QueueUrls) {
    if (url.slice(url.lastIndexOf("/") + 1).startsWith(prefix)) await sqs.send(new DeleteQueueCommand({ QueueUrl: url }));
  }
}
