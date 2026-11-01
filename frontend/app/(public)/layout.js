import Sidebar from '@/components/Sidebar';
import { SiteConfigProvider, ModuleGate } from '@/components/SiteConfigProvider';

export default function PublicLayout({ children }) {
  return (
    <SiteConfigProvider>
      <div className="app-shell">
        <Sidebar />
        <div className="main-content-area">
          <main>
            <ModuleGate>{children}</ModuleGate>
          </main>
        </div>
      </div>
    </SiteConfigProvider>
  );
}
