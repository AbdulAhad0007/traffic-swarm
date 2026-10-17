'use client';

import React, { useState, useMemo } from 'react';
import {
  Layers,
  Car,
  Fuel,
  TrendingDown,
  Activity,
  CheckCircle,
  AlertTriangle,
  Clock,
  Sparkles,
  Zap,
  SlidersHorizontal
} from 'lucide-react';
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
  PieChart,
  Pie,
  Cell
} from 'recharts';
import { SUPPORTED_CITIES } from '@/lib/cityData';
import RichDropdown from '@/components/RichDropdown';

const VEHICLE_TYPES = [
  { id: 'tw', label: 'Motorcycles & Scooters', icon: '🏍️', defaultPct: 42, color: '#38bdf8', pcu: 0.5, desc: 'High acceleration & sublane filtering' },
  { id: 'auto', label: 'Auto-Rickshaws (3-Wheelers)', icon: '🛺', defaultPct: 22, color: '#f59e0b', pcu: 0.8, desc: 'Short turning radius & frequent stops' },
  { id: 'car', label: 'Passenger Cars & Taxis', icon: '🚗', defaultPct: 26, color: '#10b981', pcu: 1.0, desc: 'Standard private passenger vehicle' },
  { id: 'bus', label: 'City Buses & Trucks', icon: '🚌', defaultPct: 10, color: '#ef4444', pcu: 2.8, desc: 'Large footprint & slow intersection clearance' },
];

export default function MixedTrafficSimulator() {
  const [selectedCityId, setSelectedCityId] = useState('delhi');
  const [rickshawBikeBias, setRickshawBikeBias] = useState(64); // Combined 2W + 3W %
  const [trafficVolume, setTrafficVolume] = useState(3200); // Vehicles / hour / corridor

  const city = useMemo(() => {
    return SUPPORTED_CITIES.find(c => c.id === selectedCityId) || SUPPORTED_CITIES[0];
  }, [selectedCityId]);

  // Compute shares dynamically
  const mixShares = useMemo(() => {
    const twoWheelerPct = Math.round(rickshawBikeBias * 0.65);
    const autoPct = rickshawBikeBias - twoWheelerPct;
    const remaining = 100 - rickshawBikeBias;
    const busPct = Math.max(6, Math.round(remaining * 0.28));
    const carPct = remaining - busPct;

    return [
      { name: 'Motorcycles & Scooters (2W)', value: twoWheelerPct, color: '#38bdf8', icon: '🏍️' },
      { name: 'Auto-Rickshaws (3W)', value: autoPct, color: '#f59e0b', icon: '🛺' },
      { name: 'Passenger Cars (4W)', value: carPct, color: '#10b981', icon: '🚗' },
      { name: 'City Buses & Commercial', value: busPct, color: '#ef4444', icon: '🚌' },
    ];
  }, [rickshawBikeBias]);

  // Performance comparison: Fixed vs Swarm under mixed conditions
  const comparisonData = useMemo(() => {
    // Fixed timers suffer worse when mixed traffic is higher because non-lane discipline breaks standard gap timing
    const penaltyFactor = 1.0 + (rickshawBikeBias / 100) * 0.45;
    const baseDelaySec = Math.round(68 * penaltyFactor);
    const swarmDelaySec = Math.round(22 + (rickshawBikeBias * 0.08));

    const baseQueueVeh = Math.round((trafficVolume / 75) * penaltyFactor);
    const swarmQueueVeh = Math.round(baseQueueVeh * 0.32);

    const baseFuelLitresPerHr = Math.round((trafficVolume * 0.024) * penaltyFactor);
    const swarmFuelLitresPerHr = Math.round(baseFuelLitresPerHr * 0.68);

    return [
      { metric: 'Avg Delay (sec/veh)', fixed: baseDelaySec, swarm: swarmDelaySec, unit: 'sec' },
      { metric: 'Intersection Queue', fixed: baseQueueVeh, swarm: swarmQueueVeh, unit: 'veh' },
      { metric: 'Fuel Wasted in Idling', fixed: baseFuelLitresPerHr, swarm: swarmFuelLitresPerHr, unit: 'L/hr' },
    ];
  }, [rickshawBikeBias, trafficVolume]);

  const fuelSavedPerDayLiters = useMemo(() => {
    const hourlySaved = comparisonData[2].fixed - comparisonData[2].swarm;
    return Math.round(hourlySaved * 14); // 14 operational peak hours
  }, [comparisonData]);

  const cityOptions = SUPPORTED_CITIES.map(c => ({
    value: c.id,
    label: c.name,
    sub: c.region,
  }));

  return (
    <div style={{ padding: '24px', maxWidth: '1440px', margin: '0 auto', color: '#f8fafc' }}>
      {/* Header */}
      <div style={{
        position: 'relative',
        zIndex: 20,
        background: 'linear-gradient(135deg, rgba(30, 41, 59, 0.8) 0%, rgba(15, 23, 42, 0.95) 100%)',
        border: '1px solid rgba(16, 185, 129, 0.25)',
        borderRadius: 12,
        padding: 24,
        marginBottom: 24,
        boxShadow: '0 8px 32px rgba(0,0,0,0.37)'
      }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: 16 }}>
          <div style={{ flex: '1 1 360px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
              <span style={{
                background: 'rgba(16, 185, 129, 0.15)',
                color: '#10b981',
                border: '1px solid rgba(16, 185, 129, 0.3)',
                padding: '4px 10px',
                borderRadius: 6,
                fontSize: '0.8rem',
                fontWeight: 600,
                display: 'inline-flex',
                alignItems: 'center',
                gap: 6
              }}>
                <Layers size={14} /> INDIAN MIXED TRAFFIC SIMULATOR
              </span>
              <span style={{ color: '#38bdf8', fontSize: '0.8rem' }}>
                Non-Lane Heterogeneous Vehicle Flow
              </span>
            </div>
            <h1 style={{ margin: 0, fontSize: '1.75rem', fontWeight: 700, color: '#f1f5f9' }}>
              Indian Road Mixed-Vehicle Traffic Optimization
            </h1>
            <p style={{ margin: '6px 0 0 0', color: '#94a3b8', fontSize: '0.95rem' }}>
              How Swarm Intelligence manages chaotic Indian roads with auto-rickshaws, two-wheelers, cars, and buses without fixed lane boundaries.
            </p>
          </div>

          <div style={{ minWidth: 200, maxWidth: 280, flex: '1 1 200px' }}>
            <RichDropdown
              options={cityOptions}
              items={cityOptions}
              value={selectedCityId}
              onChange={setSelectedCityId}
              icon={Activity}
              label="Selected City"
            />
          </div>
        </div>
      </div>

      {/* Interactive Sliders for Vehicle Ratios */}
      <div style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))',
        gap: 20,
        marginBottom: 24
      }}>
        <div style={{ background: 'rgba(30, 41, 59, 0.6)', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 12, padding: 20 }}>
          <h3 style={{ margin: '0 0 16px 0', fontSize: '1rem', color: '#38bdf8', display: 'flex', alignItems: 'center', gap: 8 }}>
            <SlidersHorizontal size={16} /> Indian Traffic Composition Controls
          </h3>

          <div style={{ marginBottom: 20 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6, fontSize: '0.88rem' }}>
              <span style={{ color: '#cbd5e1' }}>🏍️ 2-Wheeler & 🛺 Auto-Rickshaw Share:</span>
              <b style={{ color: '#f59e0b' }}>{rickshawBikeBias}%</b>
            </div>
            <input
              type="range"
              min="20"
              max="85"
              value={rickshawBikeBias}
              onChange={e => setRickshawBikeBias(Number(e.target.value))}
              style={{ width: '100%', cursor: 'pointer', accentColor: '#f59e0b' }}
            />
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.72rem', color: '#64748b', marginTop: 4 }}>
              <span>Expressway (Heavy Cars)</span>
              <span>City Core (High 2W/3W Density)</span>
            </div>
          </div>

          <div>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6, fontSize: '0.88rem' }}>
              <span style={{ color: '#cbd5e1' }}>Corridor Traffic Demand:</span>
              <b style={{ color: '#10b981' }}>{trafficVolume} veh / hr</b>
            </div>
            <input
              type="range"
              min="1000"
              max="6000"
              step="200"
              value={trafficVolume}
              onChange={e => setTrafficVolume(Number(e.target.value))}
              style={{ width: '100%', cursor: 'pointer', accentColor: '#10b981' }}
            />
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.72rem', color: '#64748b', marginTop: 4 }}>
              <span>Off-Peak Flow</span>
              <span>Heavy Rush Hour</span>
            </div>
          </div>
        </div>

        {/* Vehicle Distribution Pie Chart */}
        <div style={{ background: 'rgba(30, 41, 59, 0.6)', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 12, padding: 20 }}>
          <h3 style={{ margin: '0 0 12px 0', fontSize: '1rem', color: '#10b981' }}>
            Current Fleet Breakdown in {city.name}
          </h3>
          <div style={{ display: 'flex', alignItems: 'center', height: 180 }}>
            <ResponsiveContainer width="55%" height="100%">
              <PieChart>
                <Pie data={mixShares} dataKey="value" nameKey="name" cx="50%" cy="50%" innerRadius={40} outerRadius={65} paddingAngle={4}>
                  {mixShares.map((entry, index) => (
                    <Cell key={`cell-${index}`} fill={entry.color} />
                  ))}
                </Pie>
                <Tooltip />
              </PieChart>
            </ResponsiveContainer>
            <div style={{ width: '45%', fontSize: '0.8rem', display: 'flex', flexDirection: 'column', gap: 6 }}>
              {mixShares.map(item => (
                <div key={item.name} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <span style={{ width: 10, height: 10, borderRadius: '50%', background: item.color, display: 'inline-block' }} />
                  <span style={{ color: '#cbd5e1' }}>{item.icon} {item.value}%</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>

      {/* Fuel & Delay Impact Highlights */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 16, marginBottom: 24 }}>
        <div style={{ background: 'rgba(15, 23, 42, 0.7)', border: '1px solid rgba(16, 185, 129, 0.2)', borderRadius: 10, padding: 18 }}>
          <div style={{ fontSize: '0.78rem', color: '#94a3b8', textTransform: 'uppercase' }}>Daily Fuel Saved</div>
          <div style={{ fontSize: '1.6rem', fontWeight: 700, color: '#10b981', marginTop: 4, display: 'flex', alignItems: 'center', gap: 8 }}>
            <Fuel size={20} /> {fuelSavedPerDayLiters.toLocaleString()} Liters / day
          </div>
          <div style={{ fontSize: '0.78rem', color: '#64748b', marginTop: 4 }}>Across major corridor signals in {city.name}</div>
        </div>

        <div style={{ background: 'rgba(15, 23, 42, 0.7)', border: '1px solid rgba(56, 189, 248, 0.2)', borderRadius: 10, padding: 18 }}>
          <div style={{ fontSize: '0.78rem', color: '#94a3b8', textTransform: 'uppercase' }}>Average Delay Reduction</div>
          <div style={{ fontSize: '1.6rem', fontWeight: 700, color: '#38bdf8', marginTop: 4 }}>
            -{Math.round(((comparisonData[0].fixed - comparisonData[0].swarm) / comparisonData[0].fixed) * 100)}% Time Saved
          </div>
          <div style={{ fontSize: '0.78rem', color: '#64748b', marginTop: 4 }}>Continuous green wave pass-through</div>
        </div>

        <div style={{ background: 'rgba(15, 23, 42, 0.7)', border: '1px solid rgba(168, 85, 247, 0.2)', borderRadius: 10, padding: 18 }}>
          <div style={{ fontSize: '0.78rem', color: '#94a3b8', textTransform: 'uppercase' }}>Idling CO2 Cut</div>
          <div style={{ fontSize: '1.6rem', fontWeight: 700, color: '#a855f7', marginTop: 4 }}>
            {(fuelSavedPerDayLiters * 2.31 / 1000).toFixed(1)} Tons / day
          </div>
          <div style={{ fontSize: '0.78rem', color: '#64748b', marginTop: 4 }}>Eliminating stop-and-go acceleration</div>
        </div>
      </div>

      {/* Comparison Graph */}
      <div style={{
        background: 'rgba(15, 23, 42, 0.8)',
        border: '1px solid rgba(255,255,255,0.08)',
        borderRadius: 12,
        padding: 24,
        marginBottom: 24
      }}>
        <h3 style={{ margin: '0 0 16px 0', fontSize: '1.1rem', color: '#f1f5f9' }}>
          Fixed Signal Timer vs. Swarm Multi-Agent in Mixed Indian Conditions
        </h3>
        <div style={{ height: 280, width: '100%' }}>
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={comparisonData} margin={{ top: 10, right: 30, left: 0, bottom: 0 }}>
              <CartesianGrid stroke="rgba(255,255,255,0.06)" />
              <XAxis dataKey="metric" stroke="#64748b" fontSize={12} />
              <YAxis stroke="#64748b" fontSize={12} />
              <Tooltip
                contentStyle={{
                  background: '#0f172a',
                  border: '1px solid rgba(255,255,255,0.1)',
                  borderRadius: 8,
                  fontSize: '0.85rem',
                  color: '#f8fafc'
                }}
              />
              <Legend wrapperStyle={{ paddingTop: 10, fontSize: '0.85rem' }} />
              <Bar dataKey="fixed" name="Fixed Timer (Traditional Signal)" fill="#ef4444" radius={[4, 4, 0, 0]} />
              <Bar dataKey="swarm" name="Swarm Intelligence (Dynamic Continuous Flow)" fill="#10b981" radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </div>
    </div>
  );
}
