import './globals.css';
import './styles/system.css';
import { themeBootScript } from '@/lib/themeBoot';

export const metadata = {
  title: 'Traffic Swarm Intelligence — Adaptive Command Lab',
  description: 'PSO + ACO multi-agent traffic signal optimization with safety-gated control and SUMO simulation. Real-time dashboard for experiments, live simulation, and controller comparison.',
};

export default function RootLayout({ children }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeBootScript }} />
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link
          href="https://fonts.googleapis.com/css2?family=Outfit:wght@400;500;600;700;800&family=Plus+Jakarta+Sans:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500;600&display=swap"
          rel="stylesheet"
        />
      </head>
      <body>{children}</body>
    </html>
  );
}
