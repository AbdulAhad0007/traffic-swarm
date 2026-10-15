'use client';

import React, { useState, useEffect } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import {
  Activity,
  Radio,
  GitCompare,
  SlidersHorizontal,
  TrendingUp,
  Layers,
  ChevronLeft,
  ChevronRight,
  Menu,
  X,
  ShieldCheck,
  Cpu,
  Car,
  MapPin
} from 'lucide-react';

const NAV_ITEMS = [
  { href: '/', label: 'Overview & Benchmark', icon: Activity, tag: 'CORE' },
  { href: '/ghaziabad', label: 'Ghaziabad Live Map', icon: MapPin, tag: 'NCR' },
  { href: '/live', label: 'Live Lab & Heatmap', icon: Radio, tag: 'LIVE' },
  { href: '/demo', label: 'Before / After Replay', icon: GitCompare, tag: 'DUAL' },
  { href: '/controllers', label: 'Controller Comparison', icon: SlidersHorizontal, tag: 'EVAL' },
  { href: '/prediction', label: 'Congestion Prediction', icon: TrendingUp, tag: 'AI' },
  { href: '/mixed', label: 'Indian Mixed Traffic', icon: Layers, tag: 'OSM' },
];

export default function Sidebar() {
  const pathname = usePathname();
  const [collapsed, setCollapsed] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [isMobile, setIsMobile] = useState(false);

  // Track the mobile breakpoint so the drawer always shows full labels
  useEffect(() => {
    const mq = window.matchMedia('(max-width: 900px)');
    const update = () => setIsMobile(mq.matches);
    update();
    mq.addEventListener('change', update);
    return () => mq.removeEventListener('change', update);
  }, []);

  // Icon-only mode is a desktop feature; the mobile drawer is always expanded
  const isCollapsed = collapsed && !isMobile;

  // Close mobile drawer on route change
  useEffect(() => {
    setMobileOpen(false);
  }, [pathname]);

  // Lock page scroll while the mobile drawer is open; close it on Escape
  // or when the viewport grows back to desktop width.
  useEffect(() => {
    if (!mobileOpen) return undefined;
    const onKey = (e) => { if (e.key === 'Escape') setMobileOpen(false); };
    const mq = window.matchMedia('(min-width: 901px)');
    const onResize = () => { if (mq.matches) setMobileOpen(false); };
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    window.addEventListener('keydown', onKey);
    mq.addEventListener('change', onResize);
    return () => {
      document.body.style.overflow = prevOverflow;
      window.removeEventListener('keydown', onKey);
      mq.removeEventListener('change', onResize);
    };
  }, [mobileOpen]);

  return (
    <>
      {/* Mobile Top Bar with Hamburger */}
      <div className="mobile-header">
        <button
          className="mobile-toggle"
          onClick={() => setMobileOpen(!mobileOpen)}
          aria-label={mobileOpen ? 'Close navigation' : 'Open navigation'}
          aria-expanded={mobileOpen}
          aria-controls="app-sidebar"
        >
          {mobileOpen ? <X size={20} /> : <Menu size={20} />}
        </button>
        <div className="mobile-brand">
          <span className="dot-pulse" />
          <b>TRAFFIC SWARM</b>
        </div>
        <span className="badge live" style={{ fontSize: 10, padding: '3px 8px' }}>
          ONLINE
        </span>
      </div>

      {/* Backdrop for mobile drawer */}
      {mobileOpen && (
        <div
          className="sidebar-backdrop"
          onClick={() => setMobileOpen(false)}
        />
      )}

      {/* Main Sidebar Element */}
      <aside id="app-sidebar" className={`app-sidebar ${isCollapsed ? 'collapsed' : ''} ${mobileOpen ? 'mobile-open' : ''}`}>
        {/* Brand / Header */}
        <div className="sidebar-header">
          {!isCollapsed ? (
            <div className="sidebar-brand">
              <div className="brand-icon-box">
                <Car size={18} color="#38bdf8" />
              </div>
              <div className="brand-text">
                <span className="brand-title">TRAFFIC SWARM</span>
                <span className="brand-sub">Command Center</span>
              </div>
            </div>
          ) : (
            <div className="brand-icon-box collapsed-icon" title="Traffic Swarm Intelligence">
              <Car size={18} color="#38bdf8" />
            </div>
          )}

          <button
            className="sidebar-collapse-btn"
            onClick={() => setCollapsed(!collapsed)}
            title={isCollapsed ? 'Expand Sidebar' : 'Collapse Sidebar'}
            aria-label="Toggle sidebar width"
          >
            {isCollapsed ? <ChevronRight size={16} /> : <ChevronLeft size={16} />}
          </button>

          {/* Close button shown only inside the mobile drawer */}
          <button
            className="sidebar-close-btn"
            onClick={() => setMobileOpen(false)}
            aria-label="Close navigation"
          >
            <X size={18} />
          </button>
        </div>

        {/* Live Status Chip */}
        {!isCollapsed && (
          <div className="sidebar-status-banner">
            <span className="dot-pulse" />
            <span>AI Core Active · SUMO 1.27</span>
          </div>
        )}

        {/* Navigation Links */}
        <nav className="sidebar-nav">
          {NAV_ITEMS.map(({ href, label, icon: Icon, tag }) => {
            const isActive = pathname === href;
            return (
              <Link
                key={href}
                href={href}
                className={`sidebar-nav-item ${isActive ? 'active' : ''}`}
                title={isCollapsed ? label : undefined}
              >
                <div className="nav-icon-wrap">
                  <Icon
                    size={18}
                    color={isActive ? '#38bdf8' : 'currentColor'}
                  />
                </div>
                {!isCollapsed && (
                  <>
                    <span className="nav-label">{label}</span>
                    <span className={`nav-tag ${tag === 'LIVE' ? 'tag-live' : ''}`}>
                      {tag}
                    </span>
                  </>
                )}
                {isCollapsed && isActive && <div className="collapsed-active-indicator" />}
              </Link>
            );
          })}
        </nav>

        {/* Bottom System Telemetry Widget */}
        {!isCollapsed && (
          <div className="sidebar-footer">
            <div className="telemetry-pill">
              <Cpu size={14} color="#38bdf8" />
              <span>PSO + ACO</span>
              <b style={{ marginLeft: 'auto', color: '#10b981' }}>OK</b>
            </div>
            <div className="telemetry-pill">
              <ShieldCheck size={14} color="#10b981" />
              <span>Safety Gate</span>
              <b style={{ marginLeft: 'auto', color: '#10b981' }}>HARD</b>
            </div>
            <div className="sidebar-version-text">
              Eclipse SUMO 1.27.1 Microscopic Engine
            </div>
          </div>
        )}
      </aside>
    </>
  );
}
