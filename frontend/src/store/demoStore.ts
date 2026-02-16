import { create } from 'zustand';

interface DemoState {
  isDemoMode: boolean;
  setDemoMode: (value: boolean) => void;
}

export const useDemoStore = create<DemoState>()((set) => ({
  isDemoMode: false,
  setDemoMode: (value) => set({ isDemoMode: value }),
}));
