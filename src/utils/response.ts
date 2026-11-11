export interface ApiResponse {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
}

export const buildResponse = (statusCode: number, data: any): ApiResponse => {
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Credentials': 'true',
    },
    body: JSON.stringify(data),
  };
};

export const successResponse = (data: any, statusCode = 200): ApiResponse => {
  return buildResponse(statusCode, { success: true, data });
};

export const errorResponse = (message: string, statusCode = 400, details?: any): ApiResponse => {
  return buildResponse(statusCode, { success: false, error: message, details });
};
