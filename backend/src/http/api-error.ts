export class ApiError extends Error {
  constructor(readonly statusCode: number, readonly publicMessage: string) {
    super(publicMessage);
    this.name = 'ApiError';
  }
}
