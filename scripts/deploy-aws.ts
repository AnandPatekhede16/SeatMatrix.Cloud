import {
  ApiGatewayV2Client,
  CreateApiCommand,
  CreateIntegrationCommand,
  CreateRouteCommand,
  CreateStageCommand,
  GetApisCommand,
  GetRoutesCommand,
} from '@aws-sdk/client-apigatewayv2';
import {
  AttachRolePolicyCommand,
  CreateRoleCommand,
  GetRoleCommand,
  IAMClient,
} from '@aws-sdk/client-iam';
import {
  AddPermissionCommand,
  CreateEventSourceMappingCommand,
  CreateFunctionCommand,
  GetFunctionCommand,
  LambdaClient,
  ListEventSourceMappingsCommand,
  UpdateFunctionCodeCommand,
  UpdateFunctionConfigurationCommand,
} from '@aws-sdk/client-lambda';
import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { CONFIG } from '../src/config/env';

const REGION = CONFIG.AWS_REGION || 'ap-south-1';
const iamClient = new IAMClient({ region: REGION });
const lambdaClient = new LambdaClient({ region: REGION });
const apiGwClient = new ApiGatewayV2Client({ region: REGION });

const ROLE_NAME = 'TicketEngineLambdaRole';

function createZipBuffer(filePath: string): Buffer {
  const absFile = path.resolve(filePath);
  const zipPath = absFile.replace(/\.js$/, '.zip');
  const tmpDir = path.join(path.dirname(absFile), 'tmp_' + Date.now() + '_' + Math.random().toString(36).substring(7));
  
  if (fs.existsSync(zipPath)) fs.unlinkSync(zipPath);
  if (fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true, force: true });
  fs.mkdirSync(tmpDir, { recursive: true });

  // Copy bundle as index.js
  fs.copyFileSync(absFile, path.join(tmpDir, 'index.js'));

  execSync(
    `powershell -NoProfile -Command "Compress-Archive -Path '${tmpDir}/*' -DestinationPath '${zipPath}' -Force"`,
    { stdio: 'ignore' }
  );

  const buffer = fs.readFileSync(zipPath);
  fs.rmSync(tmpDir, { recursive: true, force: true });
  if (fs.existsSync(zipPath)) fs.unlinkSync(zipPath);
  return buffer;
}

async function ensureLambdaRole(): Promise<string> {
  process.stdout.write(`⏳ Checking IAM Role '${ROLE_NAME}'... `);
  try {
    const res = await iamClient.send(new GetRoleCommand({ RoleName: ROLE_NAME }));
    console.log(`✅ Found: ${res.Role?.Arn}`);
    return res.Role!.Arn!;
  } catch (err: any) {
    if (err.name === 'NoSuchEntityException' || err.name === 'NoSuchEntity') {
      console.log(`Creating...`);
      const assumeRolePolicy = JSON.stringify({
        Version: '2012-10-17',
        Statement: [
          {
            Effect: 'Allow',
            Principal: { Service: 'lambda.amazonaws.com' },
            Action: 'sts:AssumeRole',
          },
        ],
      });

      const createRes = await iamClient.send(
        new CreateRoleCommand({
          RoleName: ROLE_NAME,
          AssumeRolePolicyDocument: assumeRolePolicy,
          Description: 'Execution role for High-Concurrency Ticket Engine Lambdas',
        })
      );

      const policies = [
        'arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole',
        'arn:aws:iam::aws:policy/AmazonDynamoDBFullAccess',
        'arn:aws:iam::aws:policy/AmazonSQSFullAccess',
      ];

      for (const policyArn of policies) {
        await iamClient.send(
          new AttachRolePolicyCommand({
            RoleName: ROLE_NAME,
            PolicyArn: policyArn,
          })
        );
      }

      console.log(`✅ Created role: ${createRes.Role!.Arn}. Waiting 10s for IAM propagation...`);
      await new Promise((r) => setTimeout(r, 10000));
      return createRes.Role!.Arn!;
    }
    throw err;
  }
}

async function bundleHandler(entryPath: string, outPath: string) {
  const dir = path.dirname(outPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  execSync(`npx esbuild ${entryPath} --bundle --platform=node --target=node20 --external:@aws-sdk/* --outfile=${outPath}`, {
    stdio: 'ignore',
  });
}

async function deployLambda(
  functionName: string,
  bundlePath: string,
  roleArn: string
): Promise<string> {
  process.stdout.write(`⏳ Deploying Lambda: ${functionName}... `);
  const zipBuffer = await createZipBuffer(bundlePath);

  const envVars = {
    NODE_ENV: 'production',
    DYNAMODB_EVENTS_TABLE: CONFIG.DYNAMODB_EVENTS_TABLE,
    DYNAMODB_BOOKINGS_TABLE: CONFIG.DYNAMODB_BOOKINGS_TABLE,
    DYNAMODB_IDEMPOTENCY_TABLE: CONFIG.DYNAMODB_IDEMPOTENCY_TABLE,
    SQS_QUEUE_URL: CONFIG.SQS_QUEUE_URL,
    REDIS_URL: CONFIG.REDIS_URL,
    RESERVATION_TTL_SECONDS: CONFIG.RESERVATION_TTL_SECONDS.toString(),
  };

  try {
    const existing = await lambdaClient.send(new GetFunctionCommand({ FunctionName: functionName }));
    await lambdaClient.send(
      new UpdateFunctionCodeCommand({
        FunctionName: functionName,
        ZipFile: zipBuffer,
      })
    );
    // Wait briefly for code update to finish before updating config
    await new Promise((r) => setTimeout(r, 2000));
    await lambdaClient.send(
      new UpdateFunctionConfigurationCommand({
        FunctionName: functionName,
        Environment: { Variables: envVars },
        Timeout: 15,
        MemorySize: 256,
      })
    );
    console.log(`✅ Updated: ${existing.Configuration?.FunctionArn}`);
    return existing.Configuration!.FunctionArn!;
  } catch (err: any) {
    if (err.name === 'ResourceNotFoundException') {
      const createRes = await lambdaClient.send(
        new CreateFunctionCommand({
          FunctionName: functionName,
          Runtime: 'nodejs20.x',
          Role: roleArn,
          Handler: 'index.handler',
          Code: { ZipFile: zipBuffer },
          Timeout: 15,
          MemorySize: 256,
          Environment: { Variables: envVars },
        })
      );
      console.log(`✅ Created: ${createRes.FunctionArn}`);
      return createRes.FunctionArn!;
    }
    throw err;
  }
}

async function ensureSQSTrigger(functionName: string, queueUrl: string) {
  process.stdout.write(`⏳ Linking SQS Queue to ${functionName}... `);
  // Get queue ARN
  const queueArn = `arn:aws:sqs:${REGION}:016147628797:TicketBookingQueue`;

  const mappings = await lambdaClient.send(
    new ListEventSourceMappingsCommand({
      FunctionName: functionName,
    })
  );

  const existing = mappings.EventSourceMappings?.find(
    (m) => m.EventSourceArn === queueArn
  );

  if (existing) {
    console.log(`✅ SQS trigger already linked.`);
  } else {
    await lambdaClient.send(
      new CreateEventSourceMappingCommand({
        FunctionName: functionName,
        EventSourceArn: queueArn,
        BatchSize: 10,
        FunctionResponseTypes: ['ReportBatchItemFailures'],
      })
    );
    console.log(`✅ SQS trigger attached!`);
  }
}

async function ensureHttpApi(): Promise<{ apiId: string; apiEndpoint: string }> {
  process.stdout.write(`⏳ Checking API Gateway HTTP API... `);
  const apis = await apiGwClient.send(new GetApisCommand({}));
  const existing = apis.Items?.find((a) => a.Name === 'TicketEngine-HttpApi');

  if (existing) {
    console.log(`✅ Found: ${existing.ApiEndpoint}`);
    return { apiId: existing.ApiId!, apiEndpoint: existing.ApiEndpoint! };
  }

  const createRes = await apiGwClient.send(
    new CreateApiCommand({
      Name: 'TicketEngine-HttpApi',
      ProtocolType: 'HTTP',
      CorsConfiguration: {
        AllowOrigins: ['*'],
        AllowMethods: ['GET', 'POST', 'OPTIONS'],
        AllowHeaders: ['*'],
      },
    })
  );

  const apiId = createRes.ApiId!;
  await apiGwClient.send(
    new CreateStageCommand({
      ApiId: apiId,
      StageName: '$default',
      AutoDeploy: true,
    })
  );

  console.log(`✅ Created: ${createRes.ApiEndpoint}`);
  return { apiId, apiEndpoint: createRes.ApiEndpoint! };
}

async function linkRoute(
  apiId: string,
  routeKey: string,
  lambdaArn: string,
  functionName: string
) {
  const routes = await apiGwClient.send(new GetRoutesCommand({ ApiId: apiId }));
  const existingRoute = routes.Items?.find((r) => r.RouteKey === routeKey);

  if (!existingRoute) {
    // 1. Create integration
    const integrationRes = await apiGwClient.send(
      new CreateIntegrationCommand({
        ApiId: apiId,
        IntegrationType: 'AWS_PROXY',
        IntegrationUri: lambdaArn,
        PayloadFormatVersion: '2.0',
      })
    );

    // 2. Create route
    await apiGwClient.send(
      new CreateRouteCommand({
        ApiId: apiId,
        RouteKey: routeKey,
        Target: `integrations/${integrationRes.IntegrationId}`,
      })
    );

    // 3. Add permission for API Gateway to invoke Lambda
    try {
      await lambdaClient.send(
        new AddPermissionCommand({
          FunctionName: functionName,
          StatementId: `apigateway-${Date.now()}`,
          Action: 'lambda:InvokeFunction',
          Principal: 'apigateway.amazonaws.com',
          SourceArn: `arn:aws:execute-api:${REGION}:016147628797:${apiId}/*`,
        })
      );
    } catch (err: any) {
      // Ignore if permission already exists
    }
  }
}

async function main() {
  console.log(`\n===============================================================`);
  console.log(`🚀 DEPLOYING SERVERLESS ENGINE TO AWS (${REGION})`);
  console.log(`===============================================================\n`);

  // 1. Bundle TypeScript handlers with esbuild
  console.log(`📦 Bundling TypeScript handlers with esbuild...`);
  await bundleHandler('src/handlers/reserve.ts', 'dist-bundle/reserve.js');
  await bundleHandler('src/handlers/getEvent.ts', 'dist-bundle/getEvent.js');
  await bundleHandler('src/handlers/payment.ts', 'dist-bundle/payment.js');
  await bundleHandler('src/handlers/worker.ts', 'dist-bundle/worker.js');
  await bundleHandler('src/handlers/seed.ts', 'dist-bundle/seed.js');
  await bundleHandler('src/handlers/web.ts', 'dist-bundle/web.js');
  await bundleHandler('src/handlers/admin.ts', 'dist-bundle/admin.js');
  console.log(`✅ Bundling completed.`);

  // 2. IAM Role
  const roleArn = await ensureLambdaRole();

  // 3. Deploy Lambdas
  const reserveArn = await deployLambda('TicketEngine-Reserve', 'dist-bundle/reserve.js', roleArn);
  const getEventArn = await deployLambda('TicketEngine-GetEvent', 'dist-bundle/getEvent.js', roleArn);
  const paymentArn = await deployLambda('TicketEngine-Payment', 'dist-bundle/payment.js', roleArn);
  const workerArn = await deployLambda('TicketEngine-Worker', 'dist-bundle/worker.js', roleArn);
  const seedArn = await deployLambda('TicketEngine-Seed', 'dist-bundle/seed.js', roleArn);
  const webArn = await deployLambda('TicketEngine-Web', 'dist-bundle/web.js', roleArn);
  const adminArn = await deployLambda('TicketEngine-Admin', 'dist-bundle/admin.js', roleArn);

  // 4. SQS trigger on Worker
  await ensureSQSTrigger('TicketEngine-Worker', CONFIG.SQS_QUEUE_URL);

  // 5. API Gateway
  const { apiId, apiEndpoint } = await ensureHttpApi();

  console.log(`🔗 Configuring API Gateway routes...`);
  await linkRoute(apiId, 'GET /', webArn, 'TicketEngine-Web');
  await linkRoute(apiId, 'GET /app', webArn, 'TicketEngine-Web');
  await linkRoute(apiId, 'POST /reserve', reserveArn, 'TicketEngine-Reserve');
  await linkRoute(apiId, 'GET /events/all', getEventArn, 'TicketEngine-GetEvent');
  await linkRoute(apiId, 'GET /events/{eventId}', getEventArn, 'TicketEngine-GetEvent');
  await linkRoute(apiId, 'POST /payment-webhook', paymentArn, 'TicketEngine-Payment');
  await linkRoute(apiId, 'POST /admin/seed', seedArn, 'TicketEngine-Seed');
  await linkRoute(apiId, 'GET /admin/bookings', adminArn, 'TicketEngine-Admin');
  await linkRoute(apiId, 'POST /admin/update-event', adminArn, 'TicketEngine-Admin');
  await linkRoute(apiId, 'POST /admin/create-event', adminArn, 'TicketEngine-Admin');

  // Update public/index.html default URL
  const indexPath = path.resolve(__dirname, '../public/index.html');
  if (fs.existsSync(indexPath)) {
    let html = fs.readFileSync(indexPath, 'utf-8');
    html = html.replace(/value="http:\/\/localhost:3000"/g, `value="${apiEndpoint}"`);
    fs.writeFileSync(indexPath, html);
    console.log(`📝 Updated public/index.html to point to live API Gateway URL by default!`);
  }

  console.log(`\n===============================================================`);
  console.log(`🎉 DEPLOYMENT TO AWS COMPLETED SUCCESSFULLY!`);
  console.log(`🌍 Live Amazon API Gateway URL:`);
  console.log(`   ${apiEndpoint}`);
  console.log(`\nAvailable Endpoints:`);
  console.log(`   POST ${apiEndpoint}/reserve`);
  console.log(`   GET  ${apiEndpoint}/events/event-coldplay-2026`);
  console.log(`   POST ${apiEndpoint}/payment-webhook`);
  console.log(`   POST ${apiEndpoint}/admin/seed`);
  console.log(`===============================================================\n`);
}

main().catch((err) => {
  console.error('\n❌ Deployment failed:', err);
  process.exit(1);
});
