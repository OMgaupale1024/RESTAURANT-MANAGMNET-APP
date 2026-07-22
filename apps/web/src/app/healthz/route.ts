// Liveness probe for the web container. Renders nothing, touches nothing —
// just proves the Next server process is up so Docker/orchestrators can health
// the web the same way they health the API.
export const dynamic = 'force-dynamic';

export function GET() {
  return Response.json({ status: 'ok' });
}
