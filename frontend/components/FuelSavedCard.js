'use client';

import React from 'react';
import { Fuel, Leaf, IndianRupee, Gauge, TrendingDown, TrendingUp, Hourglass } from 'lucide-react';
import { fmt } from '@/lib/api';

// Gasoline density ~ 0.74 kg/L (740,000 mg/L)
const DENSITY_MG_PER_LITER = 740000;
// Standard Indian Metro Fuel Price (Delhi-NCR ~ ₹96.72/L)
const INR_PER_LITER = 96.72;

/**
 * FuelSavedCard: fuel, CO₂ and cost difference between two measured SUMO runs on identical demand.
 * Only measured values are shown: without both fuel totals the card says the result is pending, and
 * when the compared controller burns more fuel than the reference the card says so.
 *
 * @param {number} props.baselineFuelMg - fuel of the reference controller (mg, SUMO emission model)
 * @param {number} props.swarmFuelMg - fuel of the compared controller (mg)
 * @param {number} props.baselineCo2Mg - CO₂ of the reference controller (mg)
 * @param {number} props.swarmCo2Mg - CO₂ of the compared controller (mg)
 * @param {string} props.baselineLabel - name of the reference controller
 * @param {string} props.compareLabel - name of the compared controller
 * @param {string} props.pendingText - shown while the measured totals are not available
 */
export default function FuelSavedCard({
  baselineFuelMg,
  swarmFuelMg,
  baselineCo2Mg,
  swarmCo2Mg,
  baselineLabel = 'Fixed-time',
  compareLabel = 'Swarm',
  title = 'Eco & Energy Savings via Swarm Intelligence',
  pendingText = 'Measured fuel and CO₂ appear once both runs have finished.',
  compact = false,
}) {
  const measured = baselineFuelMg != null && swarmFuelMg != null && baselineFuelMg > 0;

  if (!measured) {
    return compact ? (
      <div className="fuel-saved-compact"><div className="fuel-header"><Fuel size={16} color="#64748b" /><b>Fuel:</b><span className="muted">pending</span></div></div>
    ) : (
      <div className="fuel-saved-card pending">
        <div className="fuel-card-header">
          <div className="fuel-title-group">
            <div className="fuel-icon-wrap"><Hourglass size={20} color="#64748b" /></div>
            <div>
              <h4 className="fuel-card-title">{title}</h4>
              <p className="fuel-card-sub">{pendingText}</p>
            </div>
          </div>
        </div>
      </div>
    );
  }

  // Positive = the compared controller used less than the reference
  const fuelDiffMg = baselineFuelMg - swarmFuelMg;
  const fuelPct = (fuelDiffMg / baselineFuelMg) * 100;
  const liters = fuelDiffMg / DENSITY_MG_PER_LITER;
  const inr = liters * INR_PER_LITER;
  const hasCo2 = baselineCo2Mg != null && swarmCo2Mg != null && baselineCo2Mg > 0;
  const co2Kg = hasCo2 ? (baselineCo2Mg - swarmCo2Mg) / 1e6 : liters * 2.31; // ~2.31 kg CO₂ per litre burned
  const co2Pct = hasCo2 ? ((baselineCo2Mg - swarmCo2Mg) / baselineCo2Mg) * 100 : fuelPct;
  const saves = fuelDiffMg >= 0;
  const Trend = saves ? TrendingDown : TrendingUp;
  const tone = saves ? '#10b981' : '#f43f5e';
  const burnPct = (swarmFuelMg / baselineFuelMg) * 100;

  if (compact) {
    return (
      <div className="fuel-saved-compact">
        <div className="fuel-header">
          <Fuel size={16} color={tone} />
          <b>{saves ? 'Fuel saved:' : 'Extra fuel:'}</b>
          <span className="fuel-badge" style={saves ? undefined : { color: tone }}>
            {saves ? '-' : '+'}{fmt(Math.abs(fuelPct), 1)}% ({fmt(Math.abs(liters), 2)} L)
          </span>
          <span className="inr-saved">≈ ₹{fmt(Math.abs(inr), 0)} {saves ? 'saved' : 'extra'}</span>
        </div>
      </div>
    );
  }

  return (
    <div className="fuel-saved-card">
      <div className="fuel-card-header">
        <div className="fuel-title-group">
          <div className="fuel-icon-wrap">
            <Fuel size={20} color={tone} />
          </div>
          <div>
            <h4 className="fuel-card-title">
              {title}
              <span className="live-eco-pill">MEASURED · SUMO</span>
            </h4>
            <p className="fuel-card-sub">
              {compareLabel} vs {baselineLabel} on identical vehicles, from SUMO&apos;s emission model.
              {!saves && ` In this run ${compareLabel} burned more fuel than ${baselineLabel}.`}
            </p>
          </div>
        </div>

        <div className="fuel-primary-stat">
          <span className="fuel-stat-label">{saves ? 'FUEL REDUCTION' : 'FUEL INCREASE'}</span>
          <div className="fuel-stat-value" style={{ color: tone }}>
            <Trend size={22} color={tone} />
            <span>{fmt(Math.abs(fuelPct), 1)}%</span>
          </div>
        </div>
      </div>

      <div className="fuel-metrics-grid">
        <div className="fuel-metric-box">
          <div className="metric-box-top">
            <Fuel size={16} color={tone} />
            <span>{saves ? 'FUEL SAVED' : 'EXTRA FUEL'}</span>
          </div>
          <div className="metric-box-num" style={{ color: tone }}>
            {fmt(Math.abs(liters), 2)} <span className="unit">Liters</span>
          </div>
          <span className="metric-box-footer">Whole network, whole run</span>
        </div>

        <div className="fuel-metric-box">
          <div className="metric-box-top">
            <Leaf size={16} color="#38bdf8" />
            <span>{co2Kg >= 0 ? 'CO₂ PREVENTED' : 'EXTRA CO₂'}</span>
          </div>
          <div className="metric-box-num text-cyan">
            {fmt(Math.abs(co2Kg), 2)} <span className="unit">kg CO₂</span>
          </div>
          <span className="metric-box-footer">
            {co2Pct >= 0 ? '-' : '+'}{fmt(Math.abs(co2Pct), 1)}% {hasCo2 ? 'measured' : 'estimated from fuel'}
          </span>
        </div>

        <div className="fuel-metric-box">
          <div className="metric-box-top">
            <IndianRupee size={16} color="#f59e0b" />
            <span>{saves ? 'COST SAVED' : 'EXTRA COST'}</span>
          </div>
          <div className="metric-box-num text-amber">
            ₹{fmt(Math.abs(inr), 0)} <span className="unit">INR</span>
          </div>
          <span className="metric-box-footer">At ₹{INR_PER_LITER}/L (Delhi-NCR petrol)</span>
        </div>

        <div className="fuel-metric-box">
          <div className="metric-box-top">
            <Gauge size={16} color="#a78bfa" />
            <span>FUEL BURNT</span>
          </div>
          <div className="metric-box-num text-purple">
            {fmt(swarmFuelMg / DENSITY_MG_PER_LITER, 1)} <span className="unit">L vs {fmt(baselineFuelMg / DENSITY_MG_PER_LITER, 1)} L</span>
          </div>
          <span className="metric-box-footer">{compareLabel} vs {baselineLabel}</span>
        </div>
      </div>

      <div className="fuel-comparison-bar">
        <div className="comparison-bar-labels">
          <span>{baselineLabel}: <b>100%</b> fuel burn</span>
          <span style={{ color: tone }}>{compareLabel}: <b>{fmt(burnPct, 1)}%</b> fuel burn</span>
        </div>
        <div className="comparison-track">
          <div className="comparison-fill" style={{ width: `${Math.max(5, Math.min(100, burnPct))}%`, background: saves ? undefined : tone }} />
        </div>
      </div>
    </div>
  );
}
