'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Activity, Radio, GitCompare, SlidersHorizontal, TrendingUp, Layers } from 'lucide-react';

const TABS = [
  { href: '/', label: 'Overview & Benchmark', icon: Activity },
  { href: '/live', label: 'Live Lab & Heatmap', icon: Radio },
  { href: '/demo', label: 'Before / After Replay', icon: GitCompare },
  { href: '/controllers', label: 'Controller Comparison', icon: SlidersHorizontal },
  { href: '/prediction', label: 'Congestion Prediction', icon: TrendingUp },
  { href: '/mixed', label: 'Indian Mixed Traffic', icon: Layers },
];

export default function NavBar() {
  const pathname = usePathname();
  return (
    <nav className="tabs main">
      {TABS.map(({ href, label, icon: Icon }) => {
        const isActive = pathname === href;
        return (
          <Link key={href} href={href} className={isActive ? 'on' : ''}>
            <Icon size={15} color={isActive ? '#38bdf8' : 'currentColor'} />
            <span>{label}</span>
          </Link>
        );
      })}
    </nav>
  );
}
