import { NextResponse } from 'next/server';

type Ctx = { params: Promise<Record<string, string>> };

/**
 * Every route handler shares one error envelope, so the client only ever has to
 * check for `{ error }`. The response payload is intentionally untyped here —
 * handlers branch between success and error shapes.
 */
export function handler(fn: (req: Request, ctx: Ctx) => Promise<NextResponse>) {
  return async (req: Request, ctx: Ctx): Promise<NextResponse> => {
    try {
      return await fn(req, ctx);
    } catch (e) {
      const message = e instanceof Error ? e.message : 'unexpected error';
      console.error('[api]', message);
      return NextResponse.json({ error: message }, { status: 400 });
    }
  };
}

export const json = NextResponse.json;
