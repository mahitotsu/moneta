import { DeleteMessageCommand, ReceiveMessageCommand, SQSClient } from "@aws-sdk/client-sqs";
import { REGION } from "../../support/stackOutputs";

export interface WaitForDlqMessageOptions {
  timeoutMs?: number;
}

// Polls a queue for a message matching `predicate` and deletes only that message once found --
// any other message received along the way is left alone (its visibility timeout is kept short
// so it becomes visible again quickly) so this never disturbs unrelated DLQ content that might
// be there for a real, unrelated reason.
export async function waitForMatchingMessage(
  queueUrl: string,
  predicate: (body: string) => boolean,
  options: WaitForDlqMessageOptions = {},
): Promise<void> {
  const { timeoutMs = 240_000 } = options;
  const sqs = new SQSClient({ region: REGION });
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const response = await sqs.send(
      new ReceiveMessageCommand({
        QueueUrl: queueUrl,
        MaxNumberOfMessages: 10,
        WaitTimeSeconds: 10,
        VisibilityTimeout: 5,
      }),
    );
    for (const message of response.Messages ?? []) {
      if (message.Body && message.ReceiptHandle && predicate(message.Body)) {
        await sqs.send(new DeleteMessageCommand({ QueueUrl: queueUrl, ReceiptHandle: message.ReceiptHandle }));
        return;
      }
    }
  }
  throw new Error(`timed out after ${timeoutMs}ms waiting for a matching message in ${queueUrl}`);
}
