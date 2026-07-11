export interface ApiSuccessEnvelope<T> {
  success: true;
  statusCode: number;
  data: T;
  timestamp: string;
  path: string;
}

export interface ApiErrorEnvelope {
  success: false;
  statusCode: number;
  message: string[];
  error: string;
  timestamp: string;
  path: string;
}
