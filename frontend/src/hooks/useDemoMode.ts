import { useDemoStore } from '@/store/demoStore';

export function useDemoMode(): boolean {
  return useDemoStore((state) => state.isDemoMode);
}
