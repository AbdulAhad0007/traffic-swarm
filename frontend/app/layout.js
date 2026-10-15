import './globals.css';
import Sidebar from '@/components/Sidebar';

export const metadata = {
  title: 'Traffic Swarm Intelligence — Adaptive Command Lab',
  description: 'PSO + ACO multi-agent traffic signal optimization with safety-gated control and SUMO simulation. Real-time dashboard for experiments, live simulation, and controller comparison.',
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link
          href="https://fonts.googleapis.com/css2?family=Outfit:wght@400;500;600;700;800&family=Plus+Jakarta+Sans:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500;600&display=swap"
          rel="stylesheet"
        />
      </head>
      <body>
        <div className="app-shell">
          <Sidebar />
          <div className="main-content-area">
            <main>
              <header className="app-main-header">
                <div>
                  <span className="eyebrow">
                    <span className="dot-pulse" />
                    AI SWARM INTELLIGENCE CORE · SUMO MICROSCOPIC SIMULATOR
                  </span>
                  <h1>Traffic Swarm Intelligence Lab</h1>
                  <p>Hybrid PSO + ACO Optimization · Multi-Agent Blackboard Coordination · Microscopic Real-Time SUMO Simulation</p>
                </div>
                <div className="header-meta-box">
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                    <span className="badge live">● SIMULATION READY</span>
                    <span className="status" style={{ fontSize: 11 }}>v1.3.2-eval</span>
                  </div>
                  <span className="muted" style={{ fontSize: 12 }}>3×3 · 5×5 · 9×9 Grids & Bengaluru OSM</span>
                </div>
              </header>
              {children}
            </main>
          </div>
        </div>
      </body>
    </html>
  );
}
