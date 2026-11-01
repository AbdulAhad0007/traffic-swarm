// The Overview centrepiece: an illustration of a green wave crossing nine junctions. It shows no measured data.
const XS = [60, 200, 340];
const YS = [50, 130, 210];
const JUNCTIONS = YS.flatMap((y, row) => XS.map((x, col) => ({ id: `J${row * 3 + col + 1}`, x, y })));
const WAVE = [[60, 210], [200, 210], [200, 130], [340, 130], [340, 50]];
const WAVE_D = `M${WAVE.map(p => p.join(' ')).join('L')}`;
const onWave = j => WAVE.some(([x, y]) => x === j.x && y === j.y);
const delayOf = j => WAVE.findIndex(([x, y]) => x === j.x && y === j.y) * 0.45;

export default function JunctionMesh() {
  return (
    <figure className="junction-mesh">
      <svg viewBox="0 0 400 260" role="img" aria-label="Nine junctions in a grid, with a green wave clearing a path across five of them">
        <g className="mesh-roads">
          {XS.map(x => <line key={x} x1={x} y1={16} x2={x} y2={244} />)}
          {YS.map(y => <line key={y} x1={20} y1={y} x2={380} y2={y} />)}
        </g>
        <path className="mesh-wave" d={WAVE_D} pathLength="100" />
        {JUNCTIONS.map(j => (
          <g key={j.id} className={onWave(j) ? 'mesh-node lit' : 'mesh-node'} style={onWave(j) ? { animationDelay: `${delayOf(j)}s` } : undefined}>
            <circle cx={j.x} cy={j.y} r="11" />
            <text x={j.x} y={j.y + 3.5} textAnchor="middle">{j.id}</text>
          </g>
        ))}
      </svg>
      <figcaption>Illustration of junctions passing a green wave along a corridor.</figcaption>
    </figure>
  );
}
