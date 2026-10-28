export class AppError extends Error {
  constructor(message, code = 'ERROR') {
    super(message);
    this.name = 'AppError';
    this.code = code;
  }
}
