import { NextResponse } from "next/server";
import { ZodError } from "zod";

export const ERROR_CODES = [
  "FILE_TOO_LARGE",
  "UNSUPPORTED_FORMAT",
  "NO_TEXT_LAYER",
  "CORRUPT_FILE",
  "PARSE_FAILED",
  "LLM_KEY_INVALID",
  "LLM_QUOTA",
  "LLM_RATE_LIMITED",
  "LLM_UNAVAILABLE",
  "LLM_SCHEMA_REPAIR_FAILED",
  "COST_CAP_REACHED",
  "TASK_NOT_IMPLEMENTED",
  "VALIDATION_ERROR",
  // --- Spec 009 (benchmark keyless replay) ---
  "TRANSCRIPT_MISS",
  "NOT_FOUND",
  "CONFIRMATION_REQUIRED",
  "SOURCE_IN_USE",
  "DUPLICATE_SKILL",
  "JD_TOO_SHORT",
  "JD_TOO_LONG",
  "INVALID_STATE",
  // --- Slice 3: generation (contracts/api.md) ---
  "ANALYSIS_NOT_MATCHED",
  "GENERATION_INVALID_STATE",
  "PAGE_BUDGET_CONFLICT",
  "EXPORT_GATE_FAILED",
  "OMISSION_NOT_FOUND",
  "INTERRUPTED",
  // --- Multi-user auth (specs/008, contracts/auth-api.md) ---
  "UNAUTHENTICATED",
  "INVALID_CREDENTIALS",
  "EMAIL_TAKEN",
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

const STATUS_BY_CODE: Record<ErrorCode, number> = {
  FILE_TOO_LARGE: 413,
  UNSUPPORTED_FORMAT: 415,
  NO_TEXT_LAYER: 422,
  CORRUPT_FILE: 422,
  PARSE_FAILED: 424,
  LLM_KEY_INVALID: 400,
  LLM_QUOTA: 402,
  LLM_RATE_LIMITED: 429,
  LLM_UNAVAILABLE: 503,
  LLM_SCHEMA_REPAIR_FAILED: 502,
  COST_CAP_REACHED: 429,
  TASK_NOT_IMPLEMENTED: 501,
  TRANSCRIPT_MISS: 409,
  VALIDATION_ERROR: 400,
  NOT_FOUND: 404,
  CONFIRMATION_REQUIRED: 422,
  SOURCE_IN_USE: 409,
  DUPLICATE_SKILL: 409,
  JD_TOO_SHORT: 400,
  JD_TOO_LONG: 400,
  INVALID_STATE: 409,
  // --- Slice 3: generation (contracts/api.md) ---
  ANALYSIS_NOT_MATCHED: 409,
  GENERATION_INVALID_STATE: 409,
  PAGE_BUDGET_CONFLICT: 409,
  EXPORT_GATE_FAILED: 409,
  OMISSION_NOT_FOUND: 404,
  INTERRUPTED: 500,
  // --- Multi-user auth (specs/008, contracts/auth-api.md) ---
  UNAUTHENTICATED: 401,
  INVALID_CREDENTIALS: 401,
  EMAIL_TAKEN: 409,
};

export class ApiError extends Error {
  constructor(
    public readonly code: ErrorCode,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

/** Single error envelope: { error: { code, message, details? } } */
export function errorResponse(err: unknown): NextResponse {
  if (err instanceof ApiError) {
    return NextResponse.json(
      { error: { code: err.code, message: err.message, details: err.details ?? null } },
      { status: STATUS_BY_CODE[err.code] },
    );
  }
  if (err instanceof ZodError) {
    return NextResponse.json(
      {
        error: {
          code: "VALIDATION_ERROR",
          message: "Request body failed validation.",
          details: err.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
        },
      },
      { status: 400 },
    );
  }
  console.error(redact(String(err instanceof Error ? err.stack : err)));
  return NextResponse.json(
    { error: { code: "INTERNAL_ERROR", message: "Unexpected server error.", details: null } },
    { status: 500 },
  );
}

const SECRET_PATTERNS = [/sk-or-v1-[A-Za-z0-9-_]+/g, /sk-[A-Za-z0-9-_]{20,}/g];

/** Strips anything that looks like an API key before it reaches logs. */
export function redact(text: string): string {
  return SECRET_PATTERNS.reduce((t, re) => t.replace(re, "[REDACTED]"), text);
}
