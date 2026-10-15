import Results from '@/components/Results';

export const metadata = {
  title: 'Prediction — Traffic Swarm Intelligence',
  description: 'Short-term traffic prediction evaluation with baseline and learned models',
};

export default function PredictionPage() {
  return <Results view="prediction" />;
}
