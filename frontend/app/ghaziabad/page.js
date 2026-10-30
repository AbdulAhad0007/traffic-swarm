import OsmSignalMap from '@/components/OsmSignalMap';

export const metadata = {
  title: 'Real-World Signal Map — Traffic Swarm Intelligence',
  description: 'Traffic signals for any place in the world, read live from OpenStreetMap, linked by real roads and controlled by the swarm JunctionAgent mesh.',
};

export default function SignalMapPage() {
  return <OsmSignalMap />;
}
