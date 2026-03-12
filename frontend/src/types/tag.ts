export interface Tag {
  id: string;
  userId: string;
  name: string;
  color: string | null;
  icon: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateTagData {
  name: string;
  color?: string;
  icon?: string;
}

export interface UpdateTagData extends Partial<CreateTagData> {}
