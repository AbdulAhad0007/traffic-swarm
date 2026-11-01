import { Lock } from 'lucide-react';

export default function ModuleUnavailable() {
  return (
    <section className="panel module-unavailable">
      <Lock size={26} color="#38bdf8" />
      <h2>This module is currently unavailable</h2>
      <p className="muted">It has been turned off by the administrator. Please choose another module from the navigation.</p>
    </section>
  );
}
