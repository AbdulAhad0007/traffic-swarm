import Results from '@/components/Results';

export const metadata = {
  title: 'Controller Comparison — Traffic Swarm Intelligence',
  description: 'Multi-seed evaluation reports and controller comparison with statistical analysis',
};

export default function ControllersPage() {
  return <Results view="controllers" />;
}
