export const metadata = {
  title: 'Admin — Traffic Swarm Intelligence',
  robots: { index: false, follow: false },
};

// Pinned to one theme so a theme choice can never make the admin controls hard to use.
export default function AdminLayout({ children }) {
  return <div className="admin-root" data-theme="midnight">{children}</div>;
}
