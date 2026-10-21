import { expect, test } from "vitest";
import { DrizzleQueryError } from "@webstudio-is/db";
import {
  AuthorizationError,
  PlanRequiredError,
  createErrorResponse,
} from "./errors.server";

test("creates authorization and plan-required errors", () => {
  expect(new AuthorizationError("No access").message).toBe("No access");

  const error = new PlanRequiredError("Upgrade required");
  expect(error.message).toBe("Upgrade required");
  expect(error.code).toBe("PLAN_REQUIRED");
});

test("creates serializable error responses", () => {
  expect(createErrorResponse(new Error("Failed"))).toEqual({
    success: false,
    error: "Failed",
  });
  expect(createErrorResponse("Nope")).toEqual({
    success: false,
    error: "Nope",
  });
});

test("reports the database message of a wrapped query error", () => {
  const error = new DrizzleQueryError(
    "select 1",
    [],
    new Error('duplicate key value violates unique constraint "x"')
  );
  expect(createErrorResponse(error)).toEqual({
    success: false,
    error: 'duplicate key value violates unique constraint "x"',
  });
});
