import { useEffect, useState } from 'react';

const media = () => window.matchMedia('(prefers-color-scheme: dark)');
const read = () => {
  try {
    return localStorage.getItem('theme') ?? 'system';
  } catch {
    return 'system';
  }
};

const apply = (mode) => {
  const dark = mode === 'dark' || (mode === 'system' && media().matches);
  document.documentElement.classList.toggle('dark', dark);
};

/** Theme preference: 'light' | 'dark' | 'system' (default, follows the OS). */
export const useTheme = () => {
  const [mode, setMode] = useState(read);
  useEffect(() => {
    apply(mode);
    try {
      if (mode === 'system') localStorage.removeItem('theme');
      else localStorage.setItem('theme', mode);
    } catch {
      // not persisted
    }
    if (mode !== 'system') return;
    const query = media();
    const onChange = () => apply('system');
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  }, [mode]);
  return [mode, setMode];
};
