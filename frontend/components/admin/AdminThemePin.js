'use client';

import { useLayoutEffect } from 'react';

// Covers everything outside .admin-root when arriving by in-app navigation. Public pages restore their theme on mount.
export default function AdminThemePin() {
  useLayoutEffect(() => {
    document.documentElement.setAttribute('data-theme', 'midnight');
  }, []);
  return null;
}
