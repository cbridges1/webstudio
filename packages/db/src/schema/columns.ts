import { customType } from "drizzle-orm/pg-core";

/**
 * `timestamp(3) with time zone`, read and written as an ISO 8601 string.
 * Upstream code was written against PostgREST, which returned timestamps as strings,
 * so rows keep that shape.
 */
export const timestamptz = customType<{
  data: string;
  driverData: string | Date;
}>({
  dataType: () => "timestamp(3) with time zone",
  fromDriver: (value) => new Date(value).toISOString(),
  toDriver: (value) => value,
});
