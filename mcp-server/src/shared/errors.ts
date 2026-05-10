export class AppError extends Error {
  constructor(
    public message: string,
    public status = 400,
    public code = "APP_ERROR",
    public details?: unknown,
  ) {
    super(message);
  }
}

export class UnauthorizedError extends AppError {
  constructor(message = "unauthorized") {
    super(message, 401, "UNAUTHORIZED");
  }
}

export class NotFoundError extends AppError {
  constructor(message = "not found") {
    super(message, 404, "NOT_FOUND");
  }
}

export class TimeoutError extends AppError {
  constructor(message = "timeout") {
    super(message, 504, "TIMEOUT");
  }
}
