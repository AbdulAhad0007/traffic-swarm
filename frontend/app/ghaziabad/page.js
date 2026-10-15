import GhaziabadLiveMap from '@/components/GhaziabadLiveMap';

export const metadata = {
  title: 'Ghaziabad Live Digital Twin — Traffic Swarm Intelligence',
  description: 'Real-time interactive OpenStreetMap traffic monitoring and Swarm PSO+ACO optimization across Ghaziabad, UP (Mohan Nagar, Raj Nagar Extension, NH-9).',
};

export default function GhaziabadPage() {
  return <GhaziabadLiveMap />;
}
