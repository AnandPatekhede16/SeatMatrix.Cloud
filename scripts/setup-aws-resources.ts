import {
  CreateTableCommand,
  DescribeTableCommand,
  DynamoDBClient,
  UpdateTimeToLiveCommand,
} from '@aws-sdk/client-dynamodb';
import {
  CreateQueueCommand,
  GetQueueAttributesCommand,
  GetQueueUrlCommand,
  SetQueueAttributesCommand,
  SQSClient,
} from '@aws-sdk/client-sqs';
import fs from 'fs';
import path from 'path';
import { CONFIG } from '../src/config/env';

const dynamoClient = new DynamoDBClient({ region: CONFIG.AWS_REGION });
const sqsClient = new SQSClient({ region: CONFIG.AWS_REGION });

async function ensureTable(
  tableName: string,
  partitionKey: string,
  ttlAttribute?: string
) {
  process.stdout.write(`⏳ Checking DynamoDB Table: ${tableName}... `);
  try {
    await dynamoClient.send(new DescribeTableCommand({ TableName: tableName }));
    console.log(`✅ Already exists.`);
  } catch (err: any) {
    if (err.name === 'ResourceNotFoundException') {
      console.log(`Creating table...`);
      await dynamoClient.send(
        new CreateTableCommand({
          TableName: tableName,
          BillingMode: 'PAY_PER_REQUEST',
          KeySchema: [{ AttributeName: partitionKey, KeyType: 'HASH' }],
          AttributeDefinitions: [{ AttributeName: partitionKey, AttributeType: 'S' }],
        })
      );
      console.log(`✅ Created ${tableName} successfully.`);

      if (ttlAttribute) {
        // Wait a few seconds for table to become ACTIVE before enabling TTL
        console.log(`⏳ Waiting for ${tableName} to become ACTIVE to set TTL...`);
        let isActive = false;
        while (!isActive) {
          await new Promise((r) => setTimeout(r, 2000));
          const desc = await dynamoClient.send(new DescribeTableCommand({ TableName: tableName }));
          if (desc.Table?.TableStatus === 'ACTIVE') {
            isActive = true;
          }
        }
        await dynamoClient.send(
          new UpdateTimeToLiveCommand({
            TableName: tableName,
            TimeToLiveSpecification: {
              Enabled: true,
              AttributeName: ttlAttribute,
            },
          })
        );
        console.log(`✅ Enabled TTL on attribute '${ttlAttribute}' for ${tableName}`);
      }
    } else {
      throw err;
    }
  }
}

async function ensureQueue(queueName: string, isDLQ = false, dlqArn?: string): Promise<string> {
  process.stdout.write(`⏳ Checking SQS Queue: ${queueName}... `);
  try {
    const urlRes = await sqsClient.send(new GetQueueUrlCommand({ QueueName: queueName }));
    console.log(`✅ Already exists: ${urlRes.QueueUrl}`);
    return urlRes.QueueUrl!;
  } catch (err: any) {
    if (err.name === 'QueueDoesNotExist' || err.name === 'AWS.SimpleQueueService.NonExistentQueue') {
      console.log(`Creating queue...`);
      const attributes: Record<string, string> = {};
      if (!isDLQ && dlqArn) {
        attributes['RedrivePolicy'] = JSON.stringify({
          deadLetterTargetArn: dlqArn,
          maxReceiveCount: '3',
        });
      }
      const createRes = await sqsClient.send(
        new CreateQueueCommand({
          QueueName: queueName,
          Attributes: attributes,
        })
      );
      console.log(`✅ Created ${queueName}: ${createRes.QueueUrl}`);
      return createRes.QueueUrl!;
    } else {
      throw err;
    }
  }
}

async function getQueueArn(queueUrl: string): Promise<string> {
  const attrs = await sqsClient.send(
    new GetQueueAttributesCommand({
      QueueUrl: queueUrl,
      AttributeNames: ['QueueArn'],
    })
  );
  return (attrs.Attributes?.QueueArn as string) || '';
}

async function main() {
  console.log(`\n===============================================================`);
  console.log(`☁️  AWS INFRASTRUCTURE PROVISIONING (${CONFIG.AWS_REGION})`);
  console.log(`===============================================================\n`);

  // 1. Tables
  await ensureTable(CONFIG.DYNAMODB_EVENTS_TABLE, 'eventId');
  await ensureTable(CONFIG.DYNAMODB_BOOKINGS_TABLE, 'bookingId', 'expiresAt');
  await ensureTable(CONFIG.DYNAMODB_IDEMPOTENCY_TABLE, 'idempotencyKey', 'ttl');

  // 2. SQS DLQ & Main Queue
  const dlqUrl = await ensureQueue('TicketBookingDLQ', true);
  const dlqArn = await getQueueArn(dlqUrl);
  const mainQueueUrl = await ensureQueue('TicketBookingQueue', false, dlqArn);

  // 3. Update .env with SQS Queue URL
  const envPath = path.resolve(__dirname, '../.env');
  if (fs.existsSync(envPath)) {
    let content = fs.readFileSync(envPath, 'utf-8');
    content = content.replace(/SQS_QUEUE_URL=.*/g, `SQS_QUEUE_URL=${mainQueueUrl}`);
    fs.writeFileSync(envPath, content);
    console.log(`\n📝 Updated SQS_QUEUE_URL in .env with: ${mainQueueUrl}`);
  }

  console.log(`\n===============================================================`);
  console.log(`🎉 AWS CLOUD RESOURCES READY!`);
  console.log(`   DynamoDB Tables: ${CONFIG.DYNAMODB_EVENTS_TABLE}, ${CONFIG.DYNAMODB_BOOKINGS_TABLE}, ${CONFIG.DYNAMODB_IDEMPOTENCY_TABLE}`);
  console.log(`   SQS Queue URL:   ${mainQueueUrl}`);
  console.log(`===============================================================\n`);
}

main().catch((err) => {
  console.error('\n❌ Error provisioning AWS resources:', err);
  process.exit(1);
});
