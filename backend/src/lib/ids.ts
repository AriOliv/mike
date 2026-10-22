// Ids as Postgres stores them: 8-4-4-4-12 hex, any version and variant.
//
// zod's uuid() and the RFC regexes also check the version nibble and the
// variant, so they refuse ids Postgres accepts: the fixed ids of seeds and
// fixtures (00000000-0000-4000-e000-…) among them, which made the preview's
// uploads answer 400 "Invalid UUID". Validate the shape; existence and
// access are the query's job.

import { z } from "zod";

export const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuidShape(value: unknown): value is string {
    return typeof value === "string" && UUID_SHAPE.test(value);
}

/** zod schema for an id; `message` keeps each caller's wording. */
export const uuidId = (message = "Invalid UUID") => z.string().regex(UUID_SHAPE, message);
