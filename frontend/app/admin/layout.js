export const metadata = {
  title: 'Admin — Traffic Swarm Intelligence',
  robots: { index: false, follow: false },
};

export default function AdminLayout({ children }) {
  return <div className="admin-root">{children}</div>;
}
