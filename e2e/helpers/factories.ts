import { ApiClient, uniqueId } from './api';

// Typed factories that seed data through the real backend API. Payload shapes
// mirror the frontend lib modules (e.g. frontend/src/lib/tags.ts). Each returns
// the created record (with id) so specs can reference it. New entities are
// added here as their specs are written.

export interface CreatedTag {
  id: string;
  name: string;
  color: string | null;
  icon: string | null;
}

export function createTag(
  api: ApiClient,
  data: { name?: string; color?: string; icon?: string } = {},
): Promise<CreatedTag> {
  return api.post<CreatedTag>('/tags', {
    name: data.name ?? `E2E Tag ${uniqueId()}`,
    ...(data.color !== undefined ? { color: data.color } : {}),
    ...(data.icon !== undefined ? { icon: data.icon } : {}),
  });
}
