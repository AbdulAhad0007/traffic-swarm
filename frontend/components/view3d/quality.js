// Adaptive quality from measured frame rate. No Cesium or React here.
export const QUALITY = {
  high: { label: 'High', resolution: 'device', msaa: 4, maxVehicles: Infinity, nearModels: 40, atmosphere: true, labels: true, heat: true },
  medium: { label: 'Medium', resolution: 1, msaa: 1, maxVehicles: Infinity, nearModels: 0, atmosphere: false, labels: true, heat: true },
  low: { label: 'Low', resolution: 0.75, msaa: 1, maxVehicles: 1500, nearModels: 0, atmosphere: false, labels: false, heat: false },
};
const ORDER = ['low', 'medium', 'high'];
const DROP_BELOW_FPS = 35, RAISE_ABOVE_FPS = 55;
const DROP_AFTER_S = 3, RAISE_AFTER_S = 20;

export class QualityController {
  constructor(start = 'high') {
    this.level = start;
    this.slow = 0;
    this.fast = 0;
    this.ceiling = 'high';
  }

  // Call about once a second with the measured FPS while the scene is actively rendering.
  // Returns the new level when it changes. A level that failed is not retried, which stops flip-flopping.
  observe(fps, seconds) {
    const at = ORDER.indexOf(this.level);
    if (fps < DROP_BELOW_FPS) { this.slow += seconds; this.fast = 0; }
    else if (fps >= RAISE_ABOVE_FPS) { this.fast += seconds; this.slow = 0; }
    else { this.slow = 0; this.fast = 0; }
    if (this.slow >= DROP_AFTER_S && at > 0) {
      this.ceiling = this.level === 'high' ? 'medium' : this.ceiling;
      this.level = ORDER[at - 1];
      this.slow = 0;
      return this.level;
    }
    if (this.fast >= RAISE_AFTER_S && at < ORDER.indexOf(this.ceiling)) {
      this.level = ORDER[at + 1];
      this.fast = 0;
      return this.level;
    }
    return null;
  }
}
