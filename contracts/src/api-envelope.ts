export interface ApiSuccessEnvelope<T> {
  success: true;
  statusCode: number;
  data: T;
  timestamp: string;
  path: string;
}
