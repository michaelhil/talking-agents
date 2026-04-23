// Shared helpers for route handlers. Extracted from http-routes.ts so route
// files can import from here without creating a cycle (http-routes.ts imports
// the route arrays from each route file, so pulling helpers the other way
// made every route file bidirectionally bound to the dispatcher).

export const json = (data: unknown, status = 200): Response =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })

export const errorResponse = (message: string, status = 400): Response =>
  json({ error: message }, status)

export const parseBody = async (req: Request): Promise<Record<string, unknown>> => {
  try {
    return (await req.json()) as Record<string, unknown>
  } catch {
    return {}
  }
}
