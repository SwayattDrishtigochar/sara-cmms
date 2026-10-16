import { create } from 'zustand';

const load = (key, fallback) => {
  try {
    const v = localStorage.getItem(key);
    return v == null ? fallback : JSON.parse(v);
  } catch {
    return fallback;
  }
};
const save = (key, value) => {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // not persisted
  }
};

/** Shell UI state; persisted bits are per-browser conveniences only. */
export const useUi = create((set) => ({
  collapsed: load('ui.collapsed', false),
  mobileNav: false,
  plantId: load('ui.plantId', null),
  toggleCollapsed: () =>
    set((s) => {
      save('ui.collapsed', !s.collapsed);
      return { collapsed: !s.collapsed };
    }),
  setMobileNav: (mobileNav) => set({ mobileNav }),
  setPlantId: (plantId) => {
    save('ui.plantId', plantId);
    set({ plantId });
  },
}));
