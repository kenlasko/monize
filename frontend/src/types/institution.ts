export interface Institution {
  id: string;
  userId: string;
  name: string;
  website: string;
  country: string | null;
  hasLogo: boolean;
  logoFetchedAt: string | null;
  createdAt: string;
  updatedAt: string;
  accountCount: number;
}

export interface CreateInstitutionData {
  name: string;
  website: string;
  country?: string;
}

export type UpdateInstitutionData = Partial<CreateInstitutionData>;
