import fs from 'fs';
import path from 'path';

const htmlPath = path.resolve(__dirname, '../public/index.html');
const outHandlerPath = path.resolve(__dirname, '../src/handlers/web.ts');

const htmlContent = fs.readFileSync(htmlPath, 'utf-8');

const code = `import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';

// Embedded full-fledged SeatMatrix Web Application
const HTML_CONTENT = ${JSON.stringify(htmlContent)};

export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  return {
    statusCode: 200,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'no-cache',
    },
    body: HTML_CONTENT,
  };
};
`;

fs.writeFileSync(outHandlerPath, code, 'utf-8');
console.log('✅ Generated self-contained web.ts handler with embedded full-fledged website!');
