import { Suspense } from 'react';
import { connection } from 'next/server';
import { hasValidSession } from '@/lib/adminAuth';
import AdminLogin from '@/components/admin/AdminLogin';
import AdminDashboard from '@/components/admin/AdminDashboard';

// The session is checked on the server for every render; module data comes only from guarded admin APIs.
async function AdminEntry() {
  await connection();
  return (await hasValidSession()) ? <AdminDashboard /> : <AdminLogin />;
}

export default function AdminPage() {
  return (
    <Suspense fallback={<p className="module-loading muted">Loading…</p>}>
      <AdminEntry />
    </Suspense>
  );
}
