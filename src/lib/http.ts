import type { Context } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";

export async function readJson<T extends z.ZodType>(c: Context, schema: T): Promise<z.infer<T>> {
  const body: unknown = await c.req.json().catch(() => undefined);
  const result = schema.safeParse(body);
  if (!result.success) throw new HTTPException(400, { message: z.prettifyError(result.error) });
  return result.data;
}

export function idParam(c: Context): number {
  const id = Number(c.req.param("id"));
  if (!Number.isInteger(id) || id <= 0) throw new HTTPException(404, { message: "not found" });
  return id;
}

export const fail = (status: 400 | 404 | 409 | 422, message: string) =>
  new HTTPException(status, { message });
