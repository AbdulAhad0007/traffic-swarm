import { connection } from 'next/server';
import { getSiteConfig } from '@/lib/siteConfig';

// Effective on/off flags only: no saved parent-off states, timestamps or admin data.
export async function GET() {
  await connection();
  return Response.json(await getSiteConfig(), { headers: { 'Cache-Control': 'no-store' } });
}
