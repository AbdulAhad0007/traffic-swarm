import LiveCameraLoader from '@/components/camera/LiveCameraLoader';

export const metadata = {
  title: 'Live Camera — Traffic Swarm Intelligence',
  description: 'CCTV ingestion, vehicle detection, traffic analytics and validated signal proposals',
};

export default function LiveCameraPage() {
  return <LiveCameraLoader />;
}
