import {
  DeleteMessageCommand,
  ReceiveMessageCommand,
  SQSClient,
} from '@aws-sdk/client-sqs';
import { CONFIG } from '../src/config/env';
import { processQueueMessage } from '../src/handlers/worker';
import { QueueMessage } from '../src/types';

const sqsClient = new SQSClient({ region: CONFIG.AWS_REGION });

async function pollQueue() {
  console.log(`\n===============================================================`);
  console.log(`⚙️  STARTING SQS CONSUMER WORKER`);
  console.log(`Queue URL: ${CONFIG.SQS_QUEUE_URL}`);
  console.log(`Region:    ${CONFIG.AWS_REGION}`);
  console.log(`===============================================================\n`);

  if (!CONFIG.SQS_QUEUE_URL) {
    console.error('❌ SQS_QUEUE_URL is not configured in .env!');
    process.exit(1);
  }

  while (true) {
    try {
      const response = await sqsClient.send(
        new ReceiveMessageCommand({
          QueueUrl: CONFIG.SQS_QUEUE_URL,
          MaxNumberOfMessages: 10,
          WaitTimeSeconds: 5, // Long polling
        })
      );

      if (response.Messages && response.Messages.length > 0) {
        console.log(`📥 Received ${response.Messages.length} message(s) from SQS:`);

        for (const msg of response.Messages) {
          if (!msg.Body) continue;

          try {
            const queueMsg: QueueMessage = JSON.parse(msg.Body);
            await processQueueMessage(queueMsg);

            // Delete message from SQS upon successful processing
            await sqsClient.send(
              new DeleteMessageCommand({
                QueueUrl: CONFIG.SQS_QUEUE_URL,
                ReceiptHandle: msg.ReceiptHandle!,
              })
            );
            console.log(`🗑️ Deleted message for bookingId: ${queueMsg.bookingId} from SQS`);
          } catch (err: any) {
            console.error(`❌ Error processing SQS message:`, err.message);
          }
        }
      } else {
        process.stdout.write(`⏳ Waiting for new messages in SQS...\r`);
      }
    } catch (err: any) {
      console.error('SQS Poll error:', err.message);
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
}

pollQueue();
