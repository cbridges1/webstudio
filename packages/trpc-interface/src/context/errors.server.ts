import { customErrorFactory } from "ts-custom-error";
import { unwrapDbError } from "@webstudio-is/db";

export const AuthorizationError = customErrorFactory(
  function AuthorizationError(message: string) {
    this.message = message;
  }
);

export const PlanRequiredError = customErrorFactory(function PlanRequiredError(
  message: string
) {
  this.message = message;
  this.code = "PLAN_REQUIRED";
});

/**
 * Standard response for any client-server communication with an error.
 */
export const createErrorResponse = (error: unknown) => {
  // Report the database's message, not the SQL of a failed query.
  const reported = unwrapDbError(error);
  const message =
    typeof reported === "string"
      ? reported
      : reported && typeof reported === "object" && "message" in reported
        ? String(reported.message)
        : "Unknown error";
  return {
    success: false as const,
    error: message,
  };
};
