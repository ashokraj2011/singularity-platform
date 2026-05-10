export class AppError extends Error {
  constructor(public message: string, public status: number = 400, public code: string = "APP_ERROR", public details?: unknown) {
    super(message);
  }
}

export class NotFoundError extends AppError {
  constructor(message = "Not found") { super(message, 404, "NOT_FOUND"); }
}

export class ValidationError extends AppError {
  constructor(message = "Validation failed", details?: unknown) { super(message, 400, "VALIDATION_ERROR", details); }
}

export class ForbiddenError extends AppError {
  constructor(message = "Forbidden") { super(message, 403, "FORBIDDEN"); }
}

export class ConflictError extends AppError {
  constructor(message = "Conflict") { super(message, 409, "CONFLICT"); }
}
